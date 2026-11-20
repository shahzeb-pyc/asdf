"""Spec 212 — idle backoff progression for the ADU downloader loop.

The loop sleeps longer the longer it stays empty, up to a hard cap, so
an idle downloader stops firing the stale-reset + claim RPCs every
minute. A newly queued reel is picked up at most the cap after it
arrives.
"""

from idle_backoff import next_idle_wait_seconds


def test_progression_doubles_then_caps():
    assert next_idle_wait_seconds(0, base_seconds=60, max_seconds=300) == 60
    assert next_idle_wait_seconds(1, base_seconds=60, max_seconds=300) == 120
    assert next_idle_wait_seconds(2, base_seconds=60, max_seconds=300) == 240
    assert next_idle_wait_seconds(3, base_seconds=60, max_seconds=300) == 300
    assert next_idle_wait_seconds(4, base_seconds=60, max_seconds=300) == 300
    assert next_idle_wait_seconds(100, base_seconds=60, max_seconds=300) == 300


def test_cap_never_exceeded_for_any_streak():
    for streak in range(0, 50):
        wait = next_idle_wait_seconds(streak, base_seconds=60, max_seconds=300)
        assert wait <= 300


def test_base_and_max_are_honoured():
    assert next_idle_wait_seconds(0, base_seconds=30, max_seconds=90) == 30
    assert next_idle_wait_seconds(1, base_seconds=30, max_seconds=90) == 60
    assert next_idle_wait_seconds(2, base_seconds=30, max_seconds=90) == 90
    assert next_idle_wait_seconds(9, base_seconds=30, max_seconds=90) == 90


def test_negative_streak_is_treated_as_zero():
    assert next_idle_wait_seconds(-1, base_seconds=60, max_seconds=300) == 60


def test_cap_below_base_is_treated_as_base():
    assert next_idle_wait_seconds(5, base_seconds=60, max_seconds=30) == 60
