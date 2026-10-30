import re

DEFAULT_REEL_CAPTION = "❤️"

_PLACEHOLDER_CAPTIONS = frozenset({"...", "…", ".", "-", "n/a", "na", "none", ""})

_GENERIC_TITLE_PATTERNS = (
    re.compile(r"^instagram\s*reel\s*#?\d*$", re.I),
    re.compile(r"^tiktok\s*#?\d*$", re.I),
    re.compile(r"^youtube\s*shorts?$", re.I),
    re.compile(r"^reel\s*#?\d*$", re.I),
    re.compile(r"^video\s*#?\d*$", re.I),
)


def _looks_like_platform_id(text: str, reel_external_id: str | None) -> bool:
    candidate = text.strip()
    if not candidate:
        return True

    # 1. If it matches or contains the reel_external_id with generic words
    if reel_external_id:
        reel_id = reel_external_id.strip()
        if reel_id.lower() in candidate.lower():
            rem = candidate.lower().replace(reel_id.lower(), "").strip(" _-#")
            if not rem or rem in {"video", "reel", "tiktok", "facebook", "instagram", "youtube", "shorts", "id", "post", "photo", "audio"}:
                return True

    # 2. Check if the candidate itself is a pure numeric ID (length >= 5)
    if re.fullmatch(r"\d{5,}", candidate):
        return True

    # 3. Check if it matches typical platform video/post ID formats
    platform_prefixes = r"(?:video|tiktok|facebook|instagram|youtube|reel|post|id|photo|audio|shorts|clip)"
    if re.fullmatch(platform_prefixes + r"[_\-\s]+\d+", candidate, re.I):
        return True
    if re.fullmatch(platform_prefixes + r"[_\-\s]*id[_\-\s]+\d+", candidate, re.I):
        return True

    # 4. Check if the text is a single alphanumeric token of length 11 to 32 that is heavily numeric/ID-like
    if " " not in candidate and re.fullmatch(r"[A-Za-z0-9_\-]+", candidate):
        if len(candidate) in {32, 40, 64} and re.fullmatch(r"[a-fA-F0-9]+", candidate):
            return True
        if 11 <= len(candidate) <= 32:
            num_digits = sum(ch.isdigit() for ch in candidate)
            num_letters = sum(ch.isalpha() for ch in candidate)
            if num_letters == 0:
                return True
            letter_runs = re.findall(r"[a-zA-Z]{4,}", candidate)
            if not letter_runs:
                return True
            if len(candidate) >= 15 and num_digits >= 2:
                return True

    return False


def normalize_reel_caption(raw: str | None, *, reel_external_id: str | None = None) -> str:
    text = (raw or "").strip()
    if not text or text.lower() in _PLACEHOLDER_CAPTIONS:
        return DEFAULT_REEL_CAPTION

    if _looks_like_platform_id(text, reel_external_id):
        return DEFAULT_REEL_CAPTION

    lowered = text.lower().strip("# ")
    if lowered in {"video", "reel", "untitled", "tiktok", "instagram reel", "youtube shorts", "shorts"}:
        return DEFAULT_REEL_CAPTION

    for pattern in _GENERIC_TITLE_PATTERNS:
        if pattern.match(lowered):
            return DEFAULT_REEL_CAPTION

    return text


def caption_from_yt_dlp_info(info: dict, *, reel_external_id: str | None = None) -> str:
    description = (info.get("description") or "").strip()
    title = (info.get("title") or "").strip()

    normalized_desc = normalize_reel_caption(description, reel_external_id=reel_external_id)
    normalized_title = normalize_reel_caption(title, reel_external_id=reel_external_id)

    desc_is_valid = normalized_desc != DEFAULT_REEL_CAPTION
    title_is_valid = normalized_title != DEFAULT_REEL_CAPTION

    if desc_is_valid and title_is_valid:
        if normalized_title.lower() in normalized_desc.lower():
            return normalized_desc
        return normalized_desc
    elif desc_is_valid:
        return normalized_desc
    elif title_is_valid:
        return normalized_title

    return DEFAULT_REEL_CAPTION
