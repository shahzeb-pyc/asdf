import json
import logging
import os
import subprocess
import tempfile
import uuid

from caption_utils import DEFAULT_REEL_CAPTION, caption_from_yt_dlp_info, normalize_reel_caption
from config import (
    DATACENTER_PROXY,
    YT_VIDEO_DOWNLOAD_API_KEY,
    aria2_cli_args,
    direct_env,
    yt_dlp_aria2_downloader_args,
    yt_dlp_js_runtime_args,
)
from video_download_api import (
    VideoDownloadApiConfigError,
    VideoDownloadApiError,
    download_video as download_video_via_api,
)

log = logging.getLogger("adu-downloader")

# Flexible target: yt-dlp/curl_cffi pick a compatible Chrome version automatically.
YT_DLP_IMPERSONATE = "chrome"

PLATFORM_PROFILES = {
    "instagram": {
        "headers": {
            "Referer": "https://www.instagram.com/",
        },
        "retries": 1,
        "extractor_retries": 2,
        "fragment_retries": 2,
        "socket_timeout": 30,
    },
    "youtube": {
        "format_candidates": ["bv*+ba/b", "bestvideo*+bestaudio/best"],
        "headers": {
            "Referer": "https://www.youtube.com/",
        },
        "retries": 1,
        "extractor_retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 30,
    },
    "facebook": {
        "format_candidates": ["bv*+ba/b", "b[ext=mp4]/b"],
        "headers": {
            "Referer": "https://www.facebook.com/",
        },
        "retries": 1,
        "extractor_retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 30,
        "generic_extractor_fallback": True
    },
}

def run_command(args, *, env=None):
    try:
        return subprocess.run(
            args,
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(_extract_process_error_message(exc)) from exc


def _extract_process_error_message(exc: subprocess.CalledProcessError, *, limit: int = 500) -> str:
    """Prefer yt-dlp/tool ERROR lines over full command dumps in logs."""
    stderr = exc.stderr or ""
    for line in reversed(stderr.splitlines()):
        stripped = line.strip()
        if stripped.startswith("ERROR:"):
            return _truncate_for_error(stripped, limit)

    stderr_tail = _truncate_for_error(stderr, limit)
    if stderr_tail:
        return stderr_tail

    stdout_tail = _truncate_for_error(exc.stdout or "", limit)
    if stdout_tail:
        return stdout_tail

    return f"process exited with code {exc.returncode}"


def run_ffmpeg(*args: str):
    """Mux/transcode via ffmpeg without banner noise; stderr captured only on failure."""
    return run_command(["ffmpeg", "-hide_banner", "-loglevel", "error", *args])


def _truncate_for_error(text, limit=1200):
    if not text:
        return ""
    collapsed = " ".join(text.strip().split())
    if len(collapsed) <= limit:
        return collapsed
    return f"{collapsed[:limit]}... [truncated]"


def parse_json_from_stdout(stdout):
    for line in reversed(stdout.splitlines()):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            continue
    raise RuntimeError("yt-dlp did not return parsable JSON output")


def build_common_yt_dlp_args(profile, proxy):
    args = [
        "--no-warnings",
        "--quiet",
        *yt_dlp_js_runtime_args(),
        "--impersonate",
        YT_DLP_IMPERSONATE,
        "--retries",
        str(profile.get("retries", 1)),
        "--extractor-retries",
        str(profile.get("extractor_retries", 3)),
        "--fragment-retries",
        str(profile.get("fragment_retries", 3)),
        "--socket-timeout",
        str(profile.get("socket_timeout", 30)),
    ]
    if proxy:
        args.extend(["--proxy", proxy])
    for header_name, header_value in profile.get("headers", {}).items():
        args.extend(["--add-header", f"{header_name}: {header_value}"])
    return args


def fetch_metadata(url, proxy, profile, *, env=None, extra_args=None):
    args = [
        "yt-dlp",
        url,
        "--dump-single-json",
        "--skip-download",
    ]
    if extra_args:
        args.extend(extra_args)
    args.extend(build_common_yt_dlp_args(profile, proxy))
    result = run_command(args, env=env)
    return parse_json_from_stdout(result.stdout)


def download_with_yt_dlp(url, proxy, output_template, profile, format_selector, use_generic_extractor=False, *, env=None, extra_args=None):
    args = [
        "yt-dlp",
        url,
        "--format",
        format_selector,
        "--output",
        output_template,
        "--no-progress",
        "--downloader",
        "aria2c",
        "--downloader-args",
        yt_dlp_aria2_downloader_args(),
        "--merge-output-format",
        "mp4",
        "--print-json",
    ]
    if extra_args:
        args.extend(extra_args)
    args.extend(build_common_yt_dlp_args(profile, proxy))
    if use_generic_extractor:
        args.append("--force-generic-extractor")
    result = run_command(args, env=env)
    return parse_json_from_stdout(result.stdout)


def resolve_downloaded_filename(tmp_dir, unique_id, info):
    requested_downloads = info.get("requested_downloads") or []
    preferred_paths = [
        info.get("_filename"),
        requested_downloads[0].get("filepath") if requested_downloads else None,
    ]
    for candidate in preferred_paths:
        if candidate and os.path.exists(candidate):
            return candidate

    base_filename = os.path.join(tmp_dir, unique_id)
    for ext in ("mp4", "mkv", "webm", "m4a"):
        candidate = f"{base_filename}.{ext}"
        if os.path.exists(candidate):
            return candidate

    for name in os.listdir(tmp_dir):
        if name.startswith(unique_id) and not name.endswith(".part"):
            candidate = os.path.join(tmp_dir, name)
            if os.path.isfile(candidate):
                return candidate

    return None

def download_from_metadata_info(
    info: dict,
    tmp_dir: str,
    unique_id: str,
    *,
    reel_external_id: str | None = None,
) -> tuple[str, str]:
    """Resolve CDN URLs from yt-dlp metadata and download via aria2 (no proxy on file fetch)."""
    description = caption_from_yt_dlp_info(info, reel_external_id=reel_external_id)
    user_agent = info.get("http_headers", {}).get("User-Agent", "Mozilla/5.0")
    requested_formats = info.get("requested_formats")
    if requested_formats and len(requested_formats) > 1:
        v_url = requested_formats[0]["url"]
        a_url = requested_formats[1]["url"]
        v_path = os.path.join(tmp_dir, f"{unique_id}_v.mp4")
        a_path = os.path.join(tmp_dir, f"{unique_id}_a.m4a")
        subprocess.run(
            ["aria2c", "-q", *aria2_cli_args(), "--user-agent", user_agent, v_url, "-o", f"{unique_id}_v.mp4", "-d", tmp_dir],
            check=True,
        )
        subprocess.run(
            ["aria2c", "-q", *aria2_cli_args(), "--user-agent", user_agent, a_url, "-o", f"{unique_id}_a.m4a", "-d", tmp_dir],
            check=True,
        )
        filename = os.path.join(tmp_dir, f"{unique_id}.mp4")
        run_ffmpeg("-y", "-i", v_path, "-i", a_path, "-c", "copy", "-f", "mp4", filename)
    else:
        url_to_dl = info.get("url")
        if not url_to_dl:
            raise RuntimeError("Unable to extract direct video URL from metadata")
        filename = os.path.join(tmp_dir, f"{unique_id}.mp4")
        subprocess.run(
            ["aria2c", "-q", *aria2_cli_args(), "--user-agent", user_agent, url_to_dl, "-o", f"{unique_id}.mp4", "-d", tmp_dir],
            check=True,
        )
    return filename, description


def download_via_metadata_then_aria2(
    url: str,
    profile: dict,
    metadata_proxy: str | None,
    tmp_dir: str,
    unique_id: str,
    *,
    reel_external_id: str | None = None,
) -> tuple[str, str]:
    info = fetch_metadata(url, metadata_proxy, profile)
    return download_from_metadata_info(info, tmp_dir, unique_id, reel_external_id=reel_external_id)


def download_with_ytdlp_formats(
    url: str,
    profile: dict,
    proxy: str | None,
    tmp_dir: str,
    unique_id: str,
    *,
    include_generic_fallback: bool = False,
    reel_external_id: str | None = None,
    env: dict | None = None,
    extra_args: list[str] | None = None,
) -> tuple[str, str]:
    output_template = os.path.join(tmp_dir, f"{unique_id}.%(ext)s")
    attempts = [(fmt, False) for fmt in profile.get("format_candidates", ["bv*+ba/b"])]
    if include_generic_fallback:
        attempts.append((profile["format_candidates"][-1], True))

    filename = None
    description = DEFAULT_REEL_CAPTION
    last_error: str | None = None
    for format_selector, use_generic_extractor in attempts:
        try:
            info = download_with_yt_dlp(
                url,
                proxy,
                output_template,
                profile,
                format_selector,
                use_generic_extractor=use_generic_extractor,
                env=env,
                extra_args=extra_args,
            )
            description = caption_from_yt_dlp_info(info, reel_external_id=reel_external_id)
            filename = resolve_downloaded_filename(tmp_dir, unique_id, info)
            if filename:
                return filename, description
            last_error = "yt-dlp finished but output file was not found"
        except RuntimeError as exc:
            last_error = str(exc)

    raise RuntimeError(last_error or "yt-dlp download failed")


def audio_verdict(ffprobe_succeeded: bool, ffprobe_found_audio: bool) -> bool:
    """Pure audio decision (Worker-equivalent, pinned by tests).

    A successful ffprobe run is decisive: it parsed the file, so no
    audio stream means the file genuinely has none -> reject. Any
    ffprobe failure is inconclusive -> accept: the old code explicitly
    avoided hard-blocking then, and the Worker accepts inconclusive
    probes too. (The old MP4 marker fallback is gone: both of its
    outcomes were "accept", so it decided nothing.)
    """
    if ffprobe_succeeded:
        return ffprobe_found_audio
    return True


def verify_video_has_audio(filepath: str) -> bool:
    """Verify that video file contains an active audio stream using ffprobe."""
    if not filepath or not os.path.exists(filepath):
        return False

    try:
        cmd = [
            "ffprobe", "-v", "error",
            "-select_streams", "a",
            "-show_entries", "stream=codec_type",
            "-of", "csv=p=0",
            filepath,
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=8)
        if res.returncode == 0:
            return audio_verdict(True, "audio" in res.stdout.lower())
    except Exception:
        pass

    return audio_verdict(False, False)


def _title_from_ytdlp_metadata(url: str, profile: dict) -> str:
    """Title via yt-dlp metadata when the API gave none (direct, no
    proxy, config ignored — same no-proxy guarantee as the fallback).
    A metadata failure does not fail the download: the file is already
    saved, so the caption falls back to the default."""
    try:
        info = fetch_metadata(url, None, profile, env=direct_env(), extra_args=["--ignore-config"])
        return caption_from_yt_dlp_info(info)
    except Exception as exc:
        log.warning("yt-dlp metadata title fetch failed (%s); using default caption", exc)
        return DEFAULT_REEL_CAPTION


def _download_youtube_via_ytdlp_direct(
    url: str,
    profile: dict,
    tmp_dir: str,
    unique_id: str,
    *,
    reel_external_id: str | None = None,
    api_error: Exception,
) -> tuple[str, str]:
    """The yt-dlp fallback for YouTube: the existing profile, run
    direct. No --proxy argument, a proxy-stripped environment, and
    --ignore-config so no yt-dlp config file on the host can re-add
    a proxy. Both causes are carried when it fails too."""
    try:
        return download_with_ytdlp_formats(
            url,
            profile,
            None,
            tmp_dir,
            unique_id,
            env=direct_env(),
            extra_args=["--ignore-config"],
            reel_external_id=reel_external_id,
        )
    except RuntimeError as fallback_exc:
        raise RuntimeError(
            f"video-download-api failed ({api_error}); yt-dlp fallback failed ({fallback_exc})"
        ) from fallback_exc


def download_youtube_reel(
    url: str,
    profile: dict,
    tmp_dir: str,
    unique_id: str,
    *,
    reel_external_id: str | None = None,
) -> tuple[str, str]:
    """YouTube download: Video Download Api first (1080, merged),
    direct yt-dlp fallback on any API failure. A missing API key is
    a config error raised before any download — yt-dlp is never used
    as a silent substitute for an unwired API."""
    if not YT_VIDEO_DOWNLOAD_API_KEY:
        raise VideoDownloadApiConfigError(
            "YT_VIDEO_DOWNLOAD_API_KEY is not set: add it to Doppler prd "
            "and the downloader environment"
        )
    out_path = os.path.join(tmp_dir, f"{unique_id}.mp4")
    try:
        result = download_video_via_api(url, YT_VIDEO_DOWNLOAD_API_KEY, out_path)
    except VideoDownloadApiError as exc:
        if exc.error_code == "invalid_api_key":
            log.error(
                "video-download-api rejected the key (invalid_api_key) for %s; "
                "falling back to direct yt-dlp — check YT_VIDEO_DOWNLOAD_API_KEY",
                url,
            )
        else:
            log.warning(
                "video-download-api failed for %s (%s); falling back to direct yt-dlp",
                url,
                exc,
            )
        return _download_youtube_via_ytdlp_direct(
            url,
            profile,
            tmp_dir,
            unique_id,
            reel_external_id=reel_external_id,
            api_error=exc,
        )
    title = result.title or _title_from_ytdlp_metadata(url, profile)
    return result.filepath, title or DEFAULT_REEL_CAPTION


def download_reel_media(platform: str, url: str, *, reel_external_id: str | None = None) -> tuple[str, str]:
    """Download reel to a temp file; returns (absolute_path, caption). Caller must delete the file."""
    platform = (platform or "instagram").lower()
    if platform not in PLATFORM_PROFILES:
        raise ValueError(f"unsupported platform: {platform}")

    unique_id = uuid.uuid4().hex
    tmp_dir = tempfile.mkdtemp(prefix="adu-dl-")
    try:
        profile = PLATFORM_PROFILES[platform]

        if platform == "instagram":
            # Metadata via yt-dlp (optional datacenter proxy), then direct CDN fetch via aria2.
            filename, description = download_via_metadata_then_aria2(
                url,
                profile,
                DATACENTER_PROXY,
                tmp_dir,
                unique_id,
                reel_external_id=reel_external_id,
            )
        elif platform == "youtube":
            # Video Download Api first (1080, merged), direct yt-dlp
            # fallback with no proxy (spec 157).
            filename, description = download_youtube_reel(
                url,
                profile,
                tmp_dir,
                unique_id,
                reel_external_id=reel_external_id,
            )
        else:
            # Facebook: full yt-dlp download (optional datacenter proxy on yt-dlp).
            filename, description = download_with_ytdlp_formats(
                url,
                profile,
                DATACENTER_PROXY,
                tmp_dir,
                unique_id,
                include_generic_fallback=True,
                reel_external_id=reel_external_id,
            )

        if not os.path.exists(filename):
            raise RuntimeError("Failed to download video")
        return filename, normalize_reel_caption(description, reel_external_id=reel_external_id)
    except Exception:
        import shutil
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
