def normalize_facebook_reel(reel_id: str) -> str:
    value = (reel_id or "").strip()
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return f"https://www.facebook.com/reel/{value}"


def source_url(platform: str, username: str, reel_id: str) -> str:
    p = (platform or "").lower()
    if p == "instagram":
        return f"https://www.instagram.com/reels/{reel_id}/"
    if p == "tiktok":
        return f"https://www.tiktok.com/@{username}/video/{reel_id}"
    if p == "youtube":
        return f"https://www.youtube.com/shorts/{reel_id}"
    if p == "facebook":
        return normalize_facebook_reel(reel_id)
    raise ValueError(f"unsupported platform: {platform}")
