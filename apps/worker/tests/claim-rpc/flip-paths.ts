/**
 * Cooldown-removal flip-paths suite (migration 20261102160000, real
 * Postgres, SQL level).
 *
 * The due-claim path's 3-day flip is covered by parity.ts case 9.
 * This script covers the other two claim paths the spec's acceptance
 * criteria name: the slot claim (claim_posting_slot_item) and the
 * publish-now claim (claim_publish_now_items). Each path must flip a
 * 3-day-expired rate_limited destination to 'active' (anchor cleared)
 * and claim its item in the same call — and must leave a fresh-anchor
 * destination untouched.
 *
 * Every case seeds a small exact fixture, calls the RPC once, and
 * asserts the returned rows plus the destination/item state. All
 * timestamps are relative to the transaction's now() — the same now()
 * the RPCs use — and the transaction runs in UTC so the slot
 * occurrence math is timezone-stable.
 *
 * Usage:
 *   CLAIM_RPC_PG_URL=postgres://postgres@/claim138_parity?host=<socket dir> \
 *     pnpm --filter @fbuploadpro/worker exec tsx tests/claim-rpc/flip-paths.ts
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
const DAY = 24 * HOUR;

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

interface Ctx {
  client: PoolClient;
  now: Date;
}

function at(ctx: Ctx, offsetMs: number): Date {
  return new Date(ctx.now.getTime() + offsetMs);
}

async function dest(
  ctx: Ctx,
  n: number,
  opts: { status?: string; rateLimitedAt?: Date | null } = {}
): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT public.claim138_destination($1, $2, $3, $4::jsonb, $5) AS id`,
    ['facebook', n, opts.status ?? 'active', JSON.stringify({}), opts.rateLimitedAt ?? null]
  );
  return rows[0]?.id as string;
}

async function item(ctx: Ctx, destinationId: string, n: number): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT public.claim138_item($1, $2, $3, $4, $5, $6, $7, $8) AS id`,
    [destinationId, 'facebook', n, 'text', 'queued', new Date(ctx.now.getTime() - MIN), null, null]
  );
  return rows[0]?.id as string;
}

async function destState(
  ctx: Ctx,
  destinationId: string
): Promise<{ status: string; anchor: string | null }> {
  const { rows } = await ctx.client.query<{ status: string; metadata: Record<string, unknown> }>(
    `SELECT status, metadata FROM public.destinations WHERE id = $1`,
    [destinationId]
  );
  const metadata = rows[0]?.metadata ?? {};
  const anchor = metadata.rate_limited_at;
  return { status: rows[0]?.status as string, anchor: typeof anchor === 'string' ? anchor : null };
}

async function itemState(
  ctx: Ctx,
  destinationId: string,
  n: number
): Promise<{ status: string; claimed_at: Date | null }> {
  const { rows } = await ctx.client.query<{ status: string; claimed_at: Date | null }>(
    `SELECT status, claimed_at FROM public.queue_items
     WHERE id = public.claim138_item_id($1::uuid, $2::int)`,
    [destinationId, n]
  );
  return rows[0] as { status: string; claimed_at: Date | null };
}

async function slotFor(ctx: Ctx, destinationId: string): Promise<string> {
  // Occurrence = today + time_of_day in the destination timezone
  // (UTC by fixture default) — 2 minutes ago, inside the 5-minute
  // claim window, computed from the transaction's now().
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO public.posting_slots (destination_id, kind, time_of_day, is_active)
     VALUES ($1::uuid, ARRAY['text'], (now() - interval '2 minutes')::time, true)
     RETURNING id`,
    [destinationId]
  );
  return rows[0]?.id as string;
}

// ---------------------------------------------------------------------------
// Slot claim: anchor-expired destination flips and claims in one call.
// ---------------------------------------------------------------------------
async function caseSlotExpired(ctx: Ctx): Promise<void> {
  const d = await dest(ctx, 1, { status: 'rate_limited', rateLimitedAt: at(ctx, -4 * DAY) });
  const itemId = await item(ctx, d, 1);
  const slotId = await slotFor(ctx, d);
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT * FROM public.claim_posting_slot_item($1::uuid, $2::uuid, (now() AT TIME ZONE 'UTC')::date, now())`,
    [d, slotId]
  );
  check(rows.length === 1 && rows[0]?.id === itemId, 'slot: anchor-expired destination claims its item');
  const ds = await destState(ctx, d);
  check(ds.status === 'active', 'slot: anchor-expired destination flipped to active');
  check(ds.anchor === null, 'slot: anchor cleared on flip');
  const is = await itemState(ctx, d, 1);
  check(is.status === 'publishing', 'slot: claimed item is publishing');
}

// ---------------------------------------------------------------------------
// Slot claim: legacy no-anchor destination (updated_at 4 days old)
// flips via the updated_at fallback — never permanently unclaimable.
// ---------------------------------------------------------------------------
async function caseSlotLegacy(ctx: Ctx): Promise<void> {
  const d = await dest(ctx, 2, { status: 'rate_limited' });
  // Backdate past the destinations updated_at trigger (see parity
  // case 9): suspend triggers for this UPDATE only, then restore.
  await ctx.client.query(`SET LOCAL session_replication_role = replica`);
  await ctx.client.query(`UPDATE public.destinations SET updated_at = $2 WHERE id = $1`, [
    d,
    at(ctx, -4 * DAY),
  ]);
  await ctx.client.query(`SET LOCAL session_replication_role = origin`);
  const itemId = await item(ctx, d, 1);
  const slotId = await slotFor(ctx, d);
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT * FROM public.claim_posting_slot_item($1::uuid, $2::uuid, (now() AT TIME ZONE 'UTC')::date, now())`,
    [d, slotId]
  );
  check(rows.length === 1 && rows[0]?.id === itemId, 'slot: legacy no-anchor destination claims its item');
  const ds = await destState(ctx, d);
  check(ds.status === 'active', 'slot: legacy destination flipped to active via updated_at fallback');
}

// ---------------------------------------------------------------------------
// Slot claim: fresh-anchor destination is untouched (control).
// ---------------------------------------------------------------------------
async function caseSlotFresh(ctx: Ctx): Promise<void> {
  const d = await dest(ctx, 3, { status: 'rate_limited', rateLimitedAt: at(ctx, 1 * HOUR) });
  await item(ctx, d, 1);
  const slotId = await slotFor(ctx, d);
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT * FROM public.claim_posting_slot_item($1::uuid, $2::uuid, (now() AT TIME ZONE 'UTC')::date, now())`,
    [d, slotId]
  );
  check(rows.length === 0, 'slot: fresh-anchor destination claims nothing');
  const ds = await destState(ctx, d);
  check(ds.status === 'rate_limited', 'slot: fresh-anchor destination stays rate_limited');
  check(ds.anchor !== null, 'slot: fresh anchor preserved');
  const is = await itemState(ctx, d, 1);
  check(is.status === 'queued', 'slot: fresh-anchor item stays queued');
}

// ---------------------------------------------------------------------------
// Publish-now claim: anchor-expired destination flips and claims.
// ---------------------------------------------------------------------------
async function casePnExpired(ctx: Ctx): Promise<void> {
  const d = await dest(ctx, 4, { status: 'rate_limited', rateLimitedAt: at(ctx, -4 * DAY) });
  const itemId = await item(ctx, d, 1);
  await ctx.client.query(
    `UPDATE public.queue_items SET publish_now_requested_at = now() - interval '1 minute' WHERE id = $1::uuid`,
    [itemId]
  );
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT * FROM public.claim_publish_now_items()`
  );
  check(
    rows.some((r) => r.id === itemId),
    'pn: anchor-expired destination claims its marked item',
    `claimed=${rows.length}`
  );
  const ds = await destState(ctx, d);
  check(ds.status === 'active', 'pn: anchor-expired destination flipped to active');
  check(ds.anchor === null, 'pn: anchor cleared on flip');
  const is = await itemState(ctx, d, 1);
  check(is.status === 'publishing' && is.claimed_at !== null, 'pn: claimed item is publishing with claimed_at set');
}

// ---------------------------------------------------------------------------
// Publish-now claim: legacy no-anchor destination flips via fallback.
// ---------------------------------------------------------------------------
async function casePnLegacy(ctx: Ctx): Promise<void> {
  const d = await dest(ctx, 5, { status: 'rate_limited' });
  // Backdate past the destinations updated_at trigger (see parity
  // case 9): suspend triggers for this UPDATE only, then restore.
  await ctx.client.query(`SET LOCAL session_replication_role = replica`);
  await ctx.client.query(`UPDATE public.destinations SET updated_at = $2 WHERE id = $1`, [
    d,
    at(ctx, -4 * DAY),
  ]);
  await ctx.client.query(`SET LOCAL session_replication_role = origin`);
  const itemId = await item(ctx, d, 1);
  await ctx.client.query(
    `UPDATE public.queue_items SET publish_now_requested_at = now() - interval '1 minute' WHERE id = $1::uuid`,
    [itemId]
  );
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT * FROM public.claim_publish_now_items()`
  );
  check(rows.some((r) => r.id === itemId), 'pn: legacy no-anchor destination claims its marked item');
  const ds = await destState(ctx, d);
  check(ds.status === 'active', 'pn: legacy destination flipped to active via updated_at fallback');
}

// ---------------------------------------------------------------------------
// Publish-now claim: fresh-anchor destination is untouched (control).
// ---------------------------------------------------------------------------
async function casePnFresh(ctx: Ctx): Promise<void> {
  const d = await dest(ctx, 6, { status: 'rate_limited', rateLimitedAt: at(ctx, 1 * HOUR) });
  const itemId = await item(ctx, d, 1);
  await ctx.client.query(
    `UPDATE public.queue_items SET publish_now_requested_at = now() - interval '1 minute' WHERE id = $1::uuid`,
    [itemId]
  );
  const { rows } = await ctx.client.query<{ id: string }>(
    `SELECT * FROM public.claim_publish_now_items()`
  );
  check(!rows.some((r) => r.id === itemId), 'pn: fresh-anchor destination claims nothing');
  const ds = await destState(ctx, d);
  check(ds.status === 'rate_limited', 'pn: fresh-anchor destination stays rate_limited');
  const is = await itemState(ctx, d, 1);
  check(is.status === 'queued', 'pn: fresh-anchor marked item stays queued with its marker');
}

const CASES: Array<[string, (ctx: Ctx) => Promise<void>]> = [
  ['slot-expired', caseSlotExpired],
  ['slot-legacy', caseSlotLegacy],
  ['slot-fresh', caseSlotFresh],
  ['pn-expired', casePnExpired],
  ['pn-legacy', casePnLegacy],
  ['pn-fresh', casePnFresh],
];

async function main(): Promise<void> {
  const url = process.env.CLAIM_RPC_PG_URL;
  if (!url) throw new Error('CLAIM_RPC_PG_URL is required');
  const pool = new Pool({ connectionString: url });
  try {
    const fixtures = readFileSync(join(here, 'fixtures.sql'), 'utf8');
    await pool.query(fixtures);
    for (const [name, fn] of CASES) {
      const client = await pool.connect();
      const failuresBefore = failures;
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL TIME ZONE 'UTC'`);
        await client.query('SELECT public.claim138_reset()');
        const { rows } = await client.query<{ now: Date }>('SELECT now() AS now');
        const ctx: Ctx = { client, now: rows[0]?.now as Date };
        console.log(`[flip-paths] case ${name}`);
        await fn(ctx);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        failures += 1;
        console.error(`[flip-paths] case ${name} ERRORED:`, err);
      } finally {
        client.release();
      }
      if (failures === failuresBefore) console.log(`[flip-paths] case ${name}: PASS`);
      else console.error(`[flip-paths] case ${name}: FAIL`);
    }
  } finally {
    await pool.end();
  }
  console.log(`[flip-paths] ${checks} checks, ${failures} failures`);
  if (failures > 0) process.exit(1);
  console.log('[flip-paths] ALL CASES PASS');
}

main().catch((err: unknown) => {
  console.error('[flip-paths] FAILED:', err);
  process.exit(1);
});
