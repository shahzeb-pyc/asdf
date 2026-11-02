/**
 * Spec 138 planner evidence (plan.md §4): EXPLAIN (ANALYZE, BUFFERS) for
 * the two grouped passes of the claim RPC's usage snapshot, run
 * standalone against the scale seed (run scale.ts's seed first — this
 * script expects the scale database to be seeded; it reuses the seed if
 * the destinations are already present by simply not reseeding).
 *
 * The CTE text below mirrors the snapshot construction in the
 * current claim migration (20261102160000; due_destinations +
 * rules), with the RPC's parameters bound for the scale scenario:
 * platform 'instagram', fast-lane kind set ['text','image','carousel'].
 * (It previously mirrored 20261022140000; the predicates below were
 * updated for the cooldown removal — the anchor rule replaced the
 * cooldown tests.)
 * Usage:
 *   CLAIM_RPC_PG_URL=postgres://postgres@/claimrpc138scale?host=<socket dir> \
 *     pnpm --filter @fbuploadpro/worker exec tsx tests/claim-rpc/explain.ts
 * (Run after scale.ts has seeded the same database; if the seed was
 * rolled back, run scale.ts first and re-run this against a fresh seed —
 * see README.md.)
 */
import { Pool } from 'pg';

const DUE_AND_RULES = `
  WITH due_destinations AS (
    SELECT DISTINCT qi.destination_id
    FROM public.queue_items qi
    INNER JOIN public.destinations d
      ON d.id = qi.destination_id
    INNER JOIN public.social_accounts sa
      ON sa.id = d.account_id
    LEFT JOIN public.media_items mi
      ON mi.id = qi.media_item_id
    WHERE qi.status = 'queued'
      AND qi.scheduled_time <= now()
      AND qi.platform = $1::public.platform
      AND ($2::text[] IS NULL OR cardinality($2::text[]) = 0 OR qi.kind = ANY ($2::text[]))
      AND sa.status = 'active'
      AND (
        d.status = 'active'
        OR (d.status = 'rate_limited' AND COALESCE((d.metadata->>'rate_limited_at')::timestamptz, d.updated_at) <= now() - interval '3 days')
      )
      AND (
        qi.kind = 'text'
        OR qi.media_url IS NOT NULL
        OR (qi.media_item_id IS NOT NULL AND mi.id IS NOT NULL)
      )
  ),
  rules AS (
    SELECT
      dd.destination_id,
      lr.metric,
      lr.window_seconds,
      COALESCE(ov.override_cap, lr.cap) AS cap
    FROM due_destinations dd
    INNER JOIN public.destinations d
      ON d.id = dd.destination_id
    INNER JOIN public.destination_claim_limits lr
      ON lr.platform = $1::public.platform
    LEFT JOIN LATERAL (
      SELECT (elem ->> 'cap')::INT AS override_cap
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(d.metadata -> 'claim_limits') = 'array'
             THEN d.metadata -> 'claim_limits'
             ELSE '[]'::jsonb
        END
      ) AS elem
      WHERE elem ->> 'metric' = lr.metric
        AND (elem ->> 'window_seconds') ~ '^[0-9]+$'
        AND (elem ->> 'window_seconds')::INT = lr.window_seconds
        AND (elem ->> 'cap') ~ '^[0-9]+$'
        AND (elem ->> 'cap')::INT > 0
      LIMIT 1
    ) ov ON TRUE
  )`;

const LOG_PASS = `${DUE_AND_RULES}
  SELECT
    r.destination_id,
    r.metric,
    r.window_seconds,
    COUNT(*) AS log_count,
    MIN(pl.created_at) AS oldest_log_at
  FROM rules r
  INNER JOIN public.publish_logs pl
    ON pl.destination_id = r.destination_id
   AND pl.created_at > now() - make_interval(secs => r.window_seconds)
   AND (r.metric = 'calls' OR pl.result = 'success')
  GROUP BY r.destination_id, r.metric, r.window_seconds`;

const INFLIGHT_PASS = `${DUE_AND_RULES}
  SELECT
    q.destination_id,
    COUNT(*) AS inflight_count,
    MIN(COALESCE(q.claimed_at, q.updated_at)) AS oldest_inflight_at
  FROM public.queue_items q
  INNER JOIN due_destinations dd ON dd.destination_id = q.destination_id
  WHERE q.status = 'publishing'
  GROUP BY q.destination_id`;

async function explain(pool: Pool, label: string, sql: string): Promise<void> {
  const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
    ['instagram', ['text', 'image', 'carousel']]
  );
  console.log(`\n===== EXPLAIN (ANALYZE, BUFFERS) — ${label} =====`);
  for (const row of rows) console.log(row['QUERY PLAN']);
}

async function main(): Promise<void> {
  const url = process.env.CLAIM_RPC_PG_URL;
  if (!url) throw new Error('CLAIM_RPC_PG_URL is required');
  const pool = new Pool({ connectionString: url });
  try {
    await explain(pool, 'grouped publish_logs pass (log_usage)', LOG_PASS);
    await explain(pool, 'grouped in-flight queue_items pass (inflight_usage)', INFLIGHT_PASS);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('[explain] FAILED:', err);
  process.exit(1);
});
