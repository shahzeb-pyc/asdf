#!/usr/bin/env python3
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from config import (
    ARIA2_MAX_CONNECTION,
    ARIA2_SPLIT,
    DOWNLOAD_ATTEMPT_RETRIES,
    DOWNLOAD_MAX_BYTES,
    IDLE_WAIT_SECONDS,
    IN_FLIGHT_POLL_SECONDS,
    MAX_CONCURRENT,
    R2_UPLOAD_CHUNK_BYTES,
    RESOLVE_BACKOFF_SECONDS,
    RESOLVE_MIN_INTERVAL_SECONDS,
    RESOLVE_PROXY_URL,
    STALE_MINUTES,
    public_url_for_key,
)
from caption_utils import normalize_reel_caption
from db import (
    claim_buffer_downloads,
    claim_tiktok_buffer_downloads,
    mark_download_failed,
    mark_downloaded,
    record_download_failure,
    reset_stale_reel_downloads,
)
from local_cache import has_cached, media_path, read_caption, remove as remove_cached, save_from_download
from logging_setup import LOGGER_NAME, configure_logging
from media_download import download_reel_media
from r2_upload import object_key, upload_file
from resolve_pacing import ResolvePacer
from sources import source_url
from tiktok_download import TikTokDeps, TikTokDownloadFailure, download_tiktok_reel
from tiktok_resolve import DownloadFailure, build_resolve_opener

log = logging.getLogger(LOGGER_NAME)


def _build_tiktok_deps():
    """Build the TikTok resolve opener + pacer once. Returns None (and
    logs loudly) when the resolve proxy is not configured: TikTok
    claiming is then disabled and the non-TikTok service keeps running."""
    if not RESOLVE_PROXY_URL:
        log.error(
            json.dumps(
                {
                    "event": "tiktok_resolve_proxy_missing",
                    "message": "RESOLVE_PROXY_URL is not set; TikTok claiming disabled",
                }
            )
        )
        return None
    try:
        return TikTokDeps(
            opener=build_resolve_opener(RESOLVE_PROXY_URL),
            pacer=ResolvePacer(RESOLVE_MIN_INTERVAL_SECONDS, RESOLVE_BACKOFF_SECONDS),
        )
    except Exception:
        log.exception(json.dumps({"event": "tiktok_deps_error"}))
        return None


def _record_tiktok_failure(reel_id, failure: DownloadFailure) -> None:
    # Record first: the reason must survive even if the retry-accounting
    # call itself fails. A record failure is loud but never blocks the
    # status transition (Worker parity).
    try:
        record_download_failure(reel_id, failure)
    except Exception as exc:
        log.error(
            json.dumps(
                {
                    "event": "record_failure_failed",
                    "reel_internal_id": reel_id,
                    "message": str(exc)[:500],
                }
            )
        )


def _ensure_media(reel_external_id: str, platform: str, url: str) -> tuple[str, str] | None:
    if has_cached(reel_external_id):
        path = str(media_path(reel_external_id))
        log.info(
            json.dumps(
                {
                    "event": "cache_hit",
                    "reel_id": reel_external_id,
                    "path": path,
                }
            )
        )
        return path, normalize_reel_caption(read_caption(reel_external_id), reel_external_id=reel_external_id)

    last_error: Exception | None = None
    for attempt in range(1, DOWNLOAD_ATTEMPT_RETRIES + 1):
        try:
            local_path, caption = download_reel_media(platform, url, reel_external_id=reel_external_id)
            caption = normalize_reel_caption(caption, reel_external_id=reel_external_id)
            cached_path = save_from_download(reel_external_id, local_path, caption)
            log.info(
                json.dumps(
                    {
                        "event": "download_cached",
                        "reel_id": reel_external_id,
                        "path": cached_path,
                        "attempt": attempt,
                    }
                )
            )
            return cached_path, caption
        except Exception as exc:
            last_error = exc
            log.warning(
                json.dumps(
                    {
                        "event": "download_attempt_failed",
                        "reel_id": reel_external_id,
                        "platform": platform,
                        "attempt": attempt,
                        "max_attempts": DOWNLOAD_ATTEMPT_RETRIES,
                        "message": str(exc)[:500],
                    }
                )
            )

    log.error(
        json.dumps(
            {
                "event": "download_error",
                "reel_id": reel_external_id,
                "platform": platform,
                "message": str(last_error)[:500] if last_error else "unknown",
            }
        )
    )
    return None


def _process_one_tiktok(row: dict, tiktok_deps) -> None:
    """TikTok rows: resolve via the resolve proxy, download direct, settle
    with the Worker's semantics. One attempt per claim (no 4-attempt
    loop): the claim budget (3) is the retry mechanism, exactly like the
    Worker. A `mark_downloaded` throw after a successful R2 put leaves
    the row `processing` (loud log, stale reset recovers it) — never
    mark it failed: the download itself succeeded."""
    reel_id = row["reel_id"]
    page_id = row["config_id"]
    platform = row["source_platform"]
    username = row["source_username"]
    reel_external_id = row["source_reel_id"]
    url = source_url(platform, username, reel_external_id)
    key = object_key(str(page_id), reel_id)

    log.info(
        json.dumps(
            {
                "event": "download_begin",
                "reel_internal_id": reel_id,
                "reel_id": reel_external_id,
                "page_id": str(page_id),
                "platform": platform,
                "attempt_retries": 1,
            }
        )
    )

    if tiktok_deps is None:
        # The loop claims zero TikTok rows without a resolve proxy, so
        # this should not happen; if it does, leave the row `processing`
        # (stale reset returns it) rather than burning a retry.
        log.error(
            json.dumps(
                {
                    "event": "tiktok_resolve_proxy_missing",
                    "reel_internal_id": reel_id,
                    "reel_id": reel_external_id,
                }
            )
        )
        return

    if has_cached(reel_external_id):
        local_path = str(media_path(reel_external_id))
        caption = normalize_reel_caption(
            read_caption(reel_external_id), reel_external_id=reel_external_id
        )
        log.info(
            json.dumps(
                {
                    "event": "cache_hit",
                    "reel_id": reel_external_id,
                    "path": local_path,
                }
            )
        )
    else:
        try:
            local_path, caption = download_tiktok_reel(
                url,
                reel_external_id=reel_external_id,
                opener=tiktok_deps.opener,
                pacer=tiktok_deps.pacer,
            )
            local_path = save_from_download(reel_external_id, local_path, caption)
            log.info(
                json.dumps(
                    {
                        "event": "download_cached",
                        "reel_id": reel_external_id,
                        "path": local_path,
                    }
                )
            )
        except TikTokDownloadFailure as exc:
            _record_tiktok_failure(reel_id, exc.failure)
            mark_download_failed(reel_id)
            return
        except Exception as exc:
            log.error(
                json.dumps(
                    {
                        "event": "download_unexpected_error",
                        "reel_id": reel_external_id,
                        "platform": platform,
                        "message": str(exc)[:500],
                    }
                )
            )
            _record_tiktok_failure(
                reel_id,
                DownloadFailure("pipeline", "unexpected_error", detail=str(exc)[:200]),
            )
            mark_download_failed(reel_id)
            return

    caption = normalize_reel_caption(caption, reel_external_id=reel_external_id)
    size = os.path.getsize(local_path)
    if size > DOWNLOAD_MAX_BYTES:
        _record_tiktok_failure(
            reel_id,
            DownloadFailure(
                "stream_upload", "file_too_large", detail=f"cap_bytes={DOWNLOAD_MAX_BYTES}"
            ),
        )
        mark_download_failed(reel_id)
        return
    try:
        size_bytes, content_type, sha256 = upload_file(local_path, key)
    except Exception as exc:
        log.error(
            json.dumps(
                {
                    "event": "upload_error",
                    "reel_internal_id": reel_id,
                    "reel_id": reel_external_id,
                    "platform": platform,
                    "message": str(exc)[:500],
                }
            )
        )
        _record_tiktok_failure(
            reel_id,
            DownloadFailure("stream_upload", "r2_put_error", detail=str(exc)[:200]),
        )
        mark_download_failed(reel_id)
        return
    try:
        mark_downloaded(
            reel_id, key, size_bytes, content_type, sha256, caption,
            public_url_for_key(key),
        )
    except Exception as exc:
        # The bytes are already in R2 under a deterministic key, so a later
        # re-download overwrites them; leave the row `processing` and let
        # the stale reset return it to `pending`. Never mark it failed
        # here: the download itself succeeded.
        log.error(
            json.dumps(
                {
                    "event": "settle_downloaded_failed",
                    "reel_internal_id": reel_id,
                    "reel_id": reel_external_id,
                    "message": str(exc)[:500],
                }
            )
        )
        return
    remove_cached(reel_external_id)
    log.info(
        json.dumps(
            {
                "event": "download_ok",
                "reel_internal_id": reel_id,
                "reel_id": reel_external_id,
                "platform": platform,
                "media_object_key": key,
                "size_bytes": size_bytes,
            }
        )
    )


def process_one(row: dict, tiktok_deps=None) -> None:
    if row.get("source_platform") == "tiktok":
        _process_one_tiktok(row, tiktok_deps)
        return
    # New claim RPC returns the new ADU shape: reel_id is the adu_reels
    # uuid (old: reel_internal_id bigint), config_id replaces page_id,
    # source_platform / source_username / source_reel_id replace
    # platform / username / reel_id. Object key keeps the old pattern
    # adu-buffer/<config_id>/<reel_id>.mp4.
    reel_id = row["reel_id"]
    page_id = row["config_id"]
    platform = row["source_platform"]
    username = row["source_username"]
    reel_external_id = row["source_reel_id"]
    url = source_url(platform, username, reel_external_id)
    key = object_key(str(page_id), reel_id)

    log.info(
        json.dumps(
            {
                "event": "download_begin",
                "reel_internal_id": reel_id,
                "reel_id": reel_external_id,
                "page_id": str(page_id),
                "platform": platform,
                "attempt_retries": DOWNLOAD_ATTEMPT_RETRIES,
            }
        )
    )

    media = _ensure_media(reel_external_id, platform, url)
    if media is None:
        mark_download_failed(reel_id)
        return

    local_path, caption = media
    caption = normalize_reel_caption(caption, reel_external_id=reel_external_id)
    last_error: Exception | None = None

    for attempt in range(1, DOWNLOAD_ATTEMPT_RETRIES + 1):
        try:
            size = os.path.getsize(local_path)
            if size > DOWNLOAD_MAX_BYTES:
                raise RuntimeError("media_too_large")

            size_bytes, content_type, sha256 = upload_file(local_path, key)
            # The publisher fetches the buffer object by public URL, so
            # record media_url alongside the object key (old publisher
            # read R2 directly and had no media_url).
            mark_downloaded(
                reel_id, key, size_bytes, content_type, sha256, caption,
                public_url_for_key(key),
            )
            remove_cached(reel_external_id)
            log.info(
                json.dumps(
                    {
                        "event": "download_ok",
                        "reel_internal_id": reel_id,
                        "reel_id": reel_external_id,
                        "platform": platform,
                        "media_object_key": key,
                        "size_bytes": size_bytes,
                        "attempt": attempt,
                    }
                )
            )
            return
        except Exception as exc:
            last_error = exc
            log.warning(
                json.dumps(
                    {
                        "event": "upload_attempt_failed",
                        "reel_internal_id": reel_id,
                        "reel_id": reel_external_id,
                        "platform": platform,
                        "attempt": attempt,
                        "max_attempts": DOWNLOAD_ATTEMPT_RETRIES,
                        "message": str(exc)[:500],
                    }
                )
            )

    log.error(
        json.dumps(
            {
                "event": "upload_error",
                "reel_internal_id": reel_id,
                "reel_id": reel_external_id,
                "platform": platform,
                "message": str(last_error)[:500] if last_error else "unknown",
                "cache_retained": True,
            }
        )
    )
    mark_download_failed(reel_id)


def _drain_completed(in_flight: set) -> None:
    done = {future for future in in_flight if future.done()}
    for future in done:
        try:
            future.result()
        except Exception as exc:
            log.exception(
                json.dumps(
                    {
                        "event": "worker_task_error",
                        "message": str(exc)[:500],
                    }
                )
            )
        in_flight.discard(future)


def _wait_for_in_flight(in_flight: set, timeout_seconds: int) -> None:
    """Block up to timeout_seconds for at least one download to finish (no exception on timeout)."""
    if not in_flight:
        return
    if any(future.done() for future in in_flight):
        return
    try:
        next(as_completed(in_flight, timeout=timeout_seconds))
    except TimeoutError:
        pass


def run_loop() -> None:
    tiktok_deps = _build_tiktok_deps()
    with ThreadPoolExecutor(max_workers=MAX_CONCURRENT) as pool:
        in_flight: set = set()
        while True:
            try:
                reset_result = reset_stale_reel_downloads(STALE_MINUTES)
                reset_data = reset_result.data
                reset_count = reset_data if isinstance(reset_data, int) else (reset_data or 0)
                if reset_count:
                    log.info(json.dumps({"event": "stale_reset", "count": reset_count, "stale_minutes": STALE_MINUTES}))

                if in_flight:
                    _wait_for_in_flight(in_flight, IN_FLIGHT_POLL_SECONDS)
                    _drain_completed(in_flight)

                free_slots = MAX_CONCURRENT - len(in_flight)
                claimed = []
                if free_slots > 0:
                    # TikTok first (the VPS is the only TikTok claimant
                    # now), then everything else for the slots still free
                    # — every slot is used every loop, and the non-TikTok
                    # path can never be starved by a TikTok claim that
                    # returns zero rows.
                    if tiktok_deps is not None:
                        result = claim_tiktok_buffer_downloads(free_slots)
                        claimed = result.data or []
                        if claimed:
                            log.info(json.dumps({"event": "claim_ok", "platform": "tiktok", "count": len(claimed), "free_slots": free_slots}))
                    remaining = free_slots - len(claimed)
                    if remaining > 0:
                        result = claim_buffer_downloads(remaining)
                        rest = result.data or []
                        if rest:
                            log.info(json.dumps({"event": "claim_ok", "count": len(rest), "free_slots": remaining}))
                        claimed = claimed + rest
                    if not claimed and not in_flight:
                        log.info(json.dumps({"event": "claim_empty"}))

                for row in claimed:
                    in_flight.add(pool.submit(process_one, row, tiktok_deps))

                if not in_flight and not claimed:
                    time.sleep(IDLE_WAIT_SECONDS)
            except Exception:
                log.exception(json.dumps({"event": "loop_error"}))
                time.sleep(IDLE_WAIT_SECONDS)


def main() -> None:
    log_dir = configure_logging()
    log.info(
        json.dumps(
            {
                "event": "loop_start",
                "log_dir": str(log_dir),
                "idle_wait_seconds": IDLE_WAIT_SECONDS,
                "in_flight_poll_seconds": IN_FLIGHT_POLL_SECONDS,
                "concurrency": MAX_CONCURRENT,
                "stale_minutes": STALE_MINUTES,
                "download_attempt_retries": DOWNLOAD_ATTEMPT_RETRIES,
                "aria2_max_connection": ARIA2_MAX_CONNECTION,
                "aria2_split": ARIA2_SPLIT,
                "r2_upload_chunk_bytes": R2_UPLOAD_CHUNK_BYTES,
                "resolve_proxy_configured": bool(RESOLVE_PROXY_URL),
                "resolve_min_interval_seconds": RESOLVE_MIN_INTERVAL_SECONDS,
                "resolve_backoff_seconds": RESOLVE_BACKOFF_SECONDS,
            }
        )
    )
    run_loop()


if __name__ == "__main__":
    main()
