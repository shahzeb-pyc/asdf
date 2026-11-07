"""Shared pacing for TikTok resolve API calls (tikwm + Countik).

The Worker processed sequentially (10/tick); the VPS pool runs up to 30
workers concurrently, so unpaced resolve calls would hammer the APIs
(and the resolve proxy pool). One pacer serialises resolve calls: a
minimum interval between calls, plus a backoff after a 429.

The pacer BLOCKS the calling thread — there is no deferred-reel path on
the VPS: the row is held by a live worker thread, so nothing can strand,
and the 40-minute stale reset returns the row to `pending` if a thread
ever dies.

It holds no per-IP state: the resolve proxy is ROTATING, so nothing here
may assume a stable egress IP or session stickiness. A 429 arms the
backoff regardless of which IP the call exited from.
"""

import threading
import time


class ResolvePacer:
    """Thread-safe resolve pacer with a fake-clock seam for tests."""

    def __init__(
        self,
        min_interval_seconds: float = 2.0,
        backoff_seconds: float = 120.0,
        *,
        clock=time.monotonic,
        sleep=time.sleep,
    ) -> None:
        self._min_interval = float(min_interval_seconds)
        self._backoff_seconds = float(backoff_seconds)
        self._clock = clock
        self._sleep = sleep
        self._lock = threading.Lock()
        self._last_call_at: float | None = None
        self._backoff_until: float | None = None

    def acquire(self) -> None:
        """Block until a resolve call is allowed, then record it as made.

        A 429 backoff is served first; then the minimum interval since
        the last call. The lock is held for the whole wait, so calls are
        serialised and spaced even across threads.
        """
        with self._lock:
            now = self._clock()
            if self._backoff_until is not None and now < self._backoff_until:
                self._sleep(self._backoff_until - now)
                now = self._clock()
                self._backoff_until = None
            if self._last_call_at is not None:
                wait = self._min_interval - (now - self._last_call_at)
                if wait > 0:
                    self._sleep(wait)
                    now = self._clock()
            self._last_call_at = now

    def note_rate_limited(self) -> None:
        """Arm the backoff from now (a 429 was observed on a resolve call)."""
        with self._lock:
            self._backoff_until = self._clock() + self._backoff_seconds
