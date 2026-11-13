/**
 * Spec 138 behaviour-parity suite for claim_due_queue_items (real
 * Postgres, SQL level).
 *
 * Every case seeds a small exact fixture, calls the RPC once, and asserts
 * the returned rows, the flipped rows' state, and the deferred rows'
 * exact scheduled_time. Expected values are computed from the documented
 * current semantics (spec 138 parity contract §1–§8), NOT captured from
 * the implementation under test.
 *
 * The suite asserts the CURRENT claim semantics. Cases S2-1..S2-17
 * (appended for S2, can_publish_for count enforcement) assert the
 * count predicate: at-cap unregistered destinations claim zero,
 * registered/admin/marked rows claim normally, the slot and
 * publish-now claims keep their contracts, and the planner uses
 * the usage indexes. Case 9 (3-day
 * rate_limited flip, migration 20261102160000) is NOT pre-fix
 * comparable: the pre-fix body (migrations up to 20261022130000)
 * keyed recovery off the removed cooldown column, so case 9 only
 * passes against the current body. Every other case still passes
 * identically against the pre-fix and current bodies — that is what
 * makes the rest of the suite a parity suite.
 *
 * Cases run inside a single transaction each, seeding timestamps
 * relative to the transaction's now() — the same now() the RPC uses —
 * so release_at expectations are exact to the millisecond.
 *
 * Usage:
 *   CLAIM_RPC_PG_URL=postgres://postgres@/claimrpc138parity?host=<socket dir> \
 *     pnpm --filter @fbuploadpro/worker exec tsx tests/claim-rpc/parity.ts
 * (database must already have bootstrap + migrations applied — see
 * README.md; fixtures.sql from this directory is applied by the runner.)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

const MIN = 60_000;
const HOUR = 60 * MIN;

let checks = 0;
let failures = 0;

function check(cond: boolean, label: string, detail?: string): void {
  checks += 1;
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL: ${label}${detail ? ` (${detail})` : ''}`);
  }
}

function eqTime(actual: Date, expected: Date, label: string): void {
  check(
    actual.getTime() === expected.getTime(),
    label,
    `expected ${expected.toISOString()}, got ${actual.toISOString()}`
  );
}

interface Ctx {
  client: PoolClient;
  now: Date;
}

async function dest(
  ctx: Ctx,
  platform: string,
  n: number,
  opts: { status?: string; metadata?: unknown; rateLimitedAt?: Date | null } = {}
): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT public.claim138_destination($1, $2, $3, $4::jsonb, $5) AS id`,
    [
      platform,
      n,
      opts.status ?? 'active',
      JSON.stringify(opts.metadata ?? {}),
      opts.rateLimitedAt ?? null,
    ]
  );
  return rows[0]?.id as string;
}

async function item(
  ctx: Ctx,
  destinationId: string,
  platform: string,
  n: number,
  opts: {
    kind?: string;
    status?: string;
    scheduled?: Date;
    claimed?: Date | null;
    updated?: Date | null;
  } = {}
): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT public.claim138_item($1, $2, $3, $4, $5, $6, $7, $8) AS id`,
    [
      destinationId,
      platform,
      n,
      opts.kind ?? 'text',
      opts.status ?? 'queued',
      opts.scheduled ?? new Date(ctx.now.getTime() - MIN),
      opts.claimed ?? null,
      opts.updated ?? null,
    ]
  );
  return rows[0]?.id as string;
}

async function logs(
  ctx: Ctx,
  destinationId: string,
  platform: string,
  anchorItem: string,
  result: string,
  count: number,
  at: Date
): Promise<void> {
  await ctx.client.query(`SELECT public.claim138_logs($1, $2, $3, $4, $5, $6)`, [
    destinationId,
    platform,
    anchorItem,
    result,
    count,
    at,
  ]);
}

interface ClaimedRow {
  id: string;
  destination_id: string;
  status: string;
}

async function callRpc(
  ctx: Ctx,
  platform: string,
  laneKindSet: string[] | null,
  limit: number,
  maxPerDestination: number
): Promise<ClaimedRow[]> {
  const { rows } = await ctx.client.query<ClaimedRow>(
    `SELECT * FROM public.claim_due_queue_items($1::public.platform, $2::text[], $3::int, $4::int)`,
    [platform, laneKindSet, limit, maxPerDestination]
  );
  return rows;
}

async function setCount(ctx: Ctx, platform: string, count: number): Promise<void> {
  await ctx.client.query(`SELECT public.claim138_set_count($1, $2)`, [platform, count]);
}

async function usage(
  ctx: Ctx,
  platform: string,
  key: string,
  feature = 'schedule',
  destinationId: string | null = null
): Promise<void> {
  await ctx.client.query(`SELECT public.claim138_usage($1, $2, $3, $4)`, [
    platform,
    key,
    feature,
    destinationId,
  ]);
}

async function markPublishNow(ctx: Ctx, itemId: string): Promise<void> {
  await ctx.client.query(`SELECT public.claim138_mark_publish_now($1)`, [itemId]);
}

async function slotFor(ctx: Ctx, destinationId: string, minutesAgo: number): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO public.posting_slots (destination_id, kind, time_of_day, is_active)
     VALUES ($1::uuid, ARRAY['text'], (now() - ($2 || ' minutes')::interval)::time, true)
     RETURNING id`,
    [destinationId, String(minutesAgo)]
  );
  return rows[0]?.id as string;
}

async function callSlotRpc(
  ctx: Ctx,
  destinationId: string,
  slotId: string
): Promise<{ id: string }[]> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT * FROM public.claim_posting_slot_item($1::uuid, $2::uuid, (now() AT TIME ZONE 'UTC')::date, now())`,
    [destinationId, slotId]
  );
  return rows;
}

async function callPublishNowRpc(ctx: Ctx): Promise<{ id: string }[]> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT * FROM public.claim_publish_now_items(100)`
  );
  return rows;
}

async function itemState(
  ctx: Ctx,
  destinationId: string,
  n: number
): Promise<{ status: string; scheduled_time: Date }> {
  const { rows } = await ctx.client.query<{ status: string; scheduled_time: Date }>(
    `SELECT status, scheduled_time FROM public.queue_items
     WHERE id = public.claim138_item_id($1::uuid, $2::int)`,
    [destinationId, n]
  );
  return rows[0] as { status: string; scheduled_time: Date };
}

async function expectDeferred(
  ctx: Ctx,
  destinationId: string,
  n: number,
  expectedRelease: Date,
  label: string
): Promise<void> {
  const s = await itemState(ctx, destinationId, n);
  check(s.status === 'queued', `${label}: item stays queued`, `status=${s.status}`);
  eqTime(s.scheduled_time, expectedRelease, `${label}: deferred to exact release_at`);
}

async function expectUntouched(
  ctx: Ctx,
  destinationId: string,
  n: number,
  expectedScheduled: Date,
  label: string
): Promise<void> {
  const s = await itemState(ctx, destinationId, n);
  check(s.status === 'queued', `${label}: item stays queued`, `status=${s.status}`);
  eqTime(s.scheduled_time, expectedScheduled, `${label}: scheduled_time unchanged`);
}

/** Anchor item (status 'published') that publish_logs rows attach to. */
async function anchor(ctx: Ctx, destinationId: string, platform: string): Promise<string> {
  return item(ctx, destinationId, platform, 9001, {
    status: 'published',
    scheduled: new Date(ctx.now.getTime() - 48 * HOUR),
  });
}

function at(ctx: Ctx, offsetMs: number): Date {
  return new Date(ctx.now.getTime() + offsetMs);
}

// ---------------------------------------------------------------------------
// Case 1: at-cap deferral to the exact window end (published rule).
// ---------------------------------------------------------------------------
async function case1(ctx: Ctx): Promise<void> {
  const d = await dest(ctx, 'instagram', 1);
  const a = await anchor(ctx, d, 'instagram');
  await logs(ctx, d, 'instagram', a, 'success', 1, at(ctx, -20 * HOUR));
  await logs(ctx, d, 'instagram', a, 'success', 99, at(ctx, -2 * HOUR));
  const due = await item(ctx, d, 'instagram', 1);
  const claimed = await callRpc(ctx, 'instagram', null, 500, 3);
  check(claimed.length === 0, 'c1: nothing claimed', `claimed=${claimed.length}`);
  check(!claimed.some((r) => r.id === due), 'c1: deferred item not re-claimed in same call');
  // Oldest in-window success = now-20h; +24h window = now+4h (past the floor).
  await expectDeferred(ctx, d, 1, at(ctx, 4 * HOUR), 'c1');
}

// ---------------------------------------------------------------------------
// Case 2: the 1-minute floor binds when the window end is sooner.
// ---------------------------------------------------------------------------
async function case2(ctx: Ctx): Promise<void> {
  const d = await dest(ctx, 'threads', 1);
  const a = await anchor(ctx, d, 'threads');
  // 250 successes (threads cap) 30 s before the 24 h window would close.
  await logs(ctx, d, 'threads', a, 'success', 250, at(ctx, -(24 * HOUR - 30_000)));
  await item(ctx, d, 'threads', 1);
  const claimed = await callRpc(ctx, 'threads', null, 500, 3);
  check(claimed.length === 0, 'c2: nothing claimed', `claimed=${claimed.length}`);
  await expectDeferred(ctx, d, 1, at(ctx, MIN), 'c2: release = now + 1 minute floor');
}

// ---------------------------------------------------------------------------
// Case 3: multi-rule binding — release is the MAX across binding rules.
// ---------------------------------------------------------------------------
async function case3(ctx: Ctx): Promise<void> {
  // Destination 1: published release (now+4h) later than calls release (now+10m).
  const d1 = await dest(ctx, 'instagram', 1);
  const a1 = await anchor(ctx, d1, 'instagram');
  await logs(ctx, d1, 'instagram', a1, 'success', 1, at(ctx, -20 * HOUR));
  await logs(ctx, d1, 'instagram', a1, 'success', 99, at(ctx, -2 * HOUR));
  await logs(ctx, d1, 'instagram', a1, 'failure', 25, at(ctx, -50 * MIN));
  await item(ctx, d1, 'instagram', 1);
  // Destination 2: calls release (now+50m) later than published (now+30m).
  const d2 = await dest(ctx, 'instagram', 2);
  const a2 = await anchor(ctx, d2, 'instagram');
  await logs(ctx, d2, 'instagram', a2, 'success', 100, at(ctx, -23.5 * HOUR));
  await logs(ctx, d2, 'instagram', a2, 'failure', 25, at(ctx, -10 * MIN));
  await item(ctx, d2, 'instagram', 1);

  const claimed = await callRpc(ctx, 'instagram', null, 500, 3);
  check(claimed.length === 0, 'c3: nothing claimed', `claimed=${claimed.length}`);
  await expectDeferred(ctx, d1, 1, at(ctx, 4 * HOUR), 'c3 d1 (published MAX)');
  await expectDeferred(ctx, d2, 1, at(ctx, 50 * MIN), 'c3 d2 (calls MAX)');
}

// ---------------------------------------------------------------------------
// Case 4: oldest-event LEAST semantics across logs and in-flight items.
// ---------------------------------------------------------------------------
async function case4(ctx: Ctx): Promise<void> {
  // (i) oldest log earlier than oldest in-flight -> release derives from log.
  const da = await dest(ctx, 'instagram', 1);
  const aa = await anchor(ctx, da, 'instagram');
  await logs(ctx, da, 'instagram', aa, 'success', 1, at(ctx, -20 * HOUR));
  await logs(ctx, da, 'instagram', aa, 'success', 99, at(ctx, -2 * HOUR));
  await item(ctx, da, 'instagram', 500, { status: 'publishing', claimed: at(ctx, -1 * HOUR) });
  await item(ctx, da, 'instagram', 1);
  // (ii) oldest in-flight earlier -> derives from COALESCE(claimed_at, updated_at).
  const db = await dest(ctx, 'instagram', 2);
  const ab = await anchor(ctx, db, 'instagram');
  await logs(ctx, db, 'instagram', ab, 'success', 100, at(ctx, -2 * HOUR));
  await item(ctx, db, 'instagram', 500, { status: 'publishing', claimed: at(ctx, -10 * HOUR) });
  await item(ctx, db, 'instagram', 1);
  // (iii-a) no in-flight side -> derives from logs only.
  const dc = await dest(ctx, 'instagram', 3);
  const ac = await anchor(ctx, dc, 'instagram');
  await logs(ctx, dc, 'instagram', ac, 'success', 1, at(ctx, -20 * HOUR));
  await logs(ctx, dc, 'instagram', ac, 'success', 99, at(ctx, -2 * HOUR));
  await item(ctx, dc, 'instagram', 1);
  // (iii-b) no logs side -> derives from in-flight only (100 in-flight items:
  // counted into BOTH rules; published release now+14h beats the calls floor).
  const dd = await dest(ctx, 'instagram', 4);
  for (let n = 500; n < 600; n += 1) {
    await item(ctx, dd, 'instagram', n, { status: 'publishing', claimed: at(ctx, -10 * HOUR) });
  }
  await item(ctx, dd, 'instagram', 1);
  // (iv) in-flight claimed OUTSIDE every window still counts (no window
  // filter) and can be the oldest event: 99 logs + 1 ancient in-flight =
  // at cap; release would be in the past, so the floor binds exactly.
  const de = await dest(ctx, 'instagram', 5);
  const ae = await anchor(ctx, de, 'instagram');
  await logs(ctx, de, 'instagram', ae, 'success', 99, at(ctx, -2 * HOUR));
  await item(ctx, de, 'instagram', 500, { status: 'publishing', claimed: at(ctx, -48 * HOUR) });
  await item(ctx, de, 'instagram', 1);
  // Control: 99 logs, no in-flight -> under cap, headroom 1 claims one item.
  const df = await dest(ctx, 'instagram', 6);
  const af = await anchor(ctx, df, 'instagram');
  await logs(ctx, df, 'instagram', af, 'success', 99, at(ctx, -2 * HOUR));
  const f1 = await item(ctx, df, 'instagram', 1, { scheduled: at(ctx, -2 * MIN) });
  await item(ctx, df, 'instagram', 2, { scheduled: at(ctx, -1 * MIN) });

  const claimed = await callRpc(ctx, 'instagram', null, 500, 3);
  check(claimed.length === 1, 'c4: only the control item is claimed', `claimed=${claimed.length}`);
  check(claimed[0]?.id === f1, 'c4: control claims its earliest item');
  await expectDeferred(ctx, da, 1, at(ctx, 4 * HOUR), 'c4 (i) log oldest');
  await expectDeferred(ctx, db, 1, at(ctx, 14 * HOUR), 'c4 (ii) in-flight oldest');
  await expectDeferred(ctx, dc, 1, at(ctx, 4 * HOUR), 'c4 (iii-a) logs only');
  await expectDeferred(ctx, dd, 1, at(ctx, 14 * HOUR), 'c4 (iii-b) in-flight only');
  await expectDeferred(ctx, de, 1, at(ctx, MIN), 'c4 (iv) ancient in-flight, floor binds');
  await expectUntouched(ctx, df, 2, at(ctx, -1 * MIN), 'c4 control second item (headroom 1)');
}

// ---------------------------------------------------------------------------
// Case 5: metadata override caps (per destination x rule).
// ---------------------------------------------------------------------------
async function case5(ctx: Ctx): Promise<void> {
  const atCapLogs = async (d: string, a: string): Promise<void> => {
    await logs(ctx, d, 'instagram', a, 'success', 1, at(ctx, -20 * HOUR));
    await logs(ctx, d, 'instagram', a, 'success', 99, at(ctx, -2 * HOUR));
  };
  // Lowered override cap (5) makes 5 logs at-cap.
  const dLow = await dest(ctx, 'instagram', 1, {
    metadata: { claim_limits: [{ metric: 'published', window_seconds: 86400, cap: 5 }] },
  });
  const aLow = await anchor(ctx, dLow, 'instagram');
  await logs(ctx, dLow, 'instagram', aLow, 'success', 1, at(ctx, -20 * HOUR));
  await logs(ctx, dLow, 'instagram', aLow, 'success', 4, at(ctx, -2 * HOUR));
  await item(ctx, dLow, 'instagram', 1);
  // Raised override cap (200) lets an at-default-cap destination claim.
  const dRaise = await dest(ctx, 'instagram', 2, {
    metadata: { claim_limits: [{ metric: 'published', window_seconds: 86400, cap: 200 }] },
  });
  const aRaise = await anchor(ctx, dRaise, 'instagram');
  await atCapLogs(dRaise, aRaise);
  const raiseItem = await item(ctx, dRaise, 'instagram', 1);
  // Non-matching metric (calls cap against the published window) -> ignored.
  const dMetric = await dest(ctx, 'instagram', 3, {
    metadata: { claim_limits: [{ metric: 'calls', window_seconds: 86400, cap: 1 }] },
  });
  const aMetric = await anchor(ctx, dMetric, 'instagram');
  await atCapLogs(dMetric, aMetric);
  await item(ctx, dMetric, 'instagram', 1);
  // Non-matching window_seconds -> ignored.
  const dWindow = await dest(ctx, 'instagram', 4, {
    metadata: { claim_limits: [{ metric: 'published', window_seconds: 3600, cap: 1 }] },
  });
  const aWindow = await anchor(ctx, dWindow, 'instagram');
  await atCapLogs(dWindow, aWindow);
  await item(ctx, dWindow, 'instagram', 1);
  // Malformed: non-numeric cap -> ignored.
  const dBadCap = await dest(ctx, 'instagram', 5, {
    metadata: { claim_limits: [{ metric: 'published', window_seconds: 86400, cap: 'abc' }] },
  });
  const aBadCap = await anchor(ctx, dBadCap, 'instagram');
  await atCapLogs(dBadCap, aBadCap);
  await item(ctx, dBadCap, 'instagram', 1);
  // Malformed: cap = 0 (fails the > 0 guard) -> ignored.
  const dZeroCap = await dest(ctx, 'instagram', 6, {
    metadata: { claim_limits: [{ metric: 'published', window_seconds: 86400, cap: 0 }] },
  });
  const aZeroCap = await anchor(ctx, dZeroCap, 'instagram');
  await atCapLogs(dZeroCap, aZeroCap);
  await item(ctx, dZeroCap, 'instagram', 1);
  // Malformed: claim_limits is not an array -> ignored.
  const dNotArray = await dest(ctx, 'instagram', 7, {
    metadata: { claim_limits: { metric: 'published', window_seconds: 86400, cap: 1 } },
  });
  const aNotArray = await anchor(ctx, dNotArray, 'instagram');
  await atCapLogs(dNotArray, aNotArray);
  await item(ctx, dNotArray, 'instagram', 1);

  const claimed = await callRpc(ctx, 'instagram', null, 500, 3);
  check(claimed.length === 1, 'c5: only the raised-cap destination claims', `claimed=${claimed.length}`);
  check(claimed[0]?.id === raiseItem, 'c5: raised-cap item claimed');
  await expectDeferred(ctx, dLow, 1, at(ctx, 4 * HOUR), 'c5 lowered override binds');
  await expectDeferred(ctx, dMetric, 1, at(ctx, 4 * HOUR), 'c5 non-matching metric ignored');
  await expectDeferred(ctx, dWindow, 1, at(ctx, 4 * HOUR), 'c5 non-matching window ignored');
  await expectDeferred(ctx, dBadCap, 1, at(ctx, 4 * HOUR), 'c5 non-numeric cap ignored');
  await expectDeferred(ctx, dZeroCap, 1, at(ctx, 4 * HOUR), 'c5 zero cap ignored');
  await expectDeferred(ctx, dNotArray, 1, at(ctx, 4 * HOUR), 'c5 non-array claim_limits ignored');
}

// ---------------------------------------------------------------------------
// Case 6: headroom-bounded claiming in pass (c).
// ---------------------------------------------------------------------------
async function case6(ctx: Ctx): Promise<void> {
  const d = await dest(ctx, 'instagram', 1);
  const a = await anchor(ctx, d, 'instagram');
  await logs(ctx, d, 'instagram', a, 'success', 98, at(ctx, -2 * HOUR));
  const ids: string[] = [];
  for (let n = 1; n <= 5; n += 1) {
    ids.push(await item(ctx, d, 'instagram', n, { scheduled: at(ctx, -(6 - n) * MIN) }));
  }
  const d2 = await dest(ctx, 'instagram', 2);
  for (let n = 1; n <= 4; n += 1) {
    await item(ctx, d2, 'instagram', n, { scheduled: at(ctx, -(6 - n) * MIN) });
  }
  const claimed = await callRpc(ctx, 'instagram', null, 500, 3);
  const forD = claimed.filter((r) => r.destination_id === d);
  const forD2 = claimed.filter((r) => r.destination_id === d2);
  check(forD.length === 2, 'c6: headroom 2 bounds the claim to exactly 2', `claimed=${forD.length}`);
  check(
    forD[0]?.id === ids[0] && forD[1]?.id === ids[1],
    'c6: the two earliest items are the ones claimed'
  );
  check(forD2.length === 3, 'c6: p_max_per_destination bounds the uncapped destination at 3', `claimed=${forD2.length}`);
  await expectUntouched(ctx, d, 3, at(ctx, -3 * MIN), 'c6 third item beyond headroom');
}

// ---------------------------------------------------------------------------
// Case 7: calls vs published distinction.
// ---------------------------------------------------------------------------
async function case7(ctx: Ctx): Promise<void> {
  // Failures only: at the calls cap (25 in 1 h), nowhere near published.
  const dFail = await dest(ctx, 'instagram', 1);
  const aFail = await anchor(ctx, dFail, 'instagram');
  await logs(ctx, dFail, 'instagram', aFail, 'failure', 25, at(ctx, -30 * MIN));
  await item(ctx, dFail, 'instagram', 1);
  // One short of the calls cap: headroom 1 claims exactly one of two items.
  const dUnder = await dest(ctx, 'instagram', 2);
  const aUnder = await anchor(ctx, dUnder, 'instagram');
  await logs(ctx, dUnder, 'instagram', aUnder, 'failure', 24, at(ctx, -30 * MIN));
  const underFirst = await item(ctx, dUnder, 'instagram', 1, { scheduled: at(ctx, -2 * MIN) });
  await item(ctx, dUnder, 'instagram', 2, { scheduled: at(ctx, -1 * MIN) });
  // Successes count toward BOTH metrics: 25 successes in 1 h hit calls.
  const dSucc = await dest(ctx, 'instagram', 3);
  const aSucc = await anchor(ctx, dSucc, 'instagram');
  await logs(ctx, dSucc, 'instagram', aSucc, 'success', 25, at(ctx, -30 * MIN));
  await item(ctx, dSucc, 'instagram', 1);

  const claimed = await callRpc(ctx, 'instagram', null, 500, 3);
  check(claimed.length === 1, 'c7: only one item claimed overall', `claimed=${claimed.length}`);
  check(claimed[0]?.id === underFirst, 'c7: the under-cap destination claims its first item');
  await expectDeferred(ctx, dFail, 1, at(ctx, 30 * MIN), 'c7 failures hit the calls cap');
  await expectDeferred(ctx, dSucc, 1, at(ctx, 30 * MIN), 'c7 successes count toward calls too');
  await expectUntouched(ctx, dUnder, 2, at(ctx, -1 * MIN), 'c7 second item held by calls headroom 1');
}

// ---------------------------------------------------------------------------
// Case 8: in-flight (publishing) items count toward both metrics.
// ---------------------------------------------------------------------------
async function case8(ctx: Ctx): Promise<void> {
  const dAt = await dest(ctx, 'instagram', 1);
  const aAt = await anchor(ctx, dAt, 'instagram');
  await logs(ctx, dAt, 'instagram', aAt, 'success', 90, at(ctx, -2 * HOUR));
  for (let n = 500; n < 510; n += 1) {
    await item(ctx, dAt, 'instagram', n, { status: 'publishing', claimed: at(ctx, -3 * HOUR) });
  }
  await item(ctx, dAt, 'instagram', 1);
  const dUnder = await dest(ctx, 'instagram', 2);
  const aUnder = await anchor(ctx, dUnder, 'instagram');
  await logs(ctx, dUnder, 'instagram', aUnder, 'success', 90, at(ctx, -2 * HOUR));
  for (let n = 500; n < 509; n += 1) {
    await item(ctx, dUnder, 'instagram', n, { status: 'publishing', claimed: at(ctx, -3 * HOUR) });
  }
  const underFirst = await item(ctx, dUnder, 'instagram', 1, { scheduled: at(ctx, -2 * MIN) });
  await item(ctx, dUnder, 'instagram', 2, { scheduled: at(ctx, -1 * MIN) });

  const claimed = await callRpc(ctx, 'instagram', null, 500, 3);
  check(claimed.length === 1, 'c8: only the 99-count destination claims one item', `claimed=${claimed.length}`);
  check(claimed[0]?.id === underFirst, 'c8: headroom-1 claim is the earliest item');
  // 90 logs + 10 in-flight = 100 = cap; oldest event is the in-flight claim
  // at now-3h, so release = now-3h + 24h = now+21h.
  await expectDeferred(ctx, dAt, 1, at(ctx, 21 * HOUR), 'c8 logs + in-flight reach the cap');
}

// ---------------------------------------------------------------------------
// Case 9: 3-day rate_limited flip (migration 20261102160000 — the
// cooldown-column recovery it replaces is gone).
// ---------------------------------------------------------------------------
async function case9(ctx: Ctx): Promise<void> {
  const dPast = await dest(ctx, 'facebook', 1, {
    status: 'rate_limited',
    rateLimitedAt: at(ctx, -4 * 24 * HOUR),
  });
  const pastItem = await item(ctx, dPast, 'facebook', 1);
  // Legacy fallback: no anchor at all, updated_at 4 days old. The
  // destinations updated_at trigger would rewrite a plain UPDATE back
  // to now(), so the backdate runs with triggers suspended (superuser
  // rig only) and trigger behaviour is restored before the RPC call.
  const dLegacy = await dest(ctx, 'facebook', 3, { status: 'rate_limited' });
  await ctx.client.query(`SET LOCAL session_replication_role = replica`);
  await ctx.client.query(
    `UPDATE public.destinations SET updated_at = $2 WHERE id = $1`,
    [dLegacy, at(ctx, -4 * 24 * HOUR)]
  );
  await ctx.client.query(`SET LOCAL session_replication_role = origin`);
  const legacyItem = await item(ctx, dLegacy, 'facebook', 1);
  const futureAt = at(ctx, 1 * HOUR);
  const dFuture = await dest(ctx, 'facebook', 2, {
    status: 'rate_limited',
    rateLimitedAt: futureAt,
  });
  await item(ctx, dFuture, 'facebook', 1);

  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  const claimedIds = new Set(claimed.map((c) => c.id));
  check(
    claimed.length === 2 && claimedIds.has(pastItem) && claimedIds.has(legacyItem),
    'c9: anchor-expired and legacy-fallback destinations claim in the same call',
    `claimed=${claimed.length}`
  );
  const { rows: pastRows } = await ctx.client.query<{
    status: string;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT status, metadata FROM public.destinations WHERE id = $1`,
    [dPast]
  );
  check(pastRows[0]?.status === 'active', 'c9: anchor-expired rate_limited destination restored to active');
  check(
    pastRows[0]?.metadata?.rate_limited_at === undefined,
    'c9: anchor cleared on flip'
  );
  const { rows: legacyRows } = await ctx.client.query<{ status: string }>(
    `SELECT status FROM public.destinations WHERE id = $1`,
    [dLegacy]
  );
  check(legacyRows[0]?.status === 'active', 'c9: legacy no-anchor destination restored to active via updated_at fallback');
  const { rows: futureRows } = await ctx.client.query<{
    status: string;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT status, metadata FROM public.destinations WHERE id = $1`,
    [dFuture]
  );
  check(futureRows[0]?.status === 'rate_limited', 'c9: fresh-anchor destination untouched');
  eqTime(
    new Date(futureRows[0]?.metadata?.rate_limited_at as string),
    futureAt,
    'c9: fresh anchor timestamp unchanged'
  );
  await expectUntouched(ctx, dFuture, 1, at(ctx, -1 * MIN), 'c9 fresh-anchor item');
}

// ---------------------------------------------------------------------------
// Case 10: no-rule platform claims exactly as before (no D5 interference).
// ---------------------------------------------------------------------------
async function case10(ctx: Ctx): Promise<void> {
  const d = await dest(ctx, 'facebook', 1);
  const a = await anchor(ctx, d, 'facebook');
  await logs(ctx, d, 'facebook', a, 'success', 50, at(ctx, -30 * MIN));
  for (let n = 1; n <= 10; n += 1) {
    await item(ctx, d, 'facebook', n, { scheduled: at(ctx, -(11 - n) * MIN) });
  }
  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  check(claimed.length === 3, 'c10: facebook claims p_max_per_destination with no cap rows', `claimed=${claimed.length}`);
  await expectUntouched(ctx, d, 4, at(ctx, -7 * MIN), 'c10 fourth item not deferred, just unclaimed');
}

// ---------------------------------------------------------------------------
// Case 11: lane filtering applies to deferral targets and claim selection.
// ---------------------------------------------------------------------------
async function case11(ctx: Ctx): Promise<void> {
  const fastLane = ['text', 'image', 'carousel'];
  const dAt = await dest(ctx, 'instagram', 1);
  const aAt = await anchor(ctx, dAt, 'instagram');
  await logs(ctx, dAt, 'instagram', aAt, 'success', 1, at(ctx, -20 * HOUR));
  await logs(ctx, dAt, 'instagram', aAt, 'success', 99, at(ctx, -2 * HOUR));
  await item(ctx, dAt, 'instagram', 1, { kind: 'text', scheduled: at(ctx, -2 * MIN) });
  await item(ctx, dAt, 'instagram', 2, { kind: 'video', scheduled: at(ctx, -2 * MIN) });
  const dFree = await dest(ctx, 'instagram', 2);
  const freeText = await item(ctx, dFree, 'instagram', 1, { kind: 'text', scheduled: at(ctx, -2 * MIN) });
  await item(ctx, dFree, 'instagram', 2, { kind: 'video', scheduled: at(ctx, -2 * MIN) });

  const claimed = await callRpc(ctx, 'instagram', fastLane, 500, 3);
  check(claimed.length === 1 && claimed[0]?.id === freeText, 'c11: only the fast-lane text item of the free destination claims');
  await expectDeferred(ctx, dAt, 1, at(ctx, 4 * HOUR), 'c11 at-cap fast-lane item deferred');
  await expectUntouched(ctx, dAt, 2, at(ctx, -2 * MIN), 'c11 at-cap heavy-lane item NOT deferred by a fast-lane call');
  await expectUntouched(ctx, dFree, 2, at(ctx, -2 * MIN), 'c11 heavy-lane item not claimed by a fast-lane call');
}

// ---------------------------------------------------------------------------
// Case 12: selection invariants — p_limit clamp at 1000, rank order.
// ---------------------------------------------------------------------------
async function case12(ctx: Ctx): Promise<void> {
  // Rank order: one facebook destination, staggered scheduled_times.
  const d = await dest(ctx, 'facebook', 1);
  const orderedIds: string[] = [];
  for (let n = 1; n <= 5; n += 1) {
    orderedIds.push(await item(ctx, d, 'facebook', n, { scheduled: at(ctx, -(60 - n * 10) * MIN) }));
  }
  const claimedRank = await callRpc(ctx, 'facebook', null, 500, 3);
  check(
    claimedRank.map((r) => r.id).join(',') === orderedIds.slice(0, 3).join(','),
    'c12: claim returns the 3 earliest by (scheduled_time, id), in order'
  );
  // Clamp: 1,100 due youtube items across two destinations, p_limit 5000
  // must clamp to 1000, p_max_per_destination 1000 so the clamp is what binds.
  const y1 = await dest(ctx, 'youtube', 1);
  const y2 = await dest(ctx, 'youtube', 2);
  await ctx.client.query(
    `SELECT public.claim138_item($1, 'youtube', g, 'text', 'queued', $2, NULL, NULL)
     FROM generate_series(1, 600) AS g`,
    [y1, at(ctx, -10 * MIN)]
  );
  await ctx.client.query(
    `SELECT public.claim138_item($1, 'youtube', g, 'text', 'queued', $2, NULL, NULL)
     FROM generate_series(1, 500) AS g`,
    [y2, at(ctx, -10 * MIN)]
  );
  const claimedClamp = await callRpc(ctx, 'youtube', null, 5000, 1000);
  check(claimedClamp.length === 1000, 'c12: p_limit clamps at 1000', `claimed=${claimedClamp.length}`);
  const { rows: remaining } = await ctx.client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.queue_items
     WHERE platform = 'youtube' AND status = 'queued'`
  );
  check(remaining[0]?.n === 100, 'c12: exactly 100 youtube items remain queued', `remaining=${remaining[0]?.n}`);
}

// ---------------------------------------------------------------------------
// S2: can_publish_for count enforcement in the claim RPCs.
// The rig period seeds counts of 5 per platform (claim138_reset);
// each case narrows the facebook cap to 1 where the cap matters.
// ---------------------------------------------------------------------------
async function caseS2DueBelowCap(ctx: Ctx): Promise<void> {
  const d = await dest(ctx, 'facebook', 1);
  const itemId = await item(ctx, d, 'facebook', 1);
  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  check(
    claimed.length === 1 && claimed[0]?.id === itemId,
    's2 due below cap: paid owner claims normally'
  );
}

async function caseS2DueAtCapUnregistered(ctx: Ctx): Promise<void> {
  await setCount(ctx, 'facebook', 1);
  await usage(ctx, 'facebook', 'other-key');
  const d = await dest(ctx, 'facebook', 1);
  await item(ctx, d, 'facebook', 1);
  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  check(claimed.length === 0, 's2 due at cap unregistered: nothing claimed', `claimed=${claimed.length}`);
  await expectUntouched(ctx, d, 1, at(ctx, -MIN), 's2 due at cap unregistered');
}

async function caseS2DueAtCapRegistered(ctx: Ctx): Promise<void> {
  await setCount(ctx, 'facebook', 1);
  await usage(ctx, 'facebook', 'ext-dest-facebook-1');
  const d = await dest(ctx, 'facebook', 1);
  const itemId = await item(ctx, d, 'facebook', 1);
  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  check(
    claimed.length === 1 && claimed[0]?.id === itemId,
    's2 due at cap registered: claims normally'
  );
}

async function caseS2DueRowIdKey(ctx: Ctx): Promise<void> {
  await setCount(ctx, 'facebook', 1);
  const d = await dest(ctx, 'facebook', 1);
  await usage(ctx, 'facebook', d);
  await item(ctx, d, 'facebook', 1);
  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  check(
    claimed.length === 0,
    's2 key agreement: a usage row keyed by the row id alone does not register the destination',
    `claimed=${claimed.length}`
  );
}

async function caseS2DueExpired(ctx: Ctx): Promise<void> {
  await ctx.client.query(`SELECT public.claim138_expire_period()`);
  const d = await dest(ctx, 'facebook', 1);
  await item(ctx, d, 'facebook', 1);
  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  check(claimed.length === 0, 's2 due expired period: nothing claimed', `claimed=${claimed.length}`);
}

async function caseS2DueSuperseded(ctx: Ctx): Promise<void> {
  await ctx.client.query(`SELECT public.claim138_supersede_period()`);
  const d = await dest(ctx, 'facebook', 1);
  await item(ctx, d, 'facebook', 1);
  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  check(
    claimed.length === 0,
    's2 due superseded-only period: nothing claimed',
    `claimed=${claimed.length}`
  );
}

async function caseS2DueAdmin(ctx: Ctx): Promise<void> {
  await ctx.client.query(`SELECT public.claim138_set_role('admin')`);
  await setCount(ctx, 'facebook', 1);
  await usage(ctx, 'facebook', 'other-key');
  const d = await dest(ctx, 'facebook', 1);
  const itemId = await item(ctx, d, 'facebook', 1);
  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  check(
    claimed.length === 1 && claimed[0]?.id === itemId,
    's2 due admin at cap unregistered: claims normally'
  );
}

async function caseS2DueMarked(ctx: Ctx): Promise<void> {
  await setCount(ctx, 'facebook', 1);
  await usage(ctx, 'facebook', 'other-key');
  const d = await dest(ctx, 'facebook', 1);
  const itemId = await item(ctx, d, 'facebook', 1);
  await markPublishNow(ctx, itemId);
  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  check(
    claimed.length === 1 && claimed[0]?.id === itemId,
    's2 due marked publish-now row: exempt from the count half'
  );
}

async function caseS2DueMarkedExpired(ctx: Ctx): Promise<void> {
  // Verifier regression (PR #211 SEND BACK): the marked-row
  // exemption must be from the COUNT half only, not from the
  // period half. A marked row for an expired owner claims nothing
  // — same fixture as the verifier's live proof (expired period
  // + at-cap usage + one marked queued Facebook item).
  await setCount(ctx, 'facebook', 1);
  await usage(ctx, 'facebook', 'other-key');
  await ctx.client.query(`SELECT public.claim138_expire_period()`);
  const d = await dest(ctx, 'facebook', 1);
  const itemId = await item(ctx, d, 'facebook', 1);
  await markPublishNow(ctx, itemId);
  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  check(
    claimed.length === 0,
    's2 due marked publish-now row, expired period: nothing claimed',
    `claimed=${claimed.length}`
  );
}

async function caseS2DueDisconnected(ctx: Ctx): Promise<void> {
  await setCount(ctx, 'facebook', 1);
  const dDisc = await dest(ctx, 'facebook', 9, { status: 'disconnected' });
  await usage(ctx, 'facebook', 'ext-dest-facebook-9', 'schedule', dDisc);
  const d = await dest(ctx, 'facebook', 1);
  const itemId = await item(ctx, d, 'facebook', 1);
  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  check(
    claimed.length === 1 && claimed[0]?.id === itemId,
    's2 due disconnected subtraction: usage below cap, claims normally'
  );
}

async function caseS2DueLegacyPublishNow(ctx: Ctx): Promise<void> {
  await setCount(ctx, 'facebook', 1);
  await usage(ctx, 'facebook', 'other-key');
  await usage(ctx, 'facebook', 'ext-dest-facebook-1', 'publish-now');
  const d = await dest(ctx, 'facebook', 1);
  await item(ctx, d, 'facebook', 1);
  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  check(
    claimed.length === 0,
    's2 due legacy publish-now-only row: does not register, nothing claimed',
    `claimed=${claimed.length}`
  );
}

async function caseS2Downgrade(ctx: Ctx): Promise<void> {
  await setCount(ctx, 'facebook', 1);
  await usage(ctx, 'facebook', 'ext-dest-facebook-1');
  await usage(ctx, 'facebook', 'other-key');
  const dReg = await dest(ctx, 'facebook', 1);
  const regItem = await item(ctx, dReg, 'facebook', 1);
  const dUnreg = await dest(ctx, 'facebook', 2);
  await item(ctx, dUnreg, 'facebook', 1);
  const claimed = await callRpc(ctx, 'facebook', null, 500, 3);
  check(
    claimed.length === 1 && claimed[0]?.id === regItem,
    's2 downgrade: registered claims, unregistered does not',
    `claimed=${claimed.length}`
  );
}

async function caseS2SlotAtCap(ctx: Ctx): Promise<void> {
  await setCount(ctx, 'facebook', 1);
  await usage(ctx, 'facebook', 'other-key');
  const d = await dest(ctx, 'facebook', 1);
  await item(ctx, d, 'facebook', 1);
  const slotId = await slotFor(ctx, d, 2);
  const claimed = await callSlotRpc(ctx, d, slotId);
  check(claimed.length === 0, 's2 slot at cap unregistered: nothing claimed', `claimed=${claimed.length}`);
  const s = await itemState(ctx, d, 1);
  check(s.status === 'queued', 's2 slot at cap unregistered: item stays queued', `status=${s.status}`);
}

async function caseS2SlotRegistered(ctx: Ctx): Promise<void> {
  await setCount(ctx, 'facebook', 1);
  await usage(ctx, 'facebook', 'ext-dest-facebook-1');
  const d = await dest(ctx, 'facebook', 1);
  const itemId = await item(ctx, d, 'facebook', 1);
  const slotId = await slotFor(ctx, d, 2);
  const claimed = await callSlotRpc(ctx, d, slotId);
  check(
    claimed.length === 1 && claimed[0]?.id === itemId,
    's2 slot at cap registered: claims normally'
  );
}

async function caseS2SlotOutsideWindow(ctx: Ctx): Promise<void> {
  const d = await dest(ctx, 'facebook', 1);
  await item(ctx, d, 'facebook', 1);
  const slotId = await slotFor(ctx, d, 30);
  const claimed = await callSlotRpc(ctx, d, slotId);
  check(claimed.length === 0, 's2 slot outside window: nothing claimed', `claimed=${claimed.length}`);
}

async function caseS2PublishNow(ctx: Ctx): Promise<void> {
  await setCount(ctx, 'facebook', 1);
  await usage(ctx, 'facebook', 'other-key');
  const d = await dest(ctx, 'facebook', 1);
  const itemId = await item(ctx, d, 'facebook', 1);
  await markPublishNow(ctx, itemId);
  const claimed = await callPublishNowRpc(ctx);
  check(
    claimed.length === 1 && claimed[0]?.id === itemId,
    's2 publish-now at cap: claims normally (RPC not redefined, uncapped)'
  );
}

async function caseS2Explain(ctx: Ctx): Promise<void> {
  // Scale the usage + periods tables so the planner cannot prefer
  // a sequential scan for a selective (user_id, platform) lookup.
  await ctx.client.query(
    `INSERT INTO public.subscription_usage (user_id, platform, destination_key, feature, section)
     SELECT md5('s2-scale-user-' || g)::uuid, 'facebook', 'key-' || g, 'schedule', 'schedule'
     FROM generate_series(1, 5000) AS g`
  );
  await ctx.client.query(
    `INSERT INTO public.subscription_periods
       (user_id, facebook_count, instagram_count, threads_count, x_count, tiktok_count, youtube_count, starts_at, ends_at, superseded_at)
     SELECT md5('s2-scale-user-' || g)::uuid, 1, 1, 1, 1, 1, 1, now() - interval '1 day', now() + interval '29 days', NULL
     FROM generate_series(1, 2000) AS g`
  );
  await ctx.client.query(`ANALYZE public.subscription_usage`);
  await ctx.client.query(`ANALYZE public.subscription_periods`);
  // A LANGUAGE sql function body is opaque to EXPLAIN (the call
  // plans as a single Result node), so the planner evidence is
  // the EXPLAIN of the predicate's two queries, textually mirrored
  // from can_publish_for, plus the timed claim call below.
  const explainQuery = async (label: string, sql: string): Promise<string> => {
    const { rows } = await ctx.client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS) ${sql}`
    );
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    console.log(`[parity] s2 explain ${label}:\n` + plan);
    return plan;
  };
  const countPlan = await explainQuery(
    'usage count',
    `WITH disconnected AS (
       SELECT d.id, d.platform
       FROM public.destinations d
       JOIN public.workspaces w ON w.id = d.workspace_id
       WHERE w.owner_id = public.claim138_test_id('user', 1)
         AND d.status = 'disconnected'
     )
     SELECT count(*) FROM public.subscription_usage u
     WHERE u.user_id = public.claim138_test_id('user', 1)
       AND u.platform = 'facebook'
       AND u.feature NOT IN ('publish-now', 'instagram-publish-now', 'threads-publish-now')
       AND NOT EXISTS (
         SELECT 1 FROM disconnected d
         WHERE d.id = u.destination_id
           AND d.platform::text = u.platform
       )`
  );
  check(
    !countPlan.includes('Seq Scan on public.subscription_usage'),
    's2 explain: usage count has no sequential scan on subscription_usage'
  );
  check(
    countPlan.includes('idx_subscription_usage_user_platform'),
    's2 explain: the usage count uses the (user_id, platform) index'
  );
  const existsPlan = await explainQuery(
    'registered EXISTS',
    `SELECT EXISTS (
       SELECT 1 FROM public.subscription_usage u
       WHERE u.user_id = public.claim138_test_id('user', 1)
         AND u.platform = 'facebook'
         AND u.destination_key = 'ext-dest-facebook-1'
         AND u.feature NOT IN ('publish-now', 'instagram-publish-now', 'threads-publish-now')
     )`
  );
  check(
    !existsPlan.includes('Seq Scan on public.subscription_usage'),
    's2 explain: registered EXISTS has no sequential scan on subscription_usage'
  );
  check(
    existsPlan.includes('idx_subscription_usage_user_platform'),
    's2 explain: the registered check uses a (user_id, platform, ...) index'
  );
  // Timed claim call on the seeded state: the added predicate must
  // not blow the rig's < 5 s scale bound (the scale suite asserts
  // the same bound at certification shape).
  const d = await dest(ctx, 'facebook', 1);
  await item(ctx, d, 'facebook', 1);
  const claimPlan = await explainQuery(
    'claim call',
    `SELECT * FROM public.claim_due_queue_items('facebook', NULL, 500, 3)`
  );
  const ms = Number(/Execution Time: ([0-9.]+) ms/.exec(claimPlan)?.[1] ?? Number.NaN);
  check(!Number.isNaN(ms) && ms < 5000, 's2 explain: claim call completes in under 5 s', `execution=${ms} ms`);
}

const CASES: Array<[string, (ctx: Ctx) => Promise<void>]> = [
  ['1 at-cap deferral to exact window end', case1],
  ['2 one-minute floor', case2],
  ['3 multi-rule binding (MAX release)', case3],
  ['4 oldest-event LEAST semantics', case4],
  ['5 metadata override caps', case5],
  ['6 headroom-bounded claiming', case6],
  ['7 calls vs published distinction', case7],
  ['8 in-flight counting', case8],
  ['9 rate_limited recovery', case9],
  ['10 no-rule platform', case10],
  ['11 lane filtering', case11],
  ['12 selection invariants (clamp + rank order)', case12],
  ['S2-1 due below cap', caseS2DueBelowCap],
  ['S2-2 due at cap unregistered', caseS2DueAtCapUnregistered],
  ['S2-3 due at cap registered', caseS2DueAtCapRegistered],
  ['S2-4 key agreement (row-id key)', caseS2DueRowIdKey],
  ['S2-5 due expired period', caseS2DueExpired],
  ['S2-6 due superseded-only period', caseS2DueSuperseded],
  ['S2-7 due admin at cap', caseS2DueAdmin],
  ['S2-8 due marked publish-now row', caseS2DueMarked],
  ['S2-9 due disconnected subtraction', caseS2DueDisconnected],
  ['S2-10 due legacy publish-now-only row', caseS2DueLegacyPublishNow],
  ['S2-11 downgrade interplay', caseS2Downgrade],
  ['S2-12 slot at cap unregistered', caseS2SlotAtCap],
  ['S2-13 slot at cap registered', caseS2SlotRegistered],
  ['S2-14 slot outside window', caseS2SlotOutsideWindow],
  ['S2-15 publish-now at cap', caseS2PublishNow],
  ['S2-16 planner evidence (usage indexes)', caseS2Explain],
  ['S2-17 due marked publish-now row, expired period', caseS2DueMarkedExpired],
];

/** S2 race (criterion 11): two concurrent claim calls against the
 * same fixture. At cap both return zero rows; below cap for an
 * already-registered destination the two calls together admit the
 * single item exactly once. Seeds commit first: the concurrent
 * callers run in their own transactions and must see the seed. */
async function raceCheck(pool: Pool): Promise<void> {
  async function seed(cap: number, usageKey: string | null): Promise<string> {
    const seedClient = await pool.connect();
    try {
      await seedClient.query('BEGIN');
      await seedClient.query('SELECT public.claim138_reset()');
      await seedClient.query(`SELECT public.claim138_set_count('facebook', $1)`, [cap]);
      if (usageKey !== null) {
        await seedClient.query(`SELECT public.claim138_usage('facebook', $1)`, [usageKey]);
      }
      const { rows } = await seedClient.query<{ id: string }>(
        `SELECT public.claim138_destination('facebook', 1, 'active', '{}'::jsonb, NULL) AS id`
      );
      const destId = rows[0]?.id as string;
      await seedClient.query(
        `SELECT public.claim138_item($1, 'facebook', 1, 'text', 'queued', NULL, NULL, NULL)`,
        [destId]
      );
      await seedClient.query('COMMIT');
      return destId;
    } catch (err) {
      await seedClient.query('ROLLBACK');
      throw err;
    } finally {
      seedClient.release();
    }
  }
  async function claimTwice(): Promise<number[]> {
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const [r1, r2] = await Promise.all([
        c1.query(`SELECT * FROM public.claim_due_queue_items('facebook', NULL, 500, 3)`),
        c2.query(`SELECT * FROM public.claim_due_queue_items('facebook', NULL, 500, 3)`),
      ]);
      return [r1.rows.length, r2.rows.length];
    } finally {
      c1.release();
      c2.release();
    }
  }
  console.log('[parity] race: concurrent claims at cap');
  await seed(1, 'other-key');
  const [atCapFirst, atCapSecond] = await claimTwice();
  check(atCapFirst === 0, 'race at-cap: first concurrent claim returns zero rows', `claimed=${atCapFirst}`);
  check(atCapSecond === 0, 'race at-cap: second concurrent claim returns zero rows', `claimed=${atCapSecond}`);
  console.log('[parity] race: concurrent claims below cap, registered');
  await seed(1, 'ext-dest-facebook-1');
  const [belowFirst, belowSecond] = await claimTwice();
  const total = belowFirst + belowSecond;
  check(total === 1, 'race below-cap registered: concurrent claims admit the item exactly once', `claimed=${total}`);
}

async function main(): Promise<void> {
  const url = process.env.CLAIM_RPC_PG_URL;
  if (!url) throw new Error('CLAIM_RPC_PG_URL is required');
  const pool = new Pool({ connectionString: url });
  try {
    const fixtures = readFileSync(join(here, 'fixtures.sql'), 'utf8');
    await pool.query(fixtures);
    const { rows: defRows } = await pool.query<{ grouped: boolean }>(
      `SELECT pg_get_functiondef(
         'public.claim_due_queue_items(public.platform, text[], integer, integer)'::regprocedure
       ) ILIKE '%claim138_rule_usage%' AS grouped`
    );
    console.log(
      `[parity] function body under test: ${defRows[0]?.grouped ? 'GROUPED (post-fix, spec 138)' : 'CORRELATED (pre-fix, spec 121)'}`
    );
    for (const [name, fn] of CASES) {
      const client = await pool.connect();
      const failuresBefore = failures;
      try {
        await client.query('BEGIN');
        await client.query('SELECT public.claim138_reset()');
        const { rows } = await client.query<{ now: Date }>('SELECT now() AS now');
        const ctx: Ctx = { client, now: rows[0]?.now as Date };
        console.log(`[parity] case ${name}`);
        await fn(ctx);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        failures += 1;
        console.error(`[parity] case ${name} ERRORED:`, err);
      } finally {
        client.release();
      }
      if (failures === failuresBefore) console.log(`[parity] case ${name}: PASS`);
      else console.error(`[parity] case ${name}: FAIL`);
    }
    await raceCheck(pool);
  } finally {
    await pool.end();
  }
  console.log(`[parity] ${checks} checks, ${failures} failures`);
  if (failures > 0) process.exit(1);
  console.log('[parity] ALL CASES PASS');
}

main().catch((err: unknown) => {
  console.error('[parity] FAILED:', err);
  process.exit(1);
});
