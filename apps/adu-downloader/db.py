import threading
import time

import httpx
from supabase import create_client

from config import (
    ENV_FILE,
    RPC_BACKOFF_SECONDS,
    RPC_MAX_RETRIES,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL,
)

_thread_local = threading.local()

_RETRYABLE_EXCEPTIONS = (
    httpx.ReadError,
    httpx.ConnectError,
    httpx.WriteError,
    httpx.RemoteProtocolError,
    httpx.TimeoutException,
    httpx.NetworkError,
    httpx.PoolTimeout,
    ConnectionError,
    TimeoutError,
    OSError,
)


def get_client():
    client = getattr(_thread_local, "client", None)
    if client is None:
        if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
            raise RuntimeError(
                f"SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required; "
                f"set them in {ENV_FILE} (file exists: {ENV_FILE.is_file()})"
            )
        _thread_local.client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
        client = _thread_local.client
    return client


def _rpc_execute(build_call):
    last_exc: Exception | None = None
    for attempt in range(1, RPC_MAX_RETRIES + 1):
        try:
            return build_call()
        except _RETRYABLE_EXCEPTIONS as exc:
            last_exc = exc
            if attempt >= RPC_MAX_RETRIES:
                break
            delay = RPC_BACKOFF_SECONDS * (2 ** (attempt - 1))
            time.sleep(delay)
    assert last_exc is not None
    raise last_exc


def reset_stale_reel_downloads(stale_minutes: int):
    return _rpc_execute(
        lambda: get_client()
        .rpc("reset_stale_adu_reel_downloads", {"p_stale_minutes": stale_minutes})
        .execute()
    )


def claim_buffer_downloads(limit: int):
    return _rpc_execute(
        lambda: get_client().rpc("claim_adu_buffer_downloads", {"p_limit": limit}).execute()
    )


def mark_downloaded(
    reel_id: str,
    object_key: str,
    size_bytes: int,
    content_type: str,
    sha256: str,
    caption: str,
    media_url: str,
):
    # New ADU tables: reel ids are uuids (not old bigint), and the RPC
    # also records the public media_url the publisher fetches.
    return _rpc_execute(
        lambda: get_client()
        .rpc(
            "mark_adu_reel_downloaded",
            {
                "p_reel_id": reel_id,
                "p_media_object_key": object_key,
                "p_media_size_bytes": size_bytes,
                "p_media_content_type": content_type,
                "p_media_sha256": sha256,
                "p_reel_caption": caption,
                "p_media_url": media_url,
            },
        )
        .execute()
    )


def mark_download_failed(reel_id: int):
    return _rpc_execute(
        lambda: get_client().rpc("mark_adu_reel_download_failed", {"p_reel_id": reel_id}).execute()
    )
