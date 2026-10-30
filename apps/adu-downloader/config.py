import os
from pathlib import Path

from dotenv import load_dotenv

# Always load downloader/.env (works for `python worker.py` and PM2 on Linux/Windows).
ENV_FILE = Path(__file__).resolve().parent / ".env"
load_dotenv(ENV_FILE, override=False)

_downloader_dir = Path(__file__).resolve().parent


def _bounded_int(name: str, default: str, *, minimum: int = 1, maximum: int | None = None) -> int:
    value = int(os.environ.get(name, default))
    if value < minimum:
        return minimum
    if maximum is not None and value > maximum:
        return maximum
    return value


SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip()
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "").strip()
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
R2_BUCKET = os.environ.get("R2_ADU_BUFFER_BUCKET", "fbuploadpro-adu-buffer").strip()
# Public base URL of the buffer bucket. The downloader stores the buffer
# object under media_object_key AND the public URL under media_url: the
# new app's Facebook publisher fetches media_url at publish time (it
# does not read R2 directly, unlike the old publisher), and the worker
# intake only picks reels with a media_url set. Same value as the web
# app's R2_PUBLIC_URL.
R2_PUBLIC_URL = os.environ.get("R2_PUBLIC_URL", "").strip().rstrip("/")


def public_url_for_key(key: str) -> str:
    if not R2_PUBLIC_URL:
        raise RuntimeError("R2_PUBLIC_URL is required: the publisher fetches the buffer object by public URL")
    return f"{R2_PUBLIC_URL}/{key.lstrip('/')}"

# Wait for in-flight downloads before topping up claims (avoids claim spam while batch runs).
IN_FLIGHT_POLL_SECONDS = _bounded_int("ADU_DOWNLOADER_IN_FLIGHT_POLL_SECONDS", "20", minimum=1, maximum=300)
# Sleep only when no in-flight work and claim returned zero rows.
IDLE_WAIT_SECONDS = _bounded_int("ADU_DOWNLOADER_IDLE_WAIT_SECONDS", "60", minimum=1)
MAX_CONCURRENT = _bounded_int("ADU_DOWNLOADER_CONCURRENCY", "30", minimum=1, maximum=200)
# Per-claim download attempts before mark_adu_reel_download_failed (separate from DB download_retries).
DOWNLOAD_ATTEMPT_RETRIES = _bounded_int("ADU_DOWNLOADER_ATTEMPT_RETRIES", "4", minimum=1, maximum=20)
DOWNLOAD_MAX_BYTES = _bounded_int("ADU_DOWNLOAD_MAX_BYTES", "1073741824", minimum=1)
# Reset reels stuck in processing back to pending (worker calls reset_stale_adu_reel_downloads each loop).
STALE_MINUTES = _bounded_int("ADU_DOWNLOADER_STALE_MINUTES", "40", minimum=1, maximum=24 * 60)

# Supabase RPC retries (transient httpx/network errors, especially on Windows).
RPC_MAX_RETRIES = _bounded_int("ADU_DOWNLOADER_RPC_RETRIES", "5", minimum=1, maximum=20)
RPC_BACKOFF_SECONDS = _bounded_int("ADU_DOWNLOADER_RPC_BACKOFF_SECONDS", "1", minimum=1, maximum=60)

# Local disk cache keyed by source reel_id (skip re-download when upload/DB update fails).
_cache_dir_env = os.environ.get("ADU_DOWNLOADER_CACHE_DIR", "").strip()
if _cache_dir_env:
    CACHE_DIR = Path(_cache_dir_env).expanduser()
    if not CACHE_DIR.is_absolute():
        CACHE_DIR = _downloader_dir / CACHE_DIR
else:
    CACHE_DIR = _downloader_dir / "cache"

# aria2: lower -x/-s per file so 30 parallel jobs do not open thousands of TCP connections.
ARIA2_MAX_CONNECTION = _bounded_int("ADU_ARIA2_MAX_CONNECTION", "4", minimum=1, maximum=16)
ARIA2_SPLIT = _bounded_int("ADU_ARIA2_SPLIT", "4", minimum=1, maximum=16)

# R2 upload: stream from disk in chunks (peak RAM ~ chunk size per active upload, not file size).
R2_UPLOAD_CHUNK_BYTES = _bounded_int(
    "ADU_R2_UPLOAD_CHUNK_BYTES",
    str(8 * 1024 * 1024),
    minimum=256 * 1024,
    maximum=64 * 1024 * 1024,
)

RESIDENTIAL_PROXY = os.environ.get("RESIDENTIAL_PROXY", "").strip() or None
DATACENTER_PROXY = os.environ.get("DATACENTER_PROXY", "").strip() or None

# yt-dlp EJS: YouTube (and some other extractors) need a JS runtime on PATH.
# Format: RUNTIME or RUNTIME:/path/to/binary (see yt-dlp --help).
YT_DLP_JS_RUNTIME = os.environ.get("ADU_DOWNLOADER_JS_RUNTIME", "node").strip()

# Rotating log files (default: downloader/logs/). Relative paths resolve under downloader/.
_log_dir_env = os.environ.get("ADU_DOWNLOADER_LOG_DIR", "").strip()
if _log_dir_env:
    LOG_DIR = Path(_log_dir_env).expanduser()
    if not LOG_DIR.is_absolute():
        LOG_DIR = _downloader_dir / LOG_DIR
else:
    LOG_DIR = _downloader_dir / "logs"
LOG_MAX_BYTES = _bounded_int("ADU_DOWNLOADER_LOG_MAX_BYTES", str(10 * 1024 * 1024), minimum=256 * 1024)
LOG_BACKUP_COUNT = _bounded_int("ADU_DOWNLOADER_LOG_BACKUP_COUNT", "5", minimum=1, maximum=50)


def aria2_cli_args() -> list[str]:
    return ["-x", str(ARIA2_MAX_CONNECTION), "-s", str(ARIA2_SPLIT), "-k1M"]


def yt_dlp_aria2_downloader_args() -> str:
    return (
        f"aria2c:--summary-interval=0 -x{ARIA2_MAX_CONNECTION} "
        f"-s{ARIA2_SPLIT} -k1M"
    )


def yt_dlp_js_runtime_args() -> list[str]:
    if not YT_DLP_JS_RUNTIME:
        return []
    return ["--js-runtimes", YT_DLP_JS_RUNTIME]
