"""TikTok stream resolution via the owner-supplied resolve proxy.

Resolver order (fixed): tikwm first, Countik only when tikwm fails.
Both resolvers are called through the injected urllib opener, which
production builds with a ProxyHandler from RESOLVE_PROXY_URL — resolve
calls NEVER go direct. Downloads never touch this module.

Failure vocabulary mirrors
`apps/tiktok-downloader/src/{tikwm,countik}.ts` exactly (stage / reason /
detail), so the failure rows this service writes are indistinguishable
from the Worker's for the live checks. Detail values never contain URLs,
captions, or credentials: only statuses, codes, and hosts.

Standard library only (`urllib`): no new dependency, so CI's pip install
line is unchanged. The opener is injected (test seam) — tests drive it
with a fake opener, production passes the proxied one.
"""

import json
import socket
import urllib.error
import urllib.parse
import urllib.request

DESKTOP_CHROME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
TIKWM_API_URL = "https://www.tikwm.com/api/"
TIKWM_ORIGIN = "https://www.tikwm.com/"
COUNTIK_API_BASE_URL = "https://countik.com/api"
COUNTIK_ORIGIN = "https://countik.com/"
# Per-call budget, matching the Worker's tikwm/Countik timeouts.
API_TIMEOUT_SECONDS = 25
DETAIL_LIMIT = 200


def truncate_detail(text: str, limit: int = DETAIL_LIMIT) -> str:
    """Collapse whitespace and truncate an error detail (Worker parity)."""
    collapsed = " ".join(text.split()).strip()
    return collapsed if len(collapsed) <= limit else f"{collapsed[:limit]}..."


class DownloadFailure:
    """One recorded download attempt: stage + reason + optional detail.

    Mirrors the Worker's `DownloadFailure` (failure.ts): a both-fail
    record carries the fallback attempt nested, so the row shows both
    attempts instead of hiding one.
    """

    def __init__(
        self,
        stage: str,
        reason: str,
        detail: str | None = None,
        fallback: "DownloadFailure | None" = None,
    ) -> None:
        self.stage = stage
        self.reason = reason
        self.detail = detail
        self.fallback = fallback

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, DownloadFailure):
            return NotImplemented
        return (
            self.stage == other.stage
            and self.reason == other.reason
            and self.detail == other.detail
            and self.fallback == other.fallback
        )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"DownloadFailure(stage={self.stage!r}, reason={self.reason!r}, "
            f"detail={self.detail!r}, fallback={self.fallback!r})"
        )


class ResolveSuccess:
    """A resolver returned a stream URL (and a raw caption, if any)."""

    def __init__(self, stream_url: str, raw_title: str | None, resolver: str) -> None:
        self.stream_url = stream_url
        self.raw_title = raw_title
        self.resolver = resolver

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, ResolveSuccess):
            return NotImplemented
        return (
            self.stream_url == other.stream_url
            and self.raw_title == other.raw_title
            and self.resolver == other.resolver
        )

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return (
            f"ResolveSuccess(stream_url=<redacted>, raw_title=<redacted>, "
            f"resolver={self.resolver!r})"
        )


def failure_record(failure: DownloadFailure) -> dict:
    """Build the JSON the record RPC stores (Worker shape; `at` is added
    by the caller, exactly like the Worker's supabase.ts)."""
    record: dict = {"stage": failure.stage, "reason": failure.reason}
    if failure.detail:
        record["detail"] = truncate_detail(failure.detail)
    if failure.fallback is not None:
        record["fallback"] = failure_record(failure.fallback)
    return record


def build_resolve_opener(proxy_url: str):
    """Build the urllib opener for resolve calls. The proxy URL is the
    owner-supplied resolve proxy (RESOLVE_PROXY_URL); it is never logged
    and never passed anywhere except this opener."""
    if not proxy_url:
        raise RuntimeError(
            "RESOLVE_PROXY_URL is required for TikTok resolve: "
            "set it in the downloader .env (resolve proxy only)"
        )
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
    )


def stream_host(stream_url: str) -> str:
    """Hostname only — never the full stream URL, which may carry a
    signature. Unparsable URLs record as 'unknown'."""
    try:
        return urllib.parse.urlparse(stream_url).hostname or "unknown"
    except Exception:
        return "unknown"


# --- internal fetch plumbing (mirrors the Worker's discriminated results) ---


class _Timeout(Exception):
    pass


class _FetchError(Exception):
    pass


class _HttpStatus(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status


_UNPARSED = object()


def _is_timeout(err: BaseException) -> bool:
    if isinstance(err, TimeoutError):
        return True
    if isinstance(err, urllib.error.URLError) and isinstance(err.reason, TimeoutError):
        return True
    return isinstance(err, socket.timeout)


def _fetch_json(opener, request, timeout: int):
    """Open a JSON API call. Returns (status, parsed_body_or_UNPARSED).

    Raises _Timeout / _FetchError for transport failures. A non-2xx
    status is returned, not raised: the caller maps it to its
    http_status failure (the Worker checks res.status before parsing).
    """
    try:
        with opener.open(request, timeout=timeout) as res:
            raw = res.read()
            status = res.status
    except urllib.error.HTTPError as err:
        return err.code, _UNPARSED
    except Exception as err:  # noqa: BLE001 - mapped below, never leaks raw
        if _is_timeout(err):
            raise _Timeout from err
        if isinstance(err, urllib.error.URLError):
            raise _FetchError(str(err.reason) if err.reason else str(err)) from err
        raise _FetchError(str(err)) from err
    try:
        return status, json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return status, _UNPARSED


def _post_form(opener, url: str, fields: dict, timeout: int):
    return _fetch_json(
        opener,
        urllib.request.Request(
            url,
            data=urllib.parse.urlencode(fields).encode(),
            headers={
                "User-Agent": DESKTOP_CHROME_UA,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            method="POST",
        ),
        timeout,
    )


def _post_json(opener, url: str, payload: dict, timeout: int):
    return _fetch_json(
        opener,
        urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={
                "User-Agent": DESKTOP_CHROME_UA,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            method="POST",
        ),
        timeout,
    )


def _get_json(opener, url: str, timeout: int):
    return _fetch_json(
        opener,
        urllib.request.Request(
            url,
            headers={"User-Agent": DESKTOP_CHROME_UA, "Accept": "application/json"},
            method="GET",
        ),
        timeout,
    )


# --- tikwm ---


def resolve_tikwm_stream(video_url: str, opener, pacer) -> ResolveSuccess | DownloadFailure:
    """Resolve a TikTok video URL to its HD stream URL via tikwm (proxy).

    Same success/failure semantics as the Worker's resolveTikwmStream:
    HTTP 200 + JSON `code == 0` required; stream URL is
    `data.hdplay or data.play`; caption is `data.title` or null.
    """
    pacer.acquire()
    try:
        status, body = _post_form(
            opener, TIKWM_API_URL, {"url": video_url, "hd": "1"}, API_TIMEOUT_SECONDS
        )
    except _Timeout:
        return DownloadFailure("tikwm_resolve", "tikwm_api_timeout")
    except _FetchError as err:
        return DownloadFailure("tikwm_resolve", "tikwm_api_fetch_error", detail=str(err))
    if status != 200:
        return DownloadFailure(
            "tikwm_resolve", "tikwm_api_http_status", detail=f"http_status={status}"
        )
    if body is _UNPARSED:
        return DownloadFailure("tikwm_resolve", "tikwm_api_body_unparsable")
    if not isinstance(body, dict):
        return DownloadFailure("tikwm_resolve", "tikwm_api_bad_body")
    code = body.get("code")
    if code != 0:
        code_text = str(code) if isinstance(code, (int, str)) else "missing"
        return DownloadFailure(
            "tikwm_resolve", "tikwm_api_body_code", detail=f"body_code={code_text}"
        )
    data = body.get("data")
    if not isinstance(data, dict):
        return DownloadFailure("tikwm_resolve", "tikwm_api_no_data")
    stream_url = data.get("hdplay") or data.get("play")
    if not isinstance(stream_url, str) or not stream_url:
        return DownloadFailure("tikwm_resolve", "tikwm_no_stream_url")
    if stream_url.startswith("/"):
        stream_url = f"{TIKWM_ORIGIN}{stream_url[1:]}"
    title = data.get("title")
    return ResolveSuccess(
        stream_url, title if isinstance(title, str) else None, "tikwm"
    )


# --- Countik ---


def _countik_step(opener, url: str, step: str, pacer, *, method: str, payload: dict | None = None):
    """One Countik call, with the Worker's step-attributed failures."""
    pacer.acquire()
    try:
        if method == "POST":
            status, body = _post_json(opener, url, payload or {}, API_TIMEOUT_SECONDS)
        else:
            status, body = _get_json(opener, url, API_TIMEOUT_SECONDS)
    except _Timeout:
        return None, DownloadFailure(
            "countik_resolve", "countik_api_timeout", detail=f"step={step}"
        )
    except _FetchError as err:
        return None, DownloadFailure(
            "countik_resolve",
            "countik_api_fetch_error",
            detail=f"step={step}; {err}",
        )
    if status != 200:
        if status == 429:
            pacer.note_rate_limited()
        return None, DownloadFailure(
            "countik_resolve",
            "countik_api_http_status",
            detail=f"step={step}; http_status={status}",
        )
    if body is _UNPARSED:
        return None, DownloadFailure(
            "countik_resolve", "countik_api_body_unparsable", detail=f"step={step}"
        )
    if not isinstance(body, dict):
        return None, DownloadFailure(
            "countik_resolve", "countik_api_bad_body", detail=f"step={step}"
        )
    data = body.get("data") if isinstance(body.get("data"), dict) else body
    return data, None


def _pick_string(record: dict | None, keys) -> str | None:
    if not record:
        return None
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def resolve_countik_stream(video_url: str, opener, pacer) -> ResolveSuccess | DownloadFailure:
    """Resolve a TikTok video URL to its direct mp4 link via Countik (proxy).

    Two calls, exactly as the Worker's resolveCountikStream: POST
    `/video/exist` → video id, GET `/videoinfo/<id>` → `download_link`
    + `desc` for the caption. A 429 on either step arms the pacer
    backoff (and is still a real attempt, so it follows the failed path).
    """
    data, failure = _countik_step(
        opener,
        f"{COUNTIK_API_BASE_URL}/video/exist",
        "exist",
        pacer,
        method="POST",
        payload={"url": video_url},
    )
    if failure is not None:
        return failure
    video_id = _pick_string(data, ["video_id", "videoId", "aweme_id", "id"])
    if not video_id:
        return DownloadFailure("countik_resolve", "countik_no_video_id", detail="step=exist")
    data, failure = _countik_step(
        opener,
        f"{COUNTIK_API_BASE_URL}/videoinfo/{urllib.parse.quote(video_id)}",
        "info",
        pacer,
        method="GET",
    )
    if failure is not None:
        return failure
    stream_url = _pick_string(data, ["download_link", "downloadUrl", "download_url"])
    if not stream_url:
        return DownloadFailure(
            "countik_resolve", "countik_no_download_link", detail="step=info"
        )
    if stream_url.startswith("/"):
        stream_url = f"{COUNTIK_ORIGIN}{stream_url[1:]}"
    title = _pick_string(data, ["desc", "description", "title"])
    return ResolveSuccess(stream_url, title, "countik")


# --- combined resolver ---


def resolve_tiktok_stream(video_url: str, opener, pacer) -> ResolveSuccess | DownloadFailure:
    """Tikwm first; Countik only when tikwm fails. A tikwm success never
    touches Countik. When both fail, the record carries BOTH attempts
    (primary tikwm + nested Countik fallback)."""
    tikwm = resolve_tikwm_stream(video_url, opener, pacer)
    if isinstance(tikwm, ResolveSuccess):
        return tikwm
    countik = resolve_countik_stream(video_url, opener, pacer)
    if isinstance(countik, ResolveSuccess):
        return countik
    return DownloadFailure(tikwm.stage, tikwm.reason, tikwm.detail, fallback=countik)
