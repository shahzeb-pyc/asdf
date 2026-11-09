"""Behavioural tests for the YouTube download path (spec 157):
API first, direct yt-dlp fallback with no proxy, loud failure.

No network: the API client and the yt-dlp subprocess are stubbed, so
the real orchestration in media_download.py runs against canned
results. The proxy vars are set to hostile values first, so the
fallback test fails if it inherits any of them.
"""

import json
import os
from pathlib import Path

import pytest

import media_download
from caption_utils import DEFAULT_REEL_CAPTION
from media_download import download_reel_media
from video_download_api import (
    ApiDownloadResult,
    VideoDownloadApiConfigError,
    VideoDownloadApiError,
)

YOUTUBE_URL = "https://www.youtube.com/shorts/Vc_dcGD-Gl0"
PROXY_VARS = ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY")


@pytest.fixture(autouse=True)
def api_key(monkeypatch):
    monkeypatch.setattr(media_download, "YT_VIDEO_DOWNLOAD_API_KEY", "test-key-placeholder")
    return "test-key-placeholder"


@pytest.fixture(autouse=True)
def hostile_proxies(monkeypatch):
    # Ambient proxy variables set to hostile values: the fallback
    # must not inherit any of them (no --proxy arg, stripped env,
    # --ignore-config). RESIDENTIAL_PROXY no longer exists — the
    # YouTube yt-dlp path that consumed it was removed in spec 157.
    for var in PROXY_VARS:
        monkeypatch.setenv(var, "http://proxy.example:8080")


def _fake_api_success(monkeypatch, *, title="Real Title"):
    def fake_api(url, key, out_path, **kwargs):
        Path(out_path).write_bytes(b"fake-mp4")
        return ApiDownloadResult(
            filepath=out_path, title=title, credits_used=4, final_price=0.0002
        )

    monkeypatch.setattr(media_download, "download_video_via_api", fake_api)


def _fake_run_command_success(monkeypatch):
    """Stub run_command: records (args, env), creates the yt-dlp
    output file from the --output template, returns fake info JSON."""
    calls = []

    class _Result:
        def __init__(self, stdout):
            self.stdout = stdout

    def fake_run_command(args, *, env=None):
        calls.append((list(args), env))
        template = args[args.index("--output") + 1]
        assert "%(ext)s" in template
        out_path = template.replace("%(ext)s", "mp4")
        Path(out_path).write_bytes(b"fake-mp4")
        info = {
            "_filename": out_path,
            "description": "Fallback description",
            "title": "Fallback title",
        }
        return _Result(json.dumps(info))

    monkeypatch.setattr(media_download, "run_command", fake_run_command)
    return calls


def test_api_success_returns_api_file_and_title(monkeypatch, tmp_path):
    _fake_api_success(monkeypatch)
    path, caption = download_reel_media("youtube", YOUTUBE_URL)
    assert os.path.exists(path)
    assert Path(path).suffix == ".mp4"
    assert caption == "Real Title"


def test_api_failure_falls_back_to_ytdlp_with_no_proxy(monkeypatch):
    def fake_api(url, key, out_path, **kwargs):
        raise VideoDownloadApiError("boom")

    monkeypatch.setattr(media_download, "download_video_via_api", fake_api)
    calls = _fake_run_command_success(monkeypatch)
    path, caption = download_reel_media("youtube", YOUTUBE_URL)
    assert os.path.exists(path)
    assert caption == "Fallback description"
    assert len(calls) == 1
    args, env = calls[0]
    assert "--proxy" not in args
    assert not any("proxy.example" in str(arg) for arg in args)
    assert "--ignore-config" in args
    assert isinstance(env, dict)
    assert not any(var in env for var in PROXY_VARS)


def test_api_and_fallback_failure_raises_with_both_causes(monkeypatch):
    def fake_api(url, key, out_path, **kwargs):
        raise VideoDownloadApiError("api boom")

    monkeypatch.setattr(media_download, "download_video_via_api", fake_api)

    def fake_run_command(args, *, env=None):
        raise RuntimeError("ytdlp boom")

    monkeypatch.setattr(media_download, "run_command", fake_run_command)
    with pytest.raises(RuntimeError) as excinfo:
        download_reel_media("youtube", YOUTUBE_URL)
    assert "api boom" in str(excinfo.value)
    assert "ytdlp boom" in str(excinfo.value)


def test_missing_key_fails_loud_without_downloading(monkeypatch):
    monkeypatch.setattr(media_download, "YT_VIDEO_DOWNLOAD_API_KEY", None)

    def no_api(url, key, out_path, **kwargs):
        raise AssertionError("API must not be called without a key")

    def no_ytdlp(args, *, env=None):
        raise AssertionError("yt-dlp must not run without a key")

    monkeypatch.setattr(media_download, "download_video_via_api", no_api)
    monkeypatch.setattr(media_download, "run_command", no_ytdlp)
    with pytest.raises(VideoDownloadApiConfigError):
        download_reel_media("youtube", YOUTUBE_URL)


def test_api_success_without_title_uses_ytdlp_metadata(monkeypatch):
    _fake_api_success(monkeypatch, title=None)

    def fake_metadata(url, proxy, profile, *, env=None, extra_args=None):
        assert proxy is None
        assert env is not None and not any(var in env for var in PROXY_VARS)
        assert extra_args == ["--ignore-config"]
        return {"title": "Metadata Title", "description": ""}

    monkeypatch.setattr(media_download, "fetch_metadata", fake_metadata)
    path, caption = download_reel_media("youtube", YOUTUBE_URL)
    assert os.path.exists(path)
    assert caption == "Metadata Title"


def test_api_success_without_title_and_metadata_failure_keeps_file(monkeypatch):
    _fake_api_success(monkeypatch, title=None)

    def fake_metadata(url, proxy, profile, *, env=None, extra_args=None):
        raise RuntimeError("metadata boom")

    monkeypatch.setattr(media_download, "fetch_metadata", fake_metadata)
    path, caption = download_reel_media("youtube", YOUTUBE_URL)
    assert os.path.exists(path)
    assert caption == DEFAULT_REEL_CAPTION
