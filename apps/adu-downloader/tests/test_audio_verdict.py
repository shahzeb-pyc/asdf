"""Tests for the audio verdict: ffprobe success is decisive, ffprobe
failure is inconclusive (accept) — the Worker's semantics."""

import os

import pytest

import media_download
from media_download import audio_verdict, verify_video_has_audio


def test_verdict_ffprobe_success_with_audio_accepts():
    assert audio_verdict(True, True) is True


def test_verdict_ffprobe_success_without_audio_rejects():
    # Fully parsed file, no audio track: positive proof of no audio.
    assert audio_verdict(True, False) is False


def test_verdict_ffprobe_failure_accepts():
    # Inconclusive (ffprobe errored): never hard-block.
    assert audio_verdict(False, False) is True
    assert audio_verdict(False, True) is True


class FakeCompleted:
    def __init__(self, returncode=0, stdout=""):
        self.returncode = returncode
        self.stdout = stdout


def _run_ffprobe(monkeypatch, *, returncode=0, stdout="audio", raises=False):
    def fake_run(*args, **kwargs):
        assert args[0][0] == "ffprobe"
        if raises:
            raise FileNotFoundError("ffprobe not installed")
        return FakeCompleted(returncode=returncode, stdout=stdout)

    monkeypatch.setattr(media_download.subprocess, "run", fake_run)


def test_verify_accepts_when_ffprobe_finds_audio(monkeypatch, tmp_path):
    target = tmp_path / "v.mp4"
    target.write_bytes(b"x" * 100)
    _run_ffprobe(monkeypatch, returncode=0, stdout="audio\n")
    assert verify_video_has_audio(str(target)) is True


def test_verify_rejects_when_ffprobe_finds_no_audio(monkeypatch, tmp_path):
    target = tmp_path / "v.mp4"
    target.write_bytes(b"x" * 100)
    _run_ffprobe(monkeypatch, returncode=0, stdout="")
    assert verify_video_has_audio(str(target)) is False


def test_verify_accepts_when_ffprobe_errors(monkeypatch, tmp_path):
    target = tmp_path / "v.mp4"
    target.write_bytes(b"x" * 100)
    _run_ffprobe(monkeypatch, raises=True)
    assert verify_video_has_audio(str(target)) is True


def test_verify_rejects_missing_file():
    assert verify_video_has_audio("/definitely/not/a/file.mp4") is False


def test_download_reel_media_rejects_tiktok_as_unsupported():
    # TikTok no longer goes through the yt-dlp path: the worker
    # dispatches it to the new module, and this raises fail-loud here.
    with pytest.raises(ValueError, match="unsupported platform: tiktok"):
        media_download.download_reel_media(
            "tiktok", "https://www.tiktok.com/@x/video/1", reel_external_id="1"
        )
