"""Idle backoff for the ADU downloader loop (spec 212).

While the loop keeps claiming nothing, the idle sleep grows — 60s, then
120s, then 240s, then the hard cap — instead of firing the stale-reset
RPC plus two claim RPCs every 60s around the clock. Any claim (or any
in-flight work) resets the streak to zero, so pickup returns to the
base interval immediately on activity.

Pure functions only: no imports, no I/O, so the unit tests can import
this module without Supabase credentials (see tests/conftest.py).
"""


def next_idle_wait_seconds(
    consecutive_empty: int, *, base_seconds: int, max_seconds: int
) -> int:
    """Idle sleep after `consecutive_empty` loops that claimed nothing.

    Doubles per empty loop (60, 120, 240, …) and never exceeds the hard
    cap `max_seconds`. A negative streak is treated as zero; a cap
    below the base is treated as the base (the cap must never shorten
    the sleep below the configured base).
    """
    if consecutive_empty < 0:
        consecutive_empty = 0
    if max_seconds < base_seconds:
        max_seconds = base_seconds
    wait = base_seconds * (2**consecutive_empty)
    return min(wait, max_seconds)
