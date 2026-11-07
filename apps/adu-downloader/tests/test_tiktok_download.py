"""Tests for the TikTok download path: resolve via proxy, download direct.

The split is the point: the aria2c call must carry no proxy argument and
run with proxy variables stripped from its environment, even when the
ambient environment has them set. A regression that passes the resolve
proxy to any download tool must fail these tests.
"""

import os
import shutil

import pytest

import tiktok_download
from tiktok_download import TikTokDownloadFailure, direct_env, download_tiktok_reel
from tiktok_resolve import DownloadFailure, ResolveSuccess

VIDEO_URL = "https://www.tiktok.com/@someone/video/1234567890123456789"
RESOLVE_URL = "https://cdn.example/v.mp4"


class FakeCompleted:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class FakeRunner:
    """Fake subprocess.run: aria2c writes a file, ffprobe reports audio."""

    def __init__(self, *, aria2_size=20000, aria2_exit=0, write_file=True, ffprobe_audio=True):
        self.aria2_size = aria2_size
        self.aria2_exit = aria2_exit
        self.write_file = write_file
        self.ffprobe_audio = ffprobe_audio
        self.calls = []

    def __call__(self, args, **kwargs):
        self.calls.append((list(args), kwargs))
        if args[0] == "aria2c":
            if self.write_file:
                out_name = args[args.index("-o") + 1]
                out_dir = args[args.index("-d") + 1]
                path = os.path.join(out_dir, out_name)
                with open(path, "wb") as f:
                    f.write(b"x" * self.aria2_size)
            return FakeCompleted(returncode=self.aria2_exit, stderr="")
        if args[0] == "ffprobe":
            return FakeCompleted(
                returncode=0, stdout="audio" if self.ffprobe_audio else ""
            )
        raise AssertionError(f"unexpected command: {args[0]}")


@pytest.fixture()
def runner(monkeypatch):
    fake = FakeRunner()
    monkeypatch.setattr(tiktok_download.subprocess, "run", fake)
    return fake


@pytest.fixture()
def resolve_ok(monkeypatch):
    monkeypatch.setattr(
        tiktok_download,
        "resolve_tiktok_stream",
        lambda url, opener, pacer: ResolveSuccess(RESOLVE_URL, "a caption", "tikwm"),
    )


def _download(monkeypatch):
    # Ambient proxy vars must NOT leak into the download path.
    monkeypatch.setenv("http_proxy", "http://proxy.example:8080")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:8080")
    return download_tiktok_reel(
        VIDEO_URL, reel_external_id="1234567890123456789", opener=None, pacer=None
    )


def test_success_downloads_direct_with_no_proxy(runner, resolve_ok, monkeypatch):
    path, caption = _download(monkeypatch)
    try:
        assert caption == "a caption"
        assert os.path.getsize(path) == 20000
    finally:
        shutil.rmtree(os.path.dirname(path), ignore_errors=True)
    aria2_calls = [c for c in runner.calls if c[0][0] == "aria2c"]
    assert len(aria2_calls) == 1
    argv, kwargs = aria2_calls[0]
    assert "--proxy" not in argv
    assert not any("proxy.example" in a for a in argv)
    assert RESOLVE_URL in argv
    env = kwargs["env"]
    assert "http_proxy" not in env and "https_proxy" not in env
    assert "HTTP_PROXY" not in env and "HTTPS_PROXY" not in env


def test_direct_env_strips_proxy_vars(monkeypatch):
    monkeypatch.setenv("http_proxy", "http://proxy.example:8080")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:8080")
    monkeypatch.setenv("NO_PROXY", "localhost")
    env = direct_env()
    assert "http_proxy" not in env and "HTTPS_PROXY" not in env
    assert env["NO_PROXY"] == "localhost"


def test_resolve_failure_propagates_structured(runner, monkeypatch):
    failure = DownloadFailure(
        "tikwm_resolve",
        "tikwm_api_body_code",
        detail="body_code=-1",
        fallback=DownloadFailure("countik_resolve", "countik_api_timeout", detail="step=exist"),
    )
    monkeypatch.setattr(
        tiktok_download, "resolve_tiktok_stream", lambda url, opener, pacer: failure
    )
    with pytest.raises(TikTokDownloadFailure) as excinfo:
        download_tiktok_reel(VIDEO_URL, reel_external_id="1", opener=None, pacer=None)
    assert excinfo.value.failure is failure
    assert not [c for c in runner.calls if c[0][0] == "aria2c"]


def test_aria2c_failure_is_stream_open(runner, resolve_ok, monkeypatch):
    runner.aria2_exit = 1
    with pytest.raises(TikTokDownloadFailure) as excinfo:
        _download(monkeypatch)
    assert excinfo.value.failure.stage == "stream_open"
    assert excinfo.value.failure.reason == "stream_fetch_error"
    # Detail names resolver + host, never the full stream URL.
    assert "resolver=tikwm" in excinfo.value.failure.detail
    assert "cdn.example" in excinfo.value.failure.detail
    assert RESOLVE_URL not in excinfo.value.failure.detail


def test_missing_file_after_aria2c_is_no_body(runner, resolve_ok, monkeypatch):
    runner.write_file = False
    with pytest.raises(TikTokDownloadFailure) as excinfo:
        _download(monkeypatch)
    assert (excinfo.value.failure.stage, excinfo.value.failure.reason) == (
        "stream_open",
        "stream_no_body",
    )


def test_too_small_file_is_rejected(runner, resolve_ok, monkeypatch):
    runner.aria2_size = 100
    with pytest.raises(TikTokDownloadFailure) as excinfo:
        _download(monkeypatch)
    assert (excinfo.value.failure.stage, excinfo.value.failure.reason) == (
        "size_check",
        "too_small",
    )
    assert excinfo.value.failure.detail == "size_bytes=100"


def test_too_large_file_is_rejected(runner, resolve_ok, monkeypatch):
    monkeypatch.setattr(tiktok_download, "MIN_FILE_BYTES", 10)
    monkeypatch.setattr(tiktok_download, "MAX_FILE_BYTES", 1000)
    runner.aria2_size = 2000
    with pytest.raises(TikTokDownloadFailure) as excinfo:
        _download(monkeypatch)
    assert (excinfo.value.failure.stage, excinfo.value.failure.reason) == (
        "stream_upload",
        "file_too_large",
    )


def test_no_audio_is_rejected(runner, resolve_ok, monkeypatch):
    runner.ffprobe_audio = False
    with pytest.raises(TikTokDownloadFailure) as excinfo:
        _download(monkeypatch)
    assert (excinfo.value.failure.stage, excinfo.value.failure.reason) == (
        "audio_check",
        "no_audio",
    )
