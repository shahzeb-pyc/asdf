"""Behavioural tests for downloader config helpers and R2 key shape."""

import os

import config
from r2_upload import object_key


def test_public_url_for_key_requires_base_and_joins():
    # R2_PUBLIC_URL is read at import time; the CI/dev default is empty,
    # so the helper must fail loud rather than build a relative URL.
    import pytest

    if config.R2_PUBLIC_URL:
        assert config.public_url_for_key("/adu-buffer/c/r.mp4").endswith("/adu-buffer/c/r.mp4")
    else:
        with pytest.raises(RuntimeError):
            config.public_url_for_key("adu-buffer/c/r.mp4")


def test_object_key_shape_is_unchanged_from_old_app():
    assert object_key("cfg-uuid", "reel-uuid") == "adu-buffer/cfg-uuid/reel-uuid.mp4"


def test_aria2_args_are_bounded():
    args = config.aria2_cli_args()
    assert args == ["-x", str(config.ARIA2_MAX_CONNECTION), "-s", str(config.ARIA2_SPLIT), "-k1M"]
    assert 1 <= config.ARIA2_MAX_CONNECTION <= 16
    assert 1 <= config.ARIA2_SPLIT <= 16


def test_env_bounds_clamp(monkeypatch):
    # _bounded_int is the shared clamp used by every env-tuned limit.
    monkeypatch.setenv("ADU_DOWNLOADER_CONCURRENCY", "9999")
    assert config._bounded_int("ADU_DOWNLOADER_CONCURRENCY", "30", minimum=1, maximum=200) == 200
    monkeypatch.setenv("ADU_DOWNLOADER_CONCURRENCY", "0")
    assert config._bounded_int("ADU_DOWNLOADER_CONCURRENCY", "30", minimum=1, maximum=200) == 1
    os.environ.pop("ADU_DOWNLOADER_CONCURRENCY", None)
