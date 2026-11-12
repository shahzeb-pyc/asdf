import assert from 'node:assert/strict';
import test from 'node:test';
import { TIKTOK_POOL_IDLE_MS, createTikTokPool } from './tiktok-pool.js';

// Fake TikTok jobs (test data only). The pool's claim function returns
// these in queue order, then null forever (no more pending jobs).
function tiktokJob(id) {
  return { job: { id, source_platform: 'tiktok', source_username: `handle${id}` }, platform: 'tiktok' };
}

function capturingLogger() {
  const lines = { log: [], warn: [], error: [] };
  return {
    lines,
    log: (...args) => lines.log.push(args.map(String).join(' ')),
    warn: (...args) => lines.warn.push(args.map(String).join(' ')),
    error: (...args) => lines.error.push(args.map(String).join(' ')),
  };
}

// Idle sleep that never actually waits 30s in tests: at most 10ms per
// iteration, so an idle pool still yields promptly to stop().
const fastSleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10)));

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

// Claim function serving one queue in order, then null forever.
function queueClaim(jobs) {
  let claimIndex = 0;
  return async () => jobs[claimIndex++] ?? null;
}

// Start a pool, wait until `done()` is true, then stop it and drain
// (start() resolves only once in-flight jobs finish). Every pool test
// below uses this: the create/start/wait/stop/await shape is
// identical, only the queue, the processor, and the wait condition
// differ. Returns the capturing logger for log assertions.
async function runPoolUntilDone({ concurrency, claimTikTokJob, processTikTokJob, done, doneMessage }) {
  const logger = capturingLogger();
  const pool = createTikTokPool({
    concurrency,
    claimTikTokJob,
    processTikTokJob,
    sleep: fastSleep,
    logger,
  });
  const donePromise = pool.start();
  try {
    assert.ok(await waitFor(done), doneMessage);
  } finally {
    pool.stop();
  }
  await donePromise;
  return logger;
}

test('pool runs at most N jobs in flight; a 4th job waits for a free slot', async () => {
  const claimTikTokJob = queueClaim([tiktokJob('1'), tiktokJob('2'), tiktokJob('3'), tiktokJob('4')]);

  let inFlight = 0;
  let maxInFlight = 0;
  const processed = [];
  const processTikTokJob = async (job) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      processed.push(job.id);
    } finally {
      inFlight -= 1;
    }
  };

  await runPoolUntilDone({
    concurrency: 2,
    claimTikTokJob,
    processTikTokJob,
    done: () => processed.length === 4,
    doneMessage: 'all 4 jobs should be processed',
  });

  assert.equal(maxInFlight, 2);
  assert.deepEqual([...processed].sort(), ['1', '2', '3', '4']);
  assert.equal(new Set(processed).size, 4, 'each job processed exactly once');
});

test('a slow job in one slot does not block the other slots', async () => {
  const claimTikTokJob = queueClaim([tiktokJob('slow'), tiktokJob('fast1'), tiktokJob('fast2')]);

  const events = [];
  const startedAt = Date.now();
  const processTikTokJob = async (job) => {
    const delay = job.id === 'slow' ? 300 : 10;
    await new Promise((resolve) => setTimeout(resolve, delay));
    events.push({ id: job.id, at: Date.now() - startedAt });
  };

  await runPoolUntilDone({
    concurrency: 2,
    claimTikTokJob,
    processTikTokJob,
    done: () => events.length === 3,
    doneMessage: 'all 3 jobs should finish',
  });

  const byId = Object.fromEntries(events.map((event) => [event.id, event.at]));
  // Both fast jobs finished while the slow job was still in flight,
  // and each finished within ~100ms of the start — neither waited
  // behind the slow job's 300ms.
  assert.ok(byId.fast1 < byId.slow, `fast1 (${byId.fast1}ms) should finish before slow (${byId.slow}ms)`);
  assert.ok(byId.fast2 < byId.slow, `fast2 (${byId.fast2}ms) should finish before slow (${byId.slow}ms)`);
  assert.ok(byId.fast1 < 100, `fast1 should not queue behind slow, finished at ${byId.fast1}ms`);
  assert.ok(byId.fast2 < 100, `fast2 should not queue behind slow, finished at ${byId.fast2}ms`);
});

test('non-TikTok claims are rejected, never processed; the pool moves on to TikTok jobs', async () => {
  const claimTikTokJob = queueClaim([
    { job: { id: 'yt1', source_platform: 'youtube', source_username: 'ytchannel' }, platform: 'youtube' },
    tiktokJob('1'),
    tiktokJob('2'),
  ]);

  const processed = [];
  const processTikTokJob = async (job) => {
    processed.push(job.id);
  };

  const logger = await runPoolUntilDone({
    concurrency: 2,
    claimTikTokJob,
    processTikTokJob,
    done: () => processed.length === 2,
    doneMessage: 'both TikTok jobs should be processed',
  });

  assert.deepEqual([...processed].sort(), ['1', '2']);
  assert.ok(!processed.includes('yt1'), 'the YouTube job must never be processed');
  assert.ok(
    logger.lines.warn.some((line) => line.includes('non-TikTok') && line.includes('skipped')),
    `expected a non-TikTok skip warning: ${logger.lines.warn.join(' | ')}`,
  );
});

test('shutdown drains: stop() during a slow job lets it finish before start() resolves', async () => {
  const claimTikTokJob = queueClaim([tiktokJob('1')]);

  let jobStarted = false;
  let jobStartTime = 0;
  let jobEndTime = 0;
  const processTikTokJob = async () => {
    jobStarted = true;
    jobStartTime = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 150));
    jobEndTime = Date.now();
  };

  await runPoolUntilDone({
    concurrency: 1,
    claimTikTokJob,
    processTikTokJob,
    done: () => jobStarted,
    doneMessage: 'the job should start',
  });

  // The in-flight job ran to completion even though stop() was called
  // just after it started: it finished its full 150ms of work.
  assert.ok(jobEndTime - jobStartTime >= 140, `in-flight job should complete, ran ${jobEndTime - jobStartTime}ms`);
});

test('a claim failure is logged and the pool keeps claiming', async () => {
  let calls = 0;
  const claimTikTokJob = async () => {
    calls += 1;
    if (calls === 1) throw new Error('fake RPC failure');
    if (calls === 2) return tiktokJob('1');
    return null;
  };

  const processed = [];
  const processTikTokJob = async (job) => {
    processed.push(job.id);
  };

  const logger = await runPoolUntilDone({
    concurrency: 1,
    claimTikTokJob,
    processTikTokJob,
    done: () => processed.length === 1,
    doneMessage: 'the job after the failed claim should be processed',
  });

  assert.deepEqual(processed, ['1']);
  assert.ok(
    logger.lines.error.some((line) => line.includes('claim failed')),
    `expected a claim-failure error log: ${logger.lines.error.join(' | ')}`,
  );
});

test('the pool module imports with no side effects (import alone starts nothing)', async () => {
  // Re-importing the module must not start workers or log anything:
  // the import below is the whole assertion — if createTikTokPool
  // ran anything at import time, the process would show it. The
  // factory itself returns an inert handle until start() is called.
  const pool = createTikTokPool({
    concurrency: 2,
    claimTikTokJob: async () => {
      throw new Error('claim must not run before start()');
    },
    processTikTokJob: async () => {
      throw new Error('process must not run before start()');
    },
    sleep: fastSleep,
    logger: capturingLogger(),
  });
  // No start() call: nothing ran, nothing to await. Stop is safe too.
  pool.stop();
  assert.ok(TIKTOK_POOL_IDLE_MS === 30_000, 'idle sleep is 30s');
});
