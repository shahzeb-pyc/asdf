"""Behavioural tests for the Video Download Api client (spec 157).

No network: the HTTP layer is stubbed at urllib's opener, so the real
submit/poll/fetch code paths run against canned responses. The key is
never real here — a placeholder string stands in for it.
"""

import io
import json
import logging
import urllib.error

import pytest

import video_download_api as vda
from video_download_api import (
    ApiDownloadResult,
    VideoDownloadApiConfigError,
    VideoDownloadApiError,
)

FAKE_KEY = "test-key-placeholder"


class _FakeResponse:
    def __init__(self, payload, headers=None):
        self._body = json.dumps(payload).encode("utf-8")
        self.headers = headers or {}

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeOpener:
    """Canned opener: each open() returns the next response (or raises).
    Once the list is exhausted the last response repeats, so a polling
    loop cannot run off the end of the canned responses."""

    def __init__(self, responses):
        self.calls = []
        self._responses = list(responses)
        self._last = self._responses[-1]

    def open(self, request, timeout=None):
        self.calls.append(request)
        item = self._responses.pop(0) if self._responses else self._last
        if isinstance(item, Exception):
            raise item
        payload, headers = item
        return _FakeResponse(payload, headers)


def _install_opener(monkeypatch, responses):
    opener = _FakeOpener(responses)
    monkeypatch.setattr("urllib.request.build_opener", lambda *args: opener)
    return opener


def _submit_payload(**overrides):
    payload = {
        "id": "job-123",
        "progress_url": "https://p.savenow.to/api/progress?id=job-123",
        "additional_info": {"title": "Submit Title", "channel": "Cloud Codes"},
        "extended_duration": {"final_price": 0.0002, "multiplier": 1},
    }
    payload.update(overrides)
    return payload


def _progress_payload(**overrides):
    payload = {
        "progress": 1000,
        "success": 1,
        "download_url": "https://bernice23.savenow.to/dl/job-123.mp4",
        "title": "Progress Title",
    }
    payload.update(overrides)
    return payload


def test_download_happy_path_uses_progress_title_and_cost(monkeypatch, tmp_path):
    _install_opener(
        monkeypatch,
        [
            (_submit_payload(), {"x-jojapi-credits-used": "4"}),
            (_progress_payload(), {}),
        ],
    )
    saved = {}

    def fake_fetch(url, out_path, **kwargs):
        saved["url"] = url
        saved["bytes"] = 1234
        return 1234

    monkeypatch.setattr(vda, "_fetch_file", fake_fetch)
    out_path = tmp_path / "out.mp4"
    result = vda.download_video(
        "https://www.youtube.com/shorts/Vc_dcGD-Gl0", FAKE_KEY, str(out_path)
    )
    assert isinstance(result, ApiDownloadResult)
    assert result.filepath == str(out_path)
    # Progress title wins over the submit additional_info title.
    assert result.title == "Progress Title"
    assert result.credits_used == 4
    assert result.final_price == 0.0002
    assert saved["url"] == "https://bernice23.savenow.to/dl/job-123.mp4"


def test_title_falls_back_to_submit_info(monkeypatch, tmp_path):
    _install_opener(
        monkeypatch,
        [
            (_submit_payload(), {}),
            (_progress_payload(title=None), {}),
        ],
    )
    monkeypatch.setattr(vda, "_fetch_file", lambda url, out, **kw: 10)
    result = vda.download_video("https://www.youtube.com/shorts/X", FAKE_KEY, str(tmp_path / "o.mp4"))
    assert result.title == "Submit Title"


def test_missing_key_raises_before_any_http_call(monkeypatch, tmp_path):
    _install_opener(monkeypatch, [Exception("must not be called")])
    with pytest.raises(VideoDownloadApiConfigError):
        vda.download_video("https://www.youtube.com/shorts/X", None, str(tmp_path / "o.mp4"))
    with pytest.raises(VideoDownloadApiConfigError):
        vda.download_video("https://www.youtube.com/shorts/X", "   ", str(tmp_path / "o.mp4"))


def test_no_job_id_raises_without_polling(monkeypatch, tmp_path):
    opener = _install_opener(monkeypatch, [({"success": False, "message": "bad url"}, {})])
    monkeypatch.setattr(vda, "_fetch_file", lambda url, out, **kw: 10)
    with pytest.raises(VideoDownloadApiError, match="no job id"):
        vda.download_video("https://www.youtube.com/shorts/X", FAKE_KEY, str(tmp_path / "o.mp4"))
    assert len(opener.calls) == 1


def test_terminal_job_failure_raises_with_api_message(monkeypatch, tmp_path):
    _install_opener(
        monkeypatch,
        [
            (_submit_payload(), {}),
            (_progress_payload(success=0, download_url="", text="conversion failed"), {}),
        ],
    )
    monkeypatch.setattr(vda, "_fetch_file", lambda url, out, **kw: 10)
    with pytest.raises(VideoDownloadApiError, match="conversion failed"):
        vda.download_video("https://www.youtube.com/shorts/X", FAKE_KEY, str(tmp_path / "o.mp4"))


def test_poll_timeout_raises(monkeypatch, tmp_path):
    _install_opener(
        monkeypatch,
        [(_submit_payload(), {}), ({"progress": 500}, {})],
    )
    monkeypatch.setattr(vda, "_fetch_file", lambda url, out, **kw: 10)
    with pytest.raises(VideoDownloadApiError, match="timed out"):
        vda.download_video(
            "https://www.youtube.com/shorts/X",
            FAKE_KEY,
            str(tmp_path / "o.mp4"),
            poll_interval=0,
            poll_timeout=0.05,
        )


def test_http_401_surfaces_error_code(monkeypatch, tmp_path):
    body = json.dumps(
        {"error_code": "invalid_api_key", "message": "This API key does not exist.", "success": False}
    ).encode("utf-8")
    error = urllib.error.HTTPError("https://p.savenow.to/ajax/download.php", 401, "Unauthorized", {}, io.BytesIO(body))
    _install_opener(monkeypatch, [error])
    monkeypatch.setattr(vda, "_fetch_file", lambda url, out, **kw: 10)
    with pytest.raises(VideoDownloadApiError) as excinfo:
        vda.download_video("https://www.youtube.com/shorts/X", FAKE_KEY, str(tmp_path / "o.mp4"))
    assert excinfo.value.error_code == "invalid_api_key"


def test_cost_fields_absent_is_tolerated(monkeypatch, tmp_path):
    payload = _submit_payload()
    del payload["extended_duration"]
    _install_opener(monkeypatch, [(payload, {}), (_progress_payload(), {})])
    monkeypatch.setattr(vda, "_fetch_file", lambda url, out, **kw: 10)
    result = vda.download_video("https://www.youtube.com/shorts/X", FAKE_KEY, str(tmp_path / "o.mp4"))
    assert result.credits_used is None
    assert result.final_price is None


def test_submit_url_is_never_logged(monkeypatch, tmp_path, caplog):
    _install_opener(
        monkeypatch,
        [
            (_submit_payload(), {"x-jojapi-credits-used": "4"}),
            (_progress_payload(), {}),
        ],
    )
    monkeypatch.setattr(vda, "_fetch_file", lambda url, out, **kw: 10)
    with caplog.at_level(logging.INFO, logger="adu-downloader"):
        vda.download_video("https://www.youtube.com/shorts/X", FAKE_KEY, str(tmp_path / "o.mp4"))
    assert not any("apikey=" in record.getMessage() for record in caplog.records)
    assert not any(FAKE_KEY in record.getMessage() for record in caplog.records)
