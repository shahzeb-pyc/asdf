"""Behavioural tests for caption normalisation (the old app's rule:
a missing, placeholder, generic or platform-id caption becomes ❤️)."""

from caption_utils import (
    DEFAULT_REEL_CAPTION,
    caption_from_yt_dlp_info,
    normalize_reel_caption,
)


def test_empty_and_placeholder_become_heart():
    assert normalize_reel_caption(None) == DEFAULT_REEL_CAPTION
    assert normalize_reel_caption("") == DEFAULT_REEL_CAPTION
    assert normalize_reel_caption("...") == DEFAULT_REEL_CAPTION
    assert normalize_reel_caption("n/a") == DEFAULT_REEL_CAPTION


def test_real_caption_is_kept_verbatim():
    assert normalize_reel_caption("  Morning grind, day 12  ") == "Morning grind, day 12"


def test_generic_titles_become_heart():
    assert normalize_reel_caption("Instagram Reel #42") == DEFAULT_REEL_CAPTION
    assert normalize_reel_caption("Untitled") == DEFAULT_REEL_CAPTION
    assert normalize_reel_caption("YouTube Shorts") == DEFAULT_REEL_CAPTION


def test_platform_id_becomes_heart():
    assert normalize_reel_caption("123456789012345", reel_external_id="123456789012345") == DEFAULT_REEL_CAPTION
    assert normalize_reel_caption("987654321") == DEFAULT_REEL_CAPTION


def test_yt_dlp_info_prefers_description_over_title():
    assert (
        caption_from_yt_dlp_info({"description": "Real description", "title": "Real title"})
        == "Real description"
    )
    assert (
        caption_from_yt_dlp_info({"description": "", "title": "Only a title"}) == "Only a title"
    )
    assert (
        caption_from_yt_dlp_info({"description": "", "title": "Instagram Reel #1"})
        == DEFAULT_REEL_CAPTION
    )
