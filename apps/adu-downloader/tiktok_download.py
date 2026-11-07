"""TikTok download path for the VPS downloader: resolve via the resolve
proxy, download direct, never yt-dlp.

Split (owner rule): the resolve proxy is for getting links and talking
to Countik ONLY. The video bytes are fetched direct with aria2c, whose
subprocess runs with a sanitised environment (no proxy variables) and no
proxy argument — so the download path cannot inherit the resolve proxy
from a shared client, session, or environment. A test pins this split:
passing the resolve proxy to any download tool must fail it.

yt-dlp is NOT used for TikTok: its extractor is broken for TikTok
webpages (probed 2026-11-07, direct and via the proxy — "Unexpected
response from webpage request"). The Worker never had yt-dlp either; a
reel whose resolvers both fail simply retries on a later claim (budget 3).
"""

import os
import shutil
import subprocess
import tempfile
import uuid
from dataclasses import dataclass

from caption_utils import normalize_reel_caption
from config import aria2_cli_args
from media_download import verify_video_has_audio
from resolve_pacing import ResolvePacer
from tiktok_resolve import (
    DESKTOP_CHROME_UA,
    DownloadFailure,
    ResolveSuccess,
    resolve_tiktok_stream,
    stream_host,
)

MIN_FILE_BYTES = 10_000
MAX_FILE_BYTES = 1_073_741_824

_PROXY_ENV_VARS = (
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "all_proxy",
    "ALL_PROXY",
)


@dataclass
class TikTokDeps:
    """Everything the TikTok path needs, built once by the worker loop."""

    opener: object  # urllib opener built from RESOLVE_PROXY_URL
    pacer: ResolvePacer


class TikTokDownloadFailure(Exception):
    """A TikTok download attempt failed with a structured, recordable
    failure (Worker stage/reason/detail shape). The worker records it
    before the status transition."""

    def __init__(self, failure: DownloadFailure) -> None:
        super().__init__(f"{failure.stage}:{failure.reason}")
        self.failure = failure


def direct_env() -> dict:
    """Environment for download subprocesses: the resolve proxy is
    stripped out, so no download tool can pick it up from the ambient
    environment. (The VPS sets no proxy vars today; this is the
    explicit guarantee, not a reliance on that.)"""
    env = dict(os.environ)
    for var in _PROXY_ENV_VARS:
        env.pop(var, None)
    return env


def _aria2_error(stderr: str) -> str:
    """Prefer the last non-empty stderr line (aria2c's error) over a
    full dump; fall back to the exit with no detail."""
    for line in reversed((stderr or "").splitlines()):
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def download_tiktok_reel(
    video_url: str,
    *,
    reel_external_id: str | None,
    opener,
    pacer: ResolvePacer,
) -> tuple[str, str]:
    """Resolve + download one TikTok reel to a temp file.

    Returns (absolute_path, caption). The caller owns the file (the
    worker moves it into the local cache, or deletes it). On any
    failure the temp dir is removed and a TikTokDownloadFailure is
    raised — the temp file never leaks, and a failed reel never leaves
    a partial object behind (R2 is only written by the worker after
    this returns).
    """
    resolved = resolve_tiktok_stream(video_url, opener, pacer)
    if isinstance(resolved, DownloadFailure):
        raise TikTokDownloadFailure(resolved)
    assert isinstance(resolved, ResolveSuccess)
    stream_url = resolved.stream_url
    resolver = resolved.resolver

    tmp_dir = tempfile.mkdtemp(prefix="adu-tiktok-")
    unique_id = uuid.uuid4().hex
    filename = os.path.join(tmp_dir, f"{unique_id}.mp4")
    try:
        try:
            result = subprocess.run(
                [
                    "aria2c",
                    "-q",
                    *aria2_cli_args(),
                    "--user-agent",
                    DESKTOP_CHROME_UA,
                    stream_url,
                    "-o",
                    f"{unique_id}.mp4",
                    "-d",
                    tmp_dir,
                ],
                capture_output=True,
                text=True,
                env=direct_env(),
            )
        except OSError as err:
            raise TikTokDownloadFailure(
                DownloadFailure(
                    "stream_open",
                    "stream_fetch_error",
                    detail=(
                        f"resolver={resolver}; host={stream_host(stream_url)}; {err}"
                    ),
                )
            ) from err
        if result.returncode != 0:
            detail = _aria2_error(result.stderr)
            raise TikTokDownloadFailure(
                DownloadFailure(
                    "stream_open",
                    "stream_fetch_error",
                    detail=(
                        f"resolver={resolver}; host={stream_host(stream_url)}"
                        + (f"; {detail}" if detail else "")
                    ),
                )
            )
        if not os.path.exists(filename):
            raise TikTokDownloadFailure(
                DownloadFailure(
                    "stream_open",
                    "stream_no_body",
                    detail=f"resolver={resolver}; host={stream_host(stream_url)}",
                )
            )
        size = os.path.getsize(filename)
        if size <= MIN_FILE_BYTES:
            raise TikTokDownloadFailure(
                DownloadFailure("size_check", "too_small", detail=f"size_bytes={size}")
            )
        if size > MAX_FILE_BYTES:
            raise TikTokDownloadFailure(
                DownloadFailure(
                    "stream_upload", "file_too_large", detail=f"cap_bytes={MAX_FILE_BYTES}"
                )
            )
        if not verify_video_has_audio(filename):
            raise TikTokDownloadFailure(DownloadFailure("audio_check", "no_audio"))
        caption = normalize_reel_caption(resolved.raw_title, reel_external_id=reel_external_id)
        return filename, caption
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
