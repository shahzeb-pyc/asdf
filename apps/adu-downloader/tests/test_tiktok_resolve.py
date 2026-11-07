"""Tests for the TikTok resolvers (tikwm + Countik via the resolve proxy).

The opener is injected, so no network is touched: a fake opener answers
with canned JSON (or raises like urllib does). The tests pin the
Worker's exact failure vocabulary, because the live checks read these
stage/reason values off the reel rows.
"""

import json
import urllib.error
import urllib.parse

import pytest

from resolve_pacing import ResolvePacer
from tiktok_resolve import (
    COUNTIK_API_BASE_URL,
    TIKWM_API_URL,
    DownloadFailure,
    ResolveSuccess,
    build_resolve_opener,
    failure_record,
    resolve_countik_stream,
    resolve_tiktok_stream,
    resolve_tikwm_stream,
)

VIDEO_URL = "https://www.tiktok.com/@someone/video/1234567890123456789"


class FakeResponse:
    def __init__(self, status, body_bytes):
        self.status = status
        self._body = body_bytes

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeOpener:
    """Records every request; answers via the handler (or raises)."""

    def __init__(self, handler):
        self.handler = handler
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append((request, timeout))
        return self.handler(request)


def _json_response(payload, status=200):
    return FakeResponse(status, json.dumps(payload).encode())


def _http_error(url, code):
    return urllib.error.HTTPError(url, code, "error", {}, None)


class NoSleepPacer(ResolvePacer):
    """Pacer that never waits (tests drive resolve logic, not pacing)."""

    def __init__(self):
        super().__init__(0, 0, clock=lambda: 0.0, sleep=lambda s: None)


@pytest.fixture()
def pacer():
    return NoSleepPacer()


def _tikwm_ok_handler(stream_url="https://cdn.example/v.mp4", title="a caption"):
    def handler(request):
        assert request.full_url == TIKWM_API_URL
        assert request.get_method() == "POST"
        fields = urllib.parse.parse_qs(request.data.decode())
        assert fields["url"] == [VIDEO_URL]
        assert fields["hd"] == ["1"]
        return _json_response(
            {"code": 0, "data": {"hdplay": stream_url, "play": "https://cdn.example/p.mp4", "title": title}}
        )

    return handler


def test_tikwm_success_prefers_hdplay_and_returns_title(pacer):
    opener = FakeOpener(_tikwm_ok_handler())
    result = resolve_tikwm_stream(VIDEO_URL, opener, pacer)
    assert result == ResolveSuccess("https://cdn.example/v.mp4", "a caption", "tikwm")
    assert len(opener.requests) == 1


def test_tikwm_success_falls_back_to_play_and_null_title(pacer):
    def handler(request):
        return _json_response({"code": 0, "data": {"play": "/v.mp4"}})

    result = resolve_tikwm_stream(VIDEO_URL, FakeOpener(handler), pacer)
    assert result == ResolveSuccess("https://www.tikwm.com/v.mp4", None, "tikwm")


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"code": -1, "data": {}}, DownloadFailure("tikwm_resolve", "tikwm_api_body_code", detail="body_code=-1")),
        ({"code": 0}, DownloadFailure("tikwm_resolve", "tikwm_api_no_data")),
        ({"code": 0, "data": {}}, DownloadFailure("tikwm_resolve", "tikwm_no_stream_url")),
        ({"code": 0, "data": None}, DownloadFailure("tikwm_resolve", "tikwm_api_no_data")),
        ('"just a string"', DownloadFailure("tikwm_resolve", "tikwm_api_bad_body")),
    ],
)
def test_tikwm_body_failures(pacer, payload, expected):
    def handler(request):
        if isinstance(payload, str):
            return FakeResponse(200, payload.encode())
        return _json_response(payload)

    assert resolve_tikwm_stream(VIDEO_URL, FakeOpener(handler), pacer) == expected


def test_tikwm_http_status_and_timeout(pacer):
    opener = FakeOpener(lambda r: (_ for _ in ()).throw(_http_error(TIKWM_API_URL, 500)))
    assert resolve_tikwm_stream(VIDEO_URL, opener, pacer) == DownloadFailure(
        "tikwm_resolve", "tikwm_api_http_status", detail="http_status=500"
    )

    def timeout_handler(request):
        raise TimeoutError("timed out")

    assert resolve_tikwm_stream(VIDEO_URL, FakeOpener(timeout_handler), pacer) == DownloadFailure(
        "tikwm_resolve", "tikwm_api_timeout"
    )


def test_tikwm_unparsable_body(pacer):
    opener = FakeOpener(lambda r: FakeResponse(200, b"{not json"))
    assert resolve_tikwm_stream(VIDEO_URL, opener, pacer) == DownloadFailure(
        "tikwm_resolve", "tikwm_api_body_unparsable"
    )


def _countik_ok_handler():
    def handler(request):
        if request.full_url == f"{COUNTIK_API_BASE_URL}/video/exist":
            assert request.get_method() == "POST"
            return _json_response({"data": {"video_id": "vid123"}})
        assert request.full_url == f"{COUNTIK_API_BASE_URL}/videoinfo/vid123"
        assert request.get_method() == "GET"
        return _json_response({"data": {"download_link": "https://cdn.example/c.mp4", "desc": "countik caption"}})

    return handler


def test_countik_success(pacer):
    opener = FakeOpener(_countik_ok_handler())
    result = resolve_countik_stream(VIDEO_URL, opener, pacer)
    assert result == ResolveSuccess("https://cdn.example/c.mp4", "countik caption", "countik")
    assert len(opener.requests) == 2


def test_countik_no_video_id(pacer):
    def handler(request):
        return _json_response({"data": {}})

    assert resolve_countik_stream(VIDEO_URL, FakeOpener(handler), pacer) == DownloadFailure(
        "countik_resolve", "countik_no_video_id", detail="step=exist"
    )


def test_countik_429_arms_backoff(pacer):
    calls = {"backoff": 0}
    pacer.note_rate_limited = lambda: calls.__setitem__("backoff", calls["backoff"] + 1)

    def handler(request):
        raise _http_error(request.full_url, 429)

    result = resolve_countik_stream(VIDEO_URL, FakeOpener(handler), pacer)
    assert result == DownloadFailure(
        "countik_resolve", "countik_api_http_status", detail="step=exist; http_status=429"
    )
    assert calls["backoff"] == 1


def test_combined_tikwm_success_never_touches_countik(pacer):
    opener = FakeOpener(_tikwm_ok_handler())
    result = resolve_tiktok_stream(VIDEO_URL, opener, pacer)
    assert isinstance(result, ResolveSuccess) and result.resolver == "tikwm"
    assert len(opener.requests) == 1


def test_combined_both_fail_carries_both_attempts(pacer):
    def handler(request):
        if request.full_url == TIKWM_API_URL:
            return _json_response({"code": -1, "data": {}})
        raise _http_error(request.full_url, 429)

    result = resolve_tiktok_stream(VIDEO_URL, FakeOpener(handler), pacer)
    assert result == DownloadFailure(
        "tikwm_resolve",
        "tikwm_api_body_code",
        detail="body_code=-1",
        fallback=DownloadFailure(
            "countik_resolve",
            "countik_api_http_status",
            detail="step=exist; http_status=429",
        ),
    )


def test_failure_record_shape_matches_worker(pacer):
    failure = DownloadFailure(
        "tikwm_resolve",
        "tikwm_api_body_code",
        detail="body_code=-1",
        fallback=DownloadFailure(
            "countik_resolve", "countik_api_timeout", detail="step=exist"
        ),
    )
    record = failure_record(failure)
    assert record == {
        "stage": "tikwm_resolve",
        "reason": "tikwm_api_body_code",
        "detail": "body_code=-1",
        "fallback": {
            "stage": "countik_resolve",
            "reason": "countik_api_timeout",
            "detail": "step=exist",
        },
    }
    assert "at" not in record  # the caller (db) adds it


def test_build_resolve_opener_requires_a_proxy():
    with pytest.raises(RuntimeError, match="RESOLVE_PROXY_URL"):
        build_resolve_opener("")
