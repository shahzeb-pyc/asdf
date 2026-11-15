"""Behavioural tests for the Instagram download path (spec 194):
metadata via the resolve proxy, direct aria2 file fetch, loud failure.

No network: fetch_metadata and the aria2/ffmpeg subprocesses are
stubbed, so the real orchestration in media_download.py runs against
canned results. The proxy vars are set to hostile values first, so the
direct-fetch assertions fail if the aria2 call inherits any of them.
The proxy URLs below are fake placeholders, never real credentials —
RESOLVE_PROXY_URL is a server-side secret and is never present here.
A test that only asserts the file downloads without asserting which
proxy the metadata used does not count (spec 194).
"""

import os
import shutil

import pytest

import media_download
from media_download import download_reel_media

IG_URL = "https://www.instagram.com/reels/4t_iB-gAoKo/"
RESOLVE_PROXY = "http://resolve-proxy.example:8080"
DATACENTER_PROXY = "http://datacenter-proxy.example:8080"
PROXY_VARS = ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY")


class FakeCompleted:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class FakeRunner:
    """Fake subprocess.run: aria2c writes its -o file, ffmpeg writes
    its output file. Every call is recorded with its kwargs."""

    def __init__(self):
        self.calls = []

    def __call__(self, args, **kwargs):
        self.calls.append((list(args), kwargs))
        if args[0] == "aria2c":
            out_name = args[args.index("-o") + 1]
            out_dir = args[args.index("-d") + 1]
            path = os.path.join(out_dir, out_name)
            with open(path, "wb") as f:
                f.write(b"x" * 20000)
            return FakeCompleted(returncode=0, stderr="")
        if args[0] == "ffmpeg":
            with open(args[-1], "wb") as f:
                f.write(b"x" * 30000)
            return FakeCompleted(returncode=0, stderr="")
        raise AssertionError(f"unexpected command: {args[0]}")


@pytest.fixture(autouse=True)
def resolve_proxy(monkeypatch):
    # The resolve proxy is configured; the datacenter proxy is set to
    # a different fake value so a test can tell them apart.
    monkeypatch.setattr(media_download, "RESOLVE_PROXY_URL", RESOLVE_PROXY)
    monkeypatch.setattr(media_download, "DATACENTER_PROXY", DATACENTER_PROXY)


@pytest.fixture(autouse=True)
def hostile_proxies(monkeypatch):
    for var in PROXY_VARS:
        monkeypatch.setenv(var, "http://proxy.example:8080")


@pytest.fixture()
def runner(monkeypatch):
    fake = FakeRunner()
    monkeypatch.setattr(media_download.subprocess, "run", fake)
    return fake


def _fake_metadata(monkeypatch, *, multi_format=False):
    """Stub fetch_metadata: records the proxy it was called with and
    returns canned info with CDN URLs."""
    calls = []

    def fake(url, proxy, profile, *, env=None, extra_args=None):
        calls.append({"url": url, "proxy": proxy, "env": env})
        info = {
            "description": "Test caption",
            "http_headers": {"User-Agent": "test-agent"},
        }
        if multi_format:
            info["requested_formats"] = [
                {"url": "https://cdn.example/video.mp4"},
                {"url": "https://cdn.example/audio.m4a"},
            ]
        else:
            info["url"] = "https://cdn.example/video.mp4"
        return info

    monkeypatch.setattr(media_download, "fetch_metadata", fake)
    return calls


def _assert_direct_aria2_call(argv, kwargs):
    assert "--proxy" not in argv
    assert not any("proxy.example" in arg for arg in argv)
    assert not any("resolve-proxy.example" in arg for arg in argv)
    env = kwargs["env"]
    assert isinstance(env, dict)
    assert not any(var in env for var in PROXY_VARS)
    assert not any("proxy.example" in str(value) for value in env.values())


def test_metadata_uses_resolve_proxy_and_file_fetch_is_direct(monkeypatch, runner):
    metadata_calls = _fake_metadata(monkeypatch)
    path, caption = download_reel_media("instagram", IG_URL, reel_external_id="4t_iB-gAoKo")
    try:
        assert os.path.exists(path)
        assert caption == "Test caption"
    finally:
        shutil.rmtree(os.path.dirname(path), ignore_errors=True)

    # The metadata call went through the resolve proxy — not direct,
    # not the datacenter proxy.
    assert len(metadata_calls) == 1
    assert metadata_calls[0]["url"] == IG_URL
    assert metadata_calls[0]["proxy"] == RESOLVE_PROXY
    assert metadata_calls[0]["proxy"] != DATACENTER_PROXY

    # The file fetch is direct: one aria2 call, no proxy anywhere.
    aria2_calls = [c for c in runner.calls if c[0][0] == "aria2c"]
    assert len(aria2_calls) == 1
    argv, kwargs = aria2_calls[0]
    assert "https://cdn.example/video.mp4" in argv
    _assert_direct_aria2_call(argv, kwargs)


def test_multi_format_both_fetches_are_direct(monkeypatch, runner):
    metadata_calls = _fake_metadata(monkeypatch, multi_format=True)
    path, caption = download_reel_media("instagram", IG_URL, reel_external_id="4t_iB-gAoKo")
    try:
        assert os.path.exists(path)
        assert caption == "Test caption"
    finally:
        shutil.rmtree(os.path.dirname(path), ignore_errors=True)

    assert len(metadata_calls) == 1
    assert metadata_calls[0]["proxy"] == RESOLVE_PROXY

    aria2_calls = [c for c in runner.calls if c[0][0] == "aria2c"]
    assert len(aria2_calls) == 2
    assert "https://cdn.example/video.mp4" in aria2_calls[0][0]
    assert "https://cdn.example/audio.m4a" in aria2_calls[1][0]
    for argv, kwargs in aria2_calls:
        _assert_direct_aria2_call(argv, kwargs)


def test_missing_resolve_proxy_fails_loud_before_any_subprocess(monkeypatch):
    monkeypatch.setattr(media_download, "RESOLVE_PROXY_URL", None)

    def no_metadata(url, proxy, profile, *, env=None, extra_args=None):
        raise AssertionError("metadata must not run without RESOLVE_PROXY_URL")

    def no_subprocess(args, **kwargs):
        raise AssertionError("no subprocess must run without RESOLVE_PROXY_URL")

    monkeypatch.setattr(media_download, "fetch_metadata", no_metadata)
    monkeypatch.setattr(media_download.subprocess, "run", no_subprocess)
    with pytest.raises(RuntimeError, match="RESOLVE_PROXY_URL"):
        download_reel_media("instagram", IG_URL, reel_external_id="4t_iB-gAoKo")
