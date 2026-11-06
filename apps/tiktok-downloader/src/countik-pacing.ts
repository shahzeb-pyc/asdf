/**
 * Countik pacing: delay-based rate protection for the Countik fallback.
 *
 * Production evidence: Countik's videoinfo endpoint answers this
 * Worker's (Cloudflare-egress) requests with HTTP 429 — sustained, not
 * a one-off — while tikwm fails nearly every resolve from the same
 * egress (body_code=-1). Without pacing, one tick can fire up to
 * CLAIM_LIMIT back-to-back fallback attempts in a few seconds (the
 * fail-fast path: tikwm fails fast, a 429 fails fast), which is exactly
 * the burst a rate limiter punishes. Pacing does three things:
 *
 * 1. Spacing: at least COUNTIK_FALLBACK_DELAY_MS between consecutive
 *    fallback calls within a tick. The delay is measured between
 *    fallback *starts* (not exist->info inside one resolution): a call
 *    that takes seconds to answer already spaces the next one, so the
 *    delay only bites on the fast-failing burst it exists to slow.
 * 2. Cap: at most COUNTIK_MAX_FALLBACKS_PER_TICK fallback calls in one
 *    tick. Reels past the cap are deferred, not failed (see pipeline).
 * 3. 429 backoff: the first 429 stops further Countik calls for the
 *    rest of that tick, and no Countik call starts for
 *    COUNTIK_429_BACKOFF_MS afterwards. Cross-tick state lives in
 *    `countikPacingState` at module scope: best-effort only, because a
 *    cold Worker isolate starts with no memory of the last tick — the
 *    within-tick block is the guaranteed mechanism, the cross-tick
 *    backoff is what a warm isolate adds.
 *
 * The numbers are a starting point, not a measured limit: Countik
 * publishes no quota, so the tick log (countikFallbacks /
 * countikRateLimited in TickResult) is the instrument that says whether
 * they are enough. If 429s persist under pacing, the follow-up is the
 * proxy route (deliberately NOT built here), not a bigger delay.
 *
 * Retry accounting, corrected: the claim that brought a reel into
 * this tick already consumed one of its 3 download_retries, and the
 * release adds none — the budget is 3 claims. A deferred reel is
 * released through `mark_adu_reel_download_failed` WITHOUT recording
 * a failure (see pipeline): with budget remaining it returns to
 * `pending`, immediately re-claimable; at 3 claims it finalizes to
 * `download_failed`, visible and rescuable by the failed reset. Only
 * a reel whose Countik call actually ran and failed settles through
 * the failed path, with its failure recorded.
 */

export const COUNTIK_FALLBACK_DELAY_MS = 2000;
export const COUNTIK_MAX_FALLBACKS_PER_TICK = 5;
export const COUNTIK_429_BACKOFF_MS = 120_000;

/** Cross-tick 429 state, shared by every pacer in this isolate. */
export interface CountikPacingState {
  /** Epoch ms before which no Countik call may start (429 backoff). */
  blockedUntilMs: number;
}

export const countikPacingState: CountikPacingState = { blockedUntilMs: 0 };

export type CountikAcquireResult =
  | { allowed: true }
  | { allowed: false; reason: 'cap' | 'rate_limited' };

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One tick's Countik gate. Created fresh per tick (see pipeline); the
 * `shared` state is what carries a 429 backoff across ticks in a warm
 * isolate. `now` and `sleep` are injectable so tests drive the timing
 * deterministically instead of waiting out real delays.
 */
export class CountikPacer {
  private calls = 0;
  private rateLimits = 0;
  private blockedThisTick = false;
  private lastCallStartedAtMs: number | null = null;

  constructor(
    private readonly shared: CountikPacingState = countikPacingState,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = sleepMs,
  ) {}

  /** Fallback calls actually made this tick. */
  get callsMade(): number {
    return this.calls;
  }

  /** 429 responses observed this tick (at most one: the first blocks the rest). */
  get rateLimitedCount(): number {
    return this.rateLimits;
  }

  /**
   * Ask to make a Countik fallback call now. Returns false when the
   * tick's cap is reached or this tick already saw a 429 — the caller
   * defers the reel instead of attempting. A cross-tick backoff still
   * in force is waited out (bounded by COUNTIK_429_BACKOFF_MS) and
   * then the call proceeds; the inter-call delay is waited out the
   * same way. The waits themselves add no retry — the claim that
   * brought the reel here already consumed one, and the caller
   * releases a deferred reel through markDownloadFailed, which adds
   * none.
   */
  async acquire(): Promise<CountikAcquireResult> {
    if (this.blockedThisTick) return { allowed: false, reason: 'rate_limited' };
    if (this.calls >= COUNTIK_MAX_FALLBACKS_PER_TICK) return { allowed: false, reason: 'cap' };
    const nowMs = this.now();
    if (nowMs < this.shared.blockedUntilMs) {
      await this.sleep(this.shared.blockedUntilMs - nowMs);
    }
    if (this.lastCallStartedAtMs !== null) {
      const elapsed = this.now() - this.lastCallStartedAtMs;
      if (elapsed < COUNTIK_FALLBACK_DELAY_MS) {
        await this.sleep(COUNTIK_FALLBACK_DELAY_MS - elapsed);
      }
    }
    this.lastCallStartedAtMs = this.now();
    this.calls += 1;
    return { allowed: true };
  }

  /** A Countik call answered 429: stop this tick, back off the next. */
  noteRateLimited(): void {
    this.blockedThisTick = true;
    this.rateLimits += 1;
    this.shared.blockedUntilMs = this.now() + COUNTIK_429_BACKOFF_MS;
  }
}
