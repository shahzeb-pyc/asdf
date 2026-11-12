// TikTok worker pool (spec scraper-tikwm-first-concurrency §3).
//
// N parallel workers claim TikTok `pending` jobs ONLY, alongside the
// main loop. Ownership split:
// - The pool owns TikTok `pending` claims via the SAME RPC
//   (get_next_pending_adu_config, p_platform='tiktok',
//   FOR UPDATE SKIP LOCKED) — no RPC change, no migration. A config
//   can never be claimed twice: SKIP LOCKED + one claim per worker.
// - The main loop's `pending` rotation EXCLUDES tiktok; its
//   `browser_pending` rotation KEEPS tiktok (the TikTok browser
//   fallback still uses the shared Puppeteer page on the main loop).
// - Pool workers never touch the shared Puppeteer page and never
//   increment the 500-job browser-session restart counter: a pool job
//   runs the TikTok-only path (discovery → upsert + synced, or mark
//   error on failure), no browser.
// - A slow lookup (30s TikWM timeout) blocks only its own worker
//   slot, never the pool: each worker is an independent async loop.
//
// The module takes injected dependencies (claim function, TikTok job
// processor, sleep, logger, shutdown predicate) and imports cleanly
// with no side effects — no top-level main() run — so the spike
// harness and the standalone CI scraper test step (which runs
// without npm install) can import it. Dependency-free: node builtins
// only, like discovery/ytdlp.js and discovery/tikwm.js.
//
// Idle behaviour: after a job finishes, immediately try to claim the
// next; if no TikTok `pending` row exists, sleep 30s before the next
// claim attempt. Shutdown: stop() stops claiming; start()'s promise
// resolves once in-flight jobs finish their upsert/mark step, so a
// claimed config is never stranded in `processing` on shutdown.

export const TIKTOK_POOL_IDLE_MS = 30_000;
export const TIKTOK_POOL_RETRY_MS = 5_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{
 *   concurrency?: number,
 *   claimTikTokJob: () => Promise<{ job: { id: string, source_platform?: string, source_username?: string }, platform?: string } | null>,
 *   processTikTokJob: (job: { id: string, source_username?: string }) => Promise<void>,
 *   sleep?: (ms: number) => Promise<void>,
 *   logger?: Pick<Console, 'log' | 'warn' | 'error'>,
 *   isShutdown?: () => boolean,
 * }} deps
 * @returns {{ start: () => Promise<void[]>, stop: () => void }}
 */
export function createTikTokPool({
  concurrency = 2,
  claimTikTokJob,
  processTikTokJob,
  sleep = defaultSleep,
  logger = console,
  isShutdown = () => false,
}) {
  const workerCount = Math.min(4, Math.max(1, Math.floor(Number(concurrency)) || 2));
  let stopped = false;
  let donePromise = null;

  const isStopped = () => stopped || isShutdown();

  async function workerLoop(workerId) {
    while (!isStopped()) {
      let claimed = null;
      try {
        claimed = await claimTikTokJob();
      } catch (err) {
        logger.error(`❌ TikTok pool worker ${workerId} claim failed:`, err);
        await sleep(TIKTOK_POOL_RETRY_MS);
        continue;
      }

      if (!claimed) {
        await sleep(TIKTOK_POOL_IDLE_MS);
        continue;
      }

      // Defensive gate: the real claim function is scoped to
      // p_platform='tiktok', so a non-TikTok claim cannot happen. If
      // one ever does, it is rejected here — never processed — and
      // the worker moves on instead of touching another platform's
      // job (the stuck-config reset re-queues it after 1h).
      const job = claimed.job ?? claimed;
      const platform = String(job.source_platform || claimed.platform || '').toLowerCase();
      if (platform !== 'tiktok') {
        logger.warn(
          `⚠️ TikTok pool worker ${workerId} skipped a non-TikTok claim (platform: ${platform || 'unknown'}); it was not processed.`,
        );
        await sleep(TIKTOK_POOL_RETRY_MS);
        continue;
      }

      try {
        await processTikTokJob(job);
      } catch (err) {
        logger.error(`❌ TikTok pool worker ${workerId} job ${job.id} failed:`, err);
      }
    }
  }

  return {
    start() {
      if (!donePromise) {
        donePromise = Promise.all(
          Array.from({ length: workerCount }, (_, index) => workerLoop(index + 1)),
        );
      }
      return donePromise;
    },
    stop() {
      stopped = true;
    },
  };
}
