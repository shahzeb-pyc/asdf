"""Tests for the shared resolve pacer (fake clock — no real waiting)."""

import threading

from resolve_pacing import ResolvePacer


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def _pacer(clock, sleeps, interval=2.0, backoff=120.0):
    def sleep(seconds):
        sleeps.append(seconds)
        clock.advance(seconds)

    return ResolvePacer(interval, backoff, clock=clock, sleep=sleep)


def test_first_call_never_waits():
    clock, sleeps = FakeClock(), []
    _pacer(clock, sleeps).acquire()
    assert sleeps == []


def test_second_call_waits_the_interval():
    clock, sleeps = FakeClock(), []
    pacer = _pacer(clock, sleeps)
    pacer.acquire()
    pacer.acquire()
    assert sleeps == [2.0]


def test_call_after_interval_does_not_wait():
    clock, sleeps = FakeClock(), []
    pacer = _pacer(clock, sleeps)
    pacer.acquire()
    clock.advance(5.0)
    pacer.acquire()
    assert sleeps == []


def test_429_backoff_blocks_until_it_expires():
    clock, sleeps = FakeClock(), []
    pacer = _pacer(clock, sleeps)
    pacer.acquire()
    pacer.note_rate_limited()
    pacer.acquire()
    # Backoff (120 s) first; the interval has elapsed during it, so no
    # second wait is recorded.
    assert sleeps == [120.0]
    pacer.acquire()
    assert sleeps == [120.0, 2.0]


def test_backoff_uses_the_clock_at_note_time():
    clock, sleeps = FakeClock(), []
    pacer = _pacer(clock, sleeps)
    pacer.acquire()
    clock.advance(10.0)
    pacer.note_rate_limited()  # backoff until 1000+10+120
    clock.advance(100.0)  # still 20 s of backoff left
    pacer.acquire()
    assert sleeps == [20.0]


def test_concurrent_acquires_do_not_deadlock():
    clock, sleeps = FakeClock(), []
    pacer = _pacer(clock, sleeps)
    errors = []

    def work():
        try:
            pacer.acquire()
        except Exception as exc:  # noqa: BLE001 - test must surface it
            errors.append(exc)

    threads = [threading.Thread(target=work) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)
    assert not any(t.is_alive() for t in threads)
    assert errors == []
