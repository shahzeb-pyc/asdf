/**
 * Spec 139 settle-rpc assertion suite (real PostgreSQL, SQL level).
 *
 * Run against a database with bootstrap + ALL repo migrations applied
 * (incl. 20261023130000_settle_rpc_hardening.sql) — see README.md.
 * Asserts, for the UNIFIED settle_queue_item_outcome overload:
 *   (a) exactly ONE overload exists after the chain — the unified
 *       17-arg form carrying p_detail. The old 16-arg TEXT-code
 *       signature is gone, and the legacy INT-code overload was
 *       dropped by exact signature in the Phase 7 migration
 *       (20261024130000) — with service_role-only ACLs and a pinned
 *       search_path on the survivor;
 *   (b) EXECUTE is denied to authenticated + anon (42501) and allowed
 *       to service_role;
 *   (c) a normal settle works (published + retry branches), writes
 *       exactly one publish_logs row, and returns 'settled';
 *   (d) existing callers still work unchanged: a call with the original
 *       16 NAMED arguments (PostgREST style, no p_detail) and a call
 *       with 16 POSITIONAL arguments (load-harness pg-adapter style);
 *   (e) double-settle no-ops: a second settle of a terminal item, a
 *       settle of a merely-queued item, and a settle of a missing item
 *       all return 'already_settled' with no status regression, no
 *       second publish_logs row and no destination side effect;
 *   (f) NO destination cooldown is written by any settle (migration
 *       20261102160000): a caller-supplied cooldown value is accepted
 *       and IGNORED, and marking rate_limited stamps the 3-day anchor
 *       metadata.rate_limited_at instead;
 *   (g) p_detail lands in publish_logs.detail merged with (and losing
 *       key conflicts to) the existing error-code object; p_detail NULL
 *       preserves the pre-existing detail behaviour exactly;
 *   (h) the `deferred` outcome (spec 139 defer outcome, migration
 *       20261024100000): the item returns to `queued` with the deferral
 *       reason recorded and its retry_count UNCHANGED — even when the
 *       caller passes an inflated p_retry_count — across repeated
 *       defers; the publish log records result 'deferred' with p_detail
 *       merged; the [139-1] terminal-state guard holds for defers and
 *       defers write no destination cooldown or anchor; the `queued`
 *       (retry) branch still advances the count (branches stay
 *       distinct).
 *
 * Usage:
 *   SETTLE_RPC_PG_URL=postgres://postgres@/settle139?host=<socket dir>&port=<port> \
 *     pnpm --filter @fbuploadpro/worker exec tsx tests/settle-rpc/check.ts
 * (fixtures.sql from this directory is applied by the runner.)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

const WS_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DEST = 'f0000000-0000-0000-0000-000000000002';
const ITEM_MAIN = 'f0000000-0000-0000-0000-000000000003';
const ITEM_B = 'f0000000-0000-0000-0000-000000000013';
const ITEM_C = 'f0000000-0000-0000-0000-000000000023';
const ITEM_D = 'f0000000-0000-0000-0000-000000000033';
const ITEM_MISSING = 'f0000000-0000-0000-0000-000000000099';

type Role = 'authenticated' | 'anon' | 'service_role';

let checks = 0;
let failures = 0;

function check(cond: boolean, label: string, detail?: string): void {
  checks += 1;
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failures += 1;
    const suffix = detail ? ' (' + detail + ')' : '';
    console.error(`  FAIL: ${label}${suffix}`);
  }
}

interface Attempt {
  ok: boolean;
  code: string | undefined;
  message: string | undefined;
  value: string | null;
}

/** Runs fn in one transaction as the given role; commits on request. */
async function asRole(
  pool: Pool,
  role: Role,
  fn: (client: PoolClient) => Promise<void>,
  opts: { commit?: boolean } = {}
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', '', true)`);
    await fn(client);
    await client.query(opts.commit ? 'COMMIT' : 'ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const SETTLE_SQL_17 = `SELECT public.settle_queue_item_outcome(
  $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
  $7::int, $8::int, $9::text, $10::text, $11::text, $12::text,
  $13::text, $14::text, $15::int, $16::smallint, $17::jsonb) AS outcome`;

interface SettleArgs {
  item?: string;
  outcome?: string;
  externalPostId?: string | null;
  retryCount?: number;
  errorCode?: string | null;
  errorSubcode?: string | null;
  errorMessage?: string | null;
  targetDestinationStatus?: string | null;
  cooldownSeconds?: number | null;
  detail?: Record<string, unknown> | null;
}

function settleParams(a: SettleArgs): unknown[] {
  return [
    a.item ?? ITEM_MAIN,
    WS_A,
    DEST,
    a.outcome ?? 'published',
    a.externalPostId ?? null,
    null, // p_external_comment_id
    a.retryCount ?? 0,
    300, // p_retry_delay_seconds
    a.errorCode ?? null,
    a.errorSubcode ?? null,
    a.errorMessage ?? null,
    null, // p_comment_warning
    a.targetDestinationStatus ?? null,
    null, // p_target_account_status
    a.cooldownSeconds ?? null, // p_destination_cooldown_seconds: RETAINED BUT IGNORED (20261102160000 compat shim)
    null, // p_rate_usage_pct
    a.detail ? JSON.stringify(a.detail) : null,
  ];
}

/** Committed settle as service_role; returns the function's TEXT result. */
async function settle(pool: Pool, a: SettleArgs): Promise<string | null> {
  let value: string | null = null;
  await asRole(
    pool,
    'service_role',
    async (client) => {
      const res = await client.query<{ outcome: string | null }>(SETTLE_SQL_17, settleParams(a) as never[]);
      value = res.rows[0]?.outcome ?? null;
    },
    { commit: true }
  );
  return value;
}

/** Single settle attempt in a rolled-back transaction (ACL probes). */
async function attempt(pool: Pool, role: Role, a: SettleArgs): Promise<Attempt> {
  let result: Attempt = { ok: false, code: undefined, message: undefined, value: null };
  try {
    await asRole(pool, role, async (client) => {
      try {
        const res = await client.query<{ outcome: string | null }>(SETTLE_SQL_17, settleParams(a) as never[]);
        result = { ok: true, code: undefined, message: undefined, value: res.rows[0]?.outcome ?? null };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        result = { ok: false, code: e.code, message: e.message, value: null };
      }
    });
  } catch (err) {
    if (!result.ok && !result.code) throw err;
  }
  return result;
}

async function reset(pool: Pool): Promise<void> {
  await pool.query('SELECT public.settle139_reset()');
}

async function addItem(pool: Pool, id: string, status: string): Promise<void> {
  await pool.query('SELECT public.settle139_add_item($1::uuid, $2::text)', [id, status]);
}

async function itemRow(pool: Pool, id: string): Promise<Record<string, unknown> | undefined> {
  const res = await pool.query('SELECT * FROM public.queue_items WHERE id = $1::uuid', [id]);
  return res.rows[0] as Record<string, unknown> | undefined;
}

async function logRows(pool: Pool, id: string): Promise<Record<string, unknown>[]> {
  const res = await pool.query(
    'SELECT * FROM public.publish_logs WHERE queue_item_id = $1::uuid ORDER BY created_at, id',
    [id]
  );
  return res.rows as Record<string, unknown>[];
}

async function destRow(pool: Pool): Promise<Record<string, unknown>> {
  const res = await pool.query('SELECT * FROM public.destinations WHERE id = $1::uuid', [DEST]);
  return res.rows[0] as Record<string, unknown>;
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(String(v));
}

async function sectionCatalog(pool: Pool): Promise<void> {
  console.log('\n(a) catalog: single unified overload, ACLs, search_path');
  const all = await pool.query<{ args: string; acl: string; config: string[] | null }>(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args,
            COALESCE(p.proacl::text, '(default: EXECUTE TO PUBLIC)') AS acl,
            p.proconfig AS config
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname = 'settle_queue_item_outcome'
      ORDER BY args`
  );
  check(all.rows.length === 1, `exactly 1 settle overload exists (unified only — legacy dropped in Phase 7), got ${all.rows.length}`);
  const unified = all.rows.filter((r) => r.args.includes('p_detail jsonb'));
  check(unified.length === 1, 'exactly ONE unified overload (carrying p_detail jsonb) exists', JSON.stringify(all.rows.map((r) => r.args)));
  const legacy = all.rows.filter((r) => r.args.includes('p_error_code integer'));
  check(legacy.length === 0, 'legacy INT-code overload absent (dropped by exact signature in Phase 7)');
  const u = unified[0];
  if (u) {
    check(u.acl.includes('service_role=X/'), 'unified ACL grants EXECUTE to service_role', u.acl);
    check(!u.acl.includes('authenticated=') && !u.acl.includes('anon=') && !u.acl.startsWith('{=X'), 'unified ACL has no PUBLIC/anon/authenticated EXECUTE', u.acl);
    check((u.config ?? []).includes('search_path=public'), 'unified search_path pinned to public', JSON.stringify(u.config));
  }
}

async function sectionAcl(pool: Pool): Promise<void> {
  console.log('\n(b) EXECUTE lockdown');
  await reset(pool);
  const auth = await attempt(pool, 'authenticated', { outcome: 'published', externalPostId: 'x' });
  check(!auth.ok && auth.code === '42501', 'settle denied to authenticated (42501)', auth.ok ? 'call succeeded' : `${auth.code} ${auth.message}`);
  const anon = await attempt(pool, 'anon', { outcome: 'published', externalPostId: 'x' });
  check(!anon.ok && anon.code === '42501', 'settle denied to anon (42501)', anon.ok ? 'call succeeded' : `${anon.code} ${anon.message}`);
  const svc = await settle(pool, { outcome: 'published', externalPostId: 'post-acl' });
  check(svc === 'settled', 'settle executable by service_role', `got ${svc}`);
}

async function sectionNormal(pool: Pool): Promise<void> {
  console.log('\n(c) normal settle');
  await reset(pool);
  const r1 = await settle(pool, { outcome: 'published', externalPostId: 'post-1' });
  check(r1 === 'settled', "published settle returns 'settled'", `got ${r1}`);
  const item = await itemRow(pool, ITEM_MAIN);
  check(item?.status === 'published' && item?.external_post_id === 'post-1', 'item is published with the external post id');
  const logs = await logRows(pool, ITEM_MAIN);
  check(logs.length === 1 && logs[0]?.result === 'success', 'exactly one publish_logs row (result=success)', `got ${logs.length}`);
  check(logs[0]?.detail === null || logs[0]?.detail === undefined, 'detail is NULL when neither p_detail nor error codes are given');

  await reset(pool);
  const r2 = await settle(pool, { outcome: 'queued', retryCount: 1, errorCode: 'E1', errorMessage: 'try later' });
  check(r2 === 'settled', "retry settle returns 'settled'", `got ${r2}`);
  const item2 = await itemRow(pool, ITEM_MAIN);
  check(item2?.status === 'queued' && item2?.retry_count === 1 && item2?.claimed_at === null, 'item re-queued with retry_count=1 and claimed_at cleared');
  const logs2 = await logRows(pool, ITEM_MAIN);
  check(logs2.length === 1 && logs2[0]?.result === 'retry', 'retry settle wrote exactly one publish_logs row (result=retry)');
}

async function sectionOldCallers(pool: Pool): Promise<void> {
  console.log('\n(d) existing 16-arg callers (no p_detail)');
  await reset(pool);
  let named: string | null = null;
  await asRole(
    pool,
    'service_role',
    async (client) => {
      const res = await client.query<{ outcome: string | null }>(
        `SELECT public.settle_queue_item_outcome(
           p_queue_item_id => $1::uuid, p_workspace_id => $2::uuid, p_destination_id => $3::uuid,
           p_outcome_status => 'published', p_external_post_id => 'post-named',
           p_external_comment_id => NULL, p_retry_count => 0, p_retry_delay_seconds => 300,
           p_error_code => NULL, p_error_subcode => NULL, p_error_message => NULL,
           p_comment_warning => NULL, p_target_destination_status => NULL,
           p_target_account_status => NULL, p_destination_cooldown_seconds => NULL,
           p_rate_usage_pct => NULL) AS outcome`,
        [ITEM_MAIN, WS_A, DEST]
      );
      named = res.rows[0]?.outcome ?? null;
    },
    { commit: true }
  );
  check(named === 'settled', "16 NAMED args (PostgREST style) still resolve and return 'settled'", `got ${named}`);
  check((await logRows(pool, ITEM_MAIN)).length === 1, 'named-args settle wrote its publish_logs row');

  await reset(pool);
  let positional: string | null = null;
  await asRole(
    pool,
    'service_role',
    async (client) => {
      const res = await client.query<{ outcome: string | null }>(
        `SELECT public.settle_queue_item_outcome(
           $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text,
           $7::int, $8::int, $9::text, $10::text, $11::text, $12::text,
           $13::text, $14::text, $15::int, $16::smallint) AS outcome`,
        settleParams({ outcome: 'published', externalPostId: 'post-pos' }).slice(0, 16) as never[]
      );
      positional = res.rows[0]?.outcome ?? null;
    },
    { commit: true }
  );
  check(positional === 'settled', "16 POSITIONAL args (pg-adapter style) still resolve and return 'settled'", `got ${positional}`);
  check((await itemRow(pool, ITEM_MAIN))?.status === 'published', 'positional settle published the item');
}

async function sectionDoubleSettle(pool: Pool): Promise<void> {
  console.log('\n(e) double-settle no-op');
  await reset(pool);
  const first = await settle(pool, { outcome: 'published', externalPostId: 'post-1', cooldownSeconds: 300 });
  check(first === 'settled', 'first settle applies', `got ${first}`);
  const destAfterFirst = await destRow(pool);
  const second = await settle(pool, {
    outcome: 'failed', retryCount: 9, errorCode: '190', errorMessage: 'late duplicate failure',
  });
  check(second === 'already_settled', "second settle returns 'already_settled'", `got ${second}`);
  const item = await itemRow(pool, ITEM_MAIN);
  check(item?.status === 'published' && item?.external_post_id === 'post-1' && item?.error_message === null,
    'terminal item not regressed (still published, original post id, no error)');
  check((await logRows(pool, ITEM_MAIN)).length === 1, 'no second publish_logs row inserted');
  const destAfterSecond = await destRow(pool);
  check(
    JSON.stringify(destAfterSecond.metadata) === JSON.stringify(destAfterFirst.metadata)
      && destAfterSecond.status === destAfterFirst.status,
    'no destination side effect from the duplicate settle'
  );

  await addItem(pool, ITEM_B, 'queued');
  const queuedSettle = await settle(pool, { item: ITEM_B, outcome: 'failed', errorMessage: 'dlq late settle' });
  check(queuedSettle === 'already_settled', "settle of a merely-queued item returns 'already_settled'", `got ${queuedSettle}`);
  check((await itemRow(pool, ITEM_B))?.status === 'queued', 'queued item status untouched');
  check((await logRows(pool, ITEM_B)).length === 0, 'no publish_logs row for the queued item');

  const missing = await settle(pool, { item: ITEM_MISSING, outcome: 'published', externalPostId: 'ghost' });
  check(missing === 'already_settled', "settle of a missing item returns 'already_settled' (no error)", `got ${missing}`);
  check((await logRows(pool, ITEM_MISSING)).length === 0, 'no publish_logs row for the missing item');
}

async function sectionCooldown(pool: Pool): Promise<void> {
  console.log('\n(f) no destination cooldown (20261102160000: pacing removed)');
  await reset(pool);
  // An old caller passing a cooldown value must settle fine — and the
  // value must be IGNORED: the column is gone, nothing is written.
  const t0 = Date.now();
  const r = await settle(pool, { outcome: 'published', externalPostId: 'post-nocd', cooldownSeconds: 300 });
  check(r === 'settled', 'settle carrying a cooldown value still settles', `got ${r}`);
  const destAfter = await destRow(pool);
  check(destAfter.status === 'active', 'published settle with a cooldown value leaves the destination active');
  check(
    (destAfter.metadata as Record<string, unknown> | null)?.rate_limited_at === undefined,
    'published settle stamps no rate-limit anchor'
  );

  // Marking rate_limited stamps the anchor but writes no cooldown.
  await reset(pool);
  const r2 = await settle(pool, {
    outcome: 'failed', errorCode: 'x_rate', errorMessage: 'throttled',
    targetDestinationStatus: 'rate_limited', cooldownSeconds: 259200,
  });
  check(r2 === 'settled', 'rate_limited settle applies', `got ${r2}`);
  const destRl = await destRow(pool);
  check(destRl.status === 'rate_limited', 'rate_limited settle flips the destination status');
  const anchor = asDate((destRl.metadata as Record<string, unknown> | null)?.rate_limited_at);
  check(
    anchor !== null && anchor.getTime() >= t0 && anchor.getTime() <= Date.now(),
    'rate_limited settle stamps a fresh metadata.rate_limited_at anchor',
    String((destRl.metadata as Record<string, unknown> | null)?.rate_limited_at)
  );

  // A second rate_limited settle re-stamps the anchor (window restarts).
  await pool.query("UPDATE public.queue_items SET status = 'publishing' WHERE id = $1::uuid", [ITEM_MAIN]);
  await settle(pool, { outcome: 'failed', errorCode: 'x_rate', targetDestinationStatus: 'rate_limited', cooldownSeconds: 60 });
  const destRl2 = await destRow(pool);
  const anchor2 = asDate((destRl2.metadata as Record<string, unknown> | null)?.rate_limited_at);
  check(
    anchor2 !== null && anchor !== null && anchor2.getTime() >= anchor.getTime(),
    'repeat rate_limited marking re-stamps the anchor (never earlier)',
    `${anchor?.toISOString()} -> ${anchor2?.toISOString()}`
  );
}

async function sectionDetail(pool: Pool): Promise<void> {
  console.log('\n(g) p_detail carrier');
  await reset(pool);
  await settle(pool, {
    outcome: 'failed', retryCount: 1, errorCode: '190', errorSubcode: '463', errorMessage: 'token expired',
    detail: { sessionId: 'sess_123', provider: 'facebook' },
  });
  const logs = await logRows(pool, ITEM_MAIN);
  const d1 = logs[0]?.detail as Record<string, unknown> | null;
  check(
    d1?.sessionId === 'sess_123' && d1?.provider === 'facebook' && d1?.errorCode === '190' && d1?.errorSubcode === '463',
    'p_detail merged into publish_logs.detail alongside the error-code object',
    JSON.stringify(d1)
  );

  await addItem(pool, ITEM_B, 'publishing');
  await settle(pool, { item: ITEM_B, outcome: 'published', externalPostId: 'post-sess', detail: { sessionId: 'sess_999' } });
  const logsB = await logRows(pool, ITEM_B);
  const d2 = logsB[0]?.detail as Record<string, unknown> | null;
  check(
    d2 !== null && Object.keys(d2).length === 1 && d2.sessionId === 'sess_999',
    'p_detail survives an error-free published settle (session-id carrier case)',
    JSON.stringify(d2)
  );

  await addItem(pool, ITEM_C, 'publishing');
  await settle(pool, { item: ITEM_C, outcome: 'failed', retryCount: 1, errorCode: '190', errorSubcode: '463', errorMessage: 'x' });
  const logsC = await logRows(pool, ITEM_C);
  const d3 = logsC[0]?.detail as Record<string, unknown> | null;
  check(
    d3 !== null && Object.keys(d3).length === 2 && d3.errorCode === '190' && d3.errorSubcode === '463',
    'p_detail NULL preserves the pre-existing detail (error-code object only)',
    JSON.stringify(d3)
  );

  await addItem(pool, ITEM_D, 'publishing');
  await settle(pool, {
    item: ITEM_D, outcome: 'failed', retryCount: 1, errorCode: '190', errorMessage: 'x',
    detail: { errorCode: 'spoof', sessionId: 's1' },
  });
  const logsD = await logRows(pool, ITEM_D);
  const d4 = logsD[0]?.detail as Record<string, unknown> | null;
  check(
    d4?.errorCode === '190' && d4?.sessionId === 's1',
    'on key conflict the error-code object wins over p_detail',
    JSON.stringify(d4)
  );
}

async function sectionDeferred(pool: Pool): Promise<void> {
  console.log('\n(h) deferred outcome leaves retry_count unchanged');
  await reset(pool);
  // Seed a mid-life item: two real attempts already burned.
  await pool.query('UPDATE public.queue_items SET retry_count = 2 WHERE id = $1::uuid', [ITEM_MAIN]);

  // Defer #1 — the caller deliberately passes an inflated count (99):
  // the deferred branch must ignore it for the stored count.
  const r1 = await settle(pool, {
    outcome: 'deferred', retryCount: 99, errorCode: 'publishing_limit_reached',
    errorMessage: 'This account has reached its publishing limit for now.',
    cooldownSeconds: 3600,
    detail: { platform: 'instagram', publishingLimit: { usage: 50 } },
  });
  check(r1 === 'settled', 'deferred settle returns settled', String(r1));
  const item1 = await itemRow(pool, ITEM_MAIN);
  check(item1?.status === 'queued', 'deferred item returns to queued', String(item1?.status));
  check(
    item1?.retry_count === 2,
    'deferred settle leaves retry_count unchanged (caller passed 99)',
    String(item1?.retry_count)
  );
  check(item1?.claimed_at === null, 'deferred settle clears the claim', String(item1?.claimed_at));
  check(
    item1?.error_code === 'publishing_limit_reached',
    'deferred settle records the deferral reason on the item',
    String(item1?.error_code)
  );
  // BG3 (audit owner decision 2026-10-30, 1A): a deferred FACEBOOK item
  // must NOT be rescheduled into the future — that would make it
  // due-claimable off-schedule. It returns to the slot pool with
  // scheduled_time NULL and is picked up only by claim_posting_slot_item
  // at a later posting slot. The old spec-139 "rescheduled into the
  // future" expectation is superseded for this Facebook fixture; other
  // platforms keep the future timestamp (see the settle migration).
  const sched1 = asDate(item1?.scheduled_time);
  check(
    sched1 === null,
    'deferred Facebook item returns to the slot pool (scheduled_time NULL, not rescheduled into the future)',
    String(item1?.scheduled_time)
  );
  const logs1 = await logRows(pool, ITEM_MAIN);
  check(logs1.length === 1, 'deferred settle writes exactly one publish_logs row', String(logs1.length));
  check(
    logs1[0]?.result === 'deferred',
    "publish log records the deferral with result 'deferred'",
    String(logs1[0]?.result)
  );
  const dd = logs1[0]?.detail as Record<string, unknown> | null;
  check(
    dd?.errorCode === 'publishing_limit_reached' && dd?.platform === 'instagram',
    'deferral log detail merges p_detail with the error-code object',
    JSON.stringify(dd)
  );
  const dest1 = await destRow(pool);
  check(
    dest1.status === 'active' &&
      (dest1.metadata as Record<string, unknown> | null)?.rate_limited_at === undefined,
    'deferred settle writes no destination cooldown or anchor (the X 402 path passes a value that is now ignored)',
    JSON.stringify(dest1.metadata)
  );

  // Defer #2 and #3 (item re-claimed to 'publishing' between passes):
  // repeated deferrals — e.g. a cap that stays hit for hours — must
  // never grind the count up.
  for (let pass = 2; pass <= 3; pass += 1) {
    await pool.query(
      "UPDATE public.queue_items SET status = 'publishing', claimed_at = now() WHERE id = $1::uuid",
      [ITEM_MAIN]
    );
    await settle(pool, {
      outcome: 'deferred', retryCount: 99, errorCode: 'publishing_limit_reached',
      errorMessage: 'still capped',
    });
    const itemN = await itemRow(pool, ITEM_MAIN);
    check(
      itemN?.retry_count === 2,
      `retry_count still unchanged after defer #${pass}`,
      String(itemN?.retry_count)
    );
  }
  const logsAll = await logRows(pool, ITEM_MAIN);
  check(
    logsAll.length === 3 && logsAll.every((l) => l.result === 'deferred'),
    'each deferral logged exactly one deferred row',
    String(logsAll.length)
  );

  // No destination side effect from defers, even with a cooldown value:
  const destBefore = await destRow(pool);
  await pool.query(
    "UPDATE public.queue_items SET status = 'publishing', claimed_at = now() WHERE id = $1::uuid",
    [ITEM_MAIN]
  );
  await settle(pool, { outcome: 'deferred', retryCount: 2, errorCode: 'x', cooldownSeconds: 60 });
  const destAfter = await destRow(pool);
  check(
    destAfter.status === destBefore.status &&
      JSON.stringify(destAfter.metadata) === JSON.stringify(destBefore.metadata),
    'a defer carrying a cooldown value leaves the destination untouched',
    `${String(destBefore.status)} -> ${String(destAfter.status)}`
  );

  // [139-1] guard holds for defers: a terminal item no-ops.
  await addItem(pool, ITEM_B, 'published');
  const rTerm = await settle(pool, {
    item: ITEM_B, outcome: 'deferred', retryCount: 0, errorCode: 'publishing_limit_reached',
  });
  check(rTerm === 'already_settled', 'defer of a terminal item returns already_settled', String(rTerm));
  const logsB = await logRows(pool, ITEM_B);
  check(logsB.length === 0, 'defer of a terminal item writes no publish_logs row', String(logsB.length));
  const itemB = await itemRow(pool, ITEM_B);
  check(itemB?.status === 'published', 'terminal item untouched by a defer', String(itemB?.status));

  // Branch distinctness regression: the retry branch still advances
  // the stored count from p_retry_count.
  await addItem(pool, ITEM_C, 'publishing');
  await pool.query('UPDATE public.queue_items SET retry_count = 1 WHERE id = $1::uuid', [ITEM_C]);
  await settle(pool, { item: ITEM_C, outcome: 'queued', retryCount: 2, errorCode: 'transient' });
  const itemC = await itemRow(pool, ITEM_C);
  check(
    itemC?.retry_count === 2 && itemC?.status === 'queued',
    'retry branch still advances retry_count (branches stay distinct)',
    String(itemC?.retry_count)
  );
  const logsC = await logRows(pool, ITEM_C);
  check(logsC[0]?.result === 'retry', "retry branch still logs result 'retry'", String(logsC[0]?.result));
}

async function dump(pool: Pool): Promise<string> {
  const fns = await pool.query<{ args: string; acl: string; rettype: string }>(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args,
            COALESCE(p.proacl::text, '(default: EXECUTE TO PUBLIC)') AS acl,
            pg_get_function_result(p.oid) AS rettype
       FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname = 'settle_queue_item_outcome'
      ORDER BY args`
  );
  const lines = fns.rows.map((r) => `settle_queue_item_outcome(${r.args}) RETURNS ${r.rettype}  ${r.acl}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const url = process.env.SETTLE_RPC_PG_URL;
  if (!url) throw new Error('SETTLE_RPC_PG_URL is required');
  const pool = new Pool({ connectionString: url });
  try {
    const fixtures = readFileSync(join(here, 'fixtures.sql'), 'utf8');
    await pool.query(fixtures);
    console.log('[rig] fixtures applied');

    await sectionCatalog(pool);
    await sectionAcl(pool);
    await sectionNormal(pool);
    await sectionOldCallers(pool);
    await sectionDoubleSettle(pool);
    await sectionCooldown(pool);
    await sectionDetail(pool);
    await sectionDeferred(pool);

    const text = await dump(pool);
    console.log('\n--- settle_queue_item_outcome catalog dump ---');
    console.log(text);
    if (process.env.SETTLE_RPC_DUMP_FILE) writeFileSync(process.env.SETTLE_RPC_DUMP_FILE, text + '\n');

    console.log(`\n[rig] ${checks} assertions, ${failures} failures`);
    if (failures > 0) process.exit(1);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (err) {
  console.error('[rig] FAILED:', err);
  process.exit(1);
}
