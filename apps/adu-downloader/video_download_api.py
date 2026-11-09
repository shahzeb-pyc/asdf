"""YouTube downloads through the Video Download Api (p.savenow.to).

Stdlib only. Adapted from the proven helper at
~/workspace/custom-connectors/custom.video-download-api/bin/vda.py —
same endpoints and polling, as an importable module the downloader
owns. No subtitle jobs: "captions" here means the video title, taken
from the API info object.

Provider rules (verified live 2026-11-09, see the connector doc):
- `format` is required; 1080 is the highest sensible format for
  Shorts ($0.0002/job, same as 720p). `no_merge=0` merges audio and
  video into one MP4; `no_merge=1` returns a zip of separate streams.
- A job is charged the moment its id is returned, even if it later
  fails. There is no refund path and no balance/usage endpoint.
- The key travels as the `apikey` query param. The submit URL must
  never be logged.
"""

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

log = logging.getLogger("adu-downloader")

BASE_URL = "https://p.savenow.to"
FORMAT = "1080"
POLL_INTERVAL_SECONDS = 3.0
POLL_TIMEOUT_SECONDS = 240.0
FETCH_ATTEMPTS = 3
FETCH_TIMEOUT_SECONDS = 120


class VideoDownloadApiError(RuntimeError):
    """A Video Download Api call failed (submit, poll, or fetch).

    `error_code` carries the provider's error_code when the response
    had one (e.g. `invalid_api_key`, `insufficient_balance`); it is
    None for transport-level failures.
    """

    def __init__(self, message: str, *, error_code: str | None = None) -> None:
        super().__init__(message)
        self.error_code = error_code


class VideoDownloadApiConfigError(RuntimeError):
    """The Video Download Api key is missing. Raised before any
    network call; the caller must NOT fall back to yt-dlp silently."""


@dataclass
class ApiDownloadResult:
    filepath: str
    title: str | None
    credits_used: int | None
    final_price: float | None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def _short(text: str, limit: int = 300) -> str:
    collapsed = " ".join(text.strip().split())
    if len(collapsed) <= limit:
        return collapsed
    return f"{collapsed[:limit]}... [truncated]"


def _http_get_json(url: str, *, label: str) -> tuple[dict, dict]:
    """GET a URL and parse the JSON body. API calls only — redirects
    are refused so the key (in the submit query string) can never
    leak to another host. The URL is never included in any error:
    it carries the key."""
    request = urllib.request.Request(url)
    try:
        with urllib.request.build_opener(_NoRedirect()).open(request, timeout=30) as response:
            headers = dict(response.headers.items())
            body = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        error_code = None
        detail = _short(body)
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict):
                error_code = parsed.get("error_code")
                detail = _short(str(parsed.get("message") or parsed.get("error") or body))
        except (json.JSONDecodeError, ValueError):
            pass
        raise VideoDownloadApiError(
            f"{label} failed: HTTP {exc.code}: {detail}", error_code=error_code
        ) from exc
    except urllib.error.URLError as exc:
        raise VideoDownloadApiError(f"{label} failed: {exc.reason}") from exc
    try:
        return json.loads(body), headers
    except json.JSONDecodeError as exc:
        raise VideoDownloadApiError(f"{label} returned unparsable JSON") from exc


def _poll_progress(
    job_id: str, progress_url: str | None, *, poll_interval: float, poll_timeout: float
) -> dict:
    url = progress_url or f"{BASE_URL}/ajax/progress.php?id={urllib.parse.quote(job_id)}"
    deadline = time.time() + poll_timeout
    last: dict = {}
    while time.time() < deadline:
        last, _ = _http_get_json(url, label="progress poll")
        progress = last.get("progress")
        if isinstance(progress, (int, float)) and progress >= 1000:
            return last
        time.sleep(poll_interval)
    raise VideoDownloadApiError(
        f"progress poll timed out after {poll_timeout}s for job {job_id}; last state: {_short(json.dumps(last))}"
    )


def _fetch_file(url: str, out_path: str, *, attempts: int = FETCH_ATTEMPTS) -> int:
    """Fetch an unauthenticated file URL (the provider's download_url).
    Redirects are allowed here: the URL carries no key. Retries a
    dropped transfer before giving up."""
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(url)
            with urllib.request.build_opener().open(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
                data = response.read()
            with open(out_path, "wb") as handle:
                handle.write(data)
            return len(data)
        except Exception as exc:  # noqa: BLE001 - retried, then raised below
            last_error = exc
            log.warning("file fetch attempt %d/%d failed: %s", attempt, attempts, exc)
            if attempt < attempts:
                time.sleep(1)
    raise VideoDownloadApiError(f"file fetch failed after {attempts} attempts: {last_error}") from last_error


def _clean_title(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _read_cost(data: dict, headers: dict) -> tuple[int | None, float | None]:
    credits_used: int | None = None
    raw_credits = headers.get("x-jojapi-credits-used")
    if raw_credits is not None:
        try:
            credits_used = int(raw_credits)
        except (TypeError, ValueError):
            credits_used = None
    final_price: float | None = None
    extended = data.get("extended_duration")
    if isinstance(extended, dict):
        raw_price = extended.get("final_price")
        if isinstance(raw_price, (int, float)):
            final_price = float(raw_price)
    return credits_used, final_price


def download_video(
    url: str,
    api_key: str | None,
    out_path: str,
    *,
    poll_interval: float = POLL_INTERVAL_SECONDS,
    poll_timeout: float = POLL_TIMEOUT_SECONDS,
) -> ApiDownloadResult:
    """Download one YouTube video at 1080p (merged audio+video) via
    the Video Download Api. Returns the saved file, the video title
    from the API info object (None when the API gave none), and the
    per-job cost when the response carried it. Raises
    VideoDownloadApiConfigError when the key is missing and
    VideoDownloadApiError for any API failure."""
    if not api_key or not api_key.strip():
        raise VideoDownloadApiConfigError(
            "YT_VIDEO_DOWNLOAD_API_KEY is not set: add it to Doppler prd "
            "and the downloader environment"
        )
    params = {
        "url": url,
        "format": FORMAT,
        "add_info": "1",
        "no_merge": "0",
        "apikey": api_key,
    }
    query = urllib.parse.urlencode(params)
    data, headers = _http_get_json(f"{BASE_URL}/ajax/download.php?{query}", label="download submit")
    job_id = data.get("id")
    if not job_id:
        detail = data.get("message") or data.get("error") or "no job id returned"
        raise VideoDownloadApiError(
            f"download submit returned no job id: {_short(str(detail))}",
            error_code=data.get("error_code") if isinstance(data.get("error_code"), str) else None,
        )
    job_id = str(job_id)
    credits_used, final_price = _read_cost(data, headers)
    log.info(
        "video-download-api job %s accepted (credits_used=%s, final_price=%s)",
        job_id,
        credits_used,
        final_price,
    )
    result = _poll_progress(
        job_id, data.get("progress_url"), poll_interval=poll_interval, poll_timeout=poll_timeout
    )
    if result.get("success") not in (1, True) or not result.get("download_url"):
        detail = result.get("text") or result.get("message") or "job failed"
        raise VideoDownloadApiError(
            f"video-download-api job {job_id} failed: {_short(str(detail))}"
        )
    size = _fetch_file(result["download_url"], out_path)
    log.info("video-download-api job %s downloaded %d bytes to %s", job_id, size, out_path)
    title = _clean_title(result.get("title"))
    if title is None:
        additional = data.get("additional_info")
        if isinstance(additional, dict):
            title = _clean_title(additional.get("title"))
    return ApiDownloadResult(
        filepath=out_path, title=title, credits_used=credits_used, final_price=final_price
    )
