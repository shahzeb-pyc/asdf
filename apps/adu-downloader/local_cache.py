import os
import re
import shutil
from pathlib import Path

from caption_utils import DEFAULT_REEL_CAPTION, normalize_reel_caption
from config import CACHE_DIR


def _safe_key(reel_id: str) -> str:
    cleaned = re.sub(r"[^\w.-]", "_", (reel_id or "").strip())
    return cleaned[:200] or "unknown"


def media_path(reel_id: str) -> Path:
    return CACHE_DIR / f"{_safe_key(reel_id)}.mp4"


def caption_path(reel_id: str) -> Path:
    return CACHE_DIR / f"{_safe_key(reel_id)}.caption"


def has_cached(reel_id: str) -> bool:
    path = media_path(reel_id)
    return path.is_file() and path.stat().st_size > 0


def read_caption(reel_id: str) -> str:
    path = caption_path(reel_id)
    if path.is_file():
        return normalize_reel_caption(path.read_text(encoding="utf-8"), reel_external_id=reel_id)
    return DEFAULT_REEL_CAPTION


def save_from_download(reel_id: str, source_path: str, caption: str) -> str:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    dest = media_path(reel_id)
    parent = os.path.dirname(os.path.abspath(source_path))
    shutil.move(source_path, dest)
    caption_path(reel_id).write_text(
        normalize_reel_caption(caption, reel_external_id=reel_id),
        encoding="utf-8",
    )
    if os.path.abspath(parent) != os.path.abspath(str(CACHE_DIR)):
        shutil.rmtree(parent, ignore_errors=True)
    return str(dest)


def remove(reel_id: str) -> None:
    for path in (media_path(reel_id), caption_path(reel_id)):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
