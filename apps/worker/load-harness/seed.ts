/**
 * Deterministic seed generator for the spec 122 load harness.
 *
 * Builds the synthetic tenant graph and queue backlog in the unified schema:
 * 10 users → 10 workspaces → per-platform social_accounts + destinations →
 * queue_items, all with ids derived from md5('<tag>-<n>') so every run seeds
 * the identical graph (the only nondeterminism is the token IVs, and the seed
 * reuses ONE ciphertext per token role, generated with contracts'
 * encryptToken under the harness master key).
 *
 * Distribution (full run, 1,000,000 items) is sized against the D5 claim caps
 * enforced by the real claim RPC (destination_claim_limits):
 *   instagram: 25 publish calls / 1 h and 100 published / 24 h per destination
 *   threads:   250 published / 24 h per destination
 *   x:         100 published / 15 min per destination
 *   facebook / youtube / tiktok: no claim-cap rows
 * Per-destination item counts stay below every cap so the caps are exercised
 * but never defer the drain:
 *   facebook   300,000 items / 3,000 destinations = 100 per destination
 *   instagram  100,000 items / 5,000 destinations =  20 per destination
 *   threads    100,000 items / 1,000 destinations = 100 per destination
 *   youtube    200,000 items / 2,000 destinations = 100 per destination
 *   x          100,000 items / 2,000 destinations =  50 per destination
 *   tiktok     200,000 items / 2,000 destinations = 100 per destination
 * Calibration runs scale every platform by the same factor.
 *
 * Lane mix ≈ 60% fast / 40% heavy, assigned deterministically
 * (item index mod 10 < 6 → fast kind, else heavy kind). All items are due
 * at drain start (scheduled_time = seed time − 1 minute).
 */
import { encryptToken } from '@fbuploadpro/contracts';
import type { Pool } from 'pg';

export interface PlatformSeedPlan {
  platform: string;
  items: number;
  destinations: number;
}

export const FULL_SEED_PLAN: PlatformSeedPlan[] = [
  { platform: 'facebook', items: 300_000, destinations: 3_000 },
  { platform: 'instagram', items: 100_000, destinations: 5_000 },
  { platform: 'threads', items: 100_000, destinations: 1_000 },
  { platform: 'youtube', items: 200_000, destinations: 2_000 },
  { platform: 'x', items: 100_000, destinations: 2_000 },
  { platform: 'tiktok', items: 200_000, destinations: 2_000 },
];

export const HARNESS_MASTER_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const WORKSPACES = 10;

export function scaledPlan(scale: number): PlatformSeedPlan[] {
  return FULL_SEED_PLAN.map((p) => ({
    platform: p.platform,
    items: Math.max(10, Math.round(p.items * scale)),
    destinations: p.destinations,
  }));
}

export async function seed(pool: Pool, plan: PlatformSeedPlan[]): Promise<{ totalItems: number }> {
  const accessCipher = await encryptToken('mock-access-token', HARNESS_MASTER_KEY);
  const refreshCipher = await encryptToken('mock-refresh-token', HARNESS_MASTER_KEY);
  const destinationCipher = await encryptToken('mock-destination-token', HARNESS_MASTER_KEY);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Fresh harness database expected; clear any previous harness seed in
    // dependency order so re-runs on the same DB are idempotent.
    await client.query('TRUNCATE public.publish_logs, public.queue_items, public.destinations, public.social_accounts, public.platform_credentials, public.worker_heartbeats, public.workspaces, public.users CASCADE');

    await client.query(
      `INSERT INTO public.users (id, email, name)
       SELECT md5('lh-user-' || g)::uuid, 'lh.user.' || g || '@gmail.com', 'Load Harness ' || g
       FROM generate_series(0, $1 - 1) AS g`,
      [WORKSPACES]
    );
    await client.query(
      `INSERT INTO public.workspaces (id, owner_id, name, subdomain)
       SELECT md5('lh-ws-' || g)::uuid, md5('lh-user-' || g)::uuid,
              'Load Harness WS ' || g, 'lh-ws-' || g
       FROM generate_series(0, $1 - 1) AS g`,
      [WORKSPACES]
    );

    let totalItems = 0;
    for (const p of plan) {
      // Accounts + destinations: destination i belongs to account i of the
      // same platform; workspace assigned round-robin.
      await client.query(
        `INSERT INTO public.social_accounts
           (id, workspace_id, platform, external_account_id, display_name,
            encrypted_access_token, encrypted_refresh_token, token_expires_at, status)
         SELECT md5('lh-acct-' || $1 || '-' || g)::uuid,
                md5('lh-ws-' || (g % $4))::uuid,
                $1::public.platform, 'ext-acct-' || $1 || '-' || g,
                'Mock ' || $1 || ' account ' || g,
                $2, $3, now() + interval '30 days', 'active'
         FROM generate_series(0, $5 - 1) AS g`,
        [p.platform, accessCipher, refreshCipher, WORKSPACES, p.destinations]
      );
      await client.query(
        `INSERT INTO public.destinations
           (id, workspace_id, account_id, platform, external_destination_id,
            name, encrypted_destination_token, status, section)
         SELECT md5('lh-dest-' || $1 || '-' || g)::uuid,
                md5('lh-ws-' || (g % $4))::uuid,
                md5('lh-acct-' || $1 || '-' || g)::uuid,
                $1::public.platform, 'ext-dest-' || $1 || '-' || g,
                'Mock ' || $1 || ' destination ' || g,
                $2, 'active', 'schedule'
         FROM generate_series(0, $3 - 1) AS g`,
        [p.platform, destinationCipher, p.destinations, WORKSPACES]
      );

      // Queue items: item j of a platform goes to destination j % destCount.
      // kind by j % 10: 0-5 fast (cycle text/image/carousel), 6-9 heavy
      // (cycle video/story) — except youtube, whose only fast kind is text
      // and whose image kind is heavy (contracts lane table).
      await client.query(
        `INSERT INTO public.queue_items
           (id, workspace_id, destination_id, platform, kind, platform_format,
            caption, media_url, scheduled_time, status)
         SELECT
           md5('lh-item-' || $1 || '-' || j)::uuid,
           md5('lh-ws-' || ((j % $3) % $4))::uuid,
           md5('lh-dest-' || $1 || '-' || (j % $3))::uuid,
           $1::public.platform,
           CASE
             WHEN $1 = 'youtube' THEN
               CASE WHEN j % 10 < 6 THEN 'text'
                    WHEN j % 10 IN (6, 8) THEN 'video' ELSE 'image' END
             ELSE
               CASE
                 WHEN j % 10 = 0 THEN 'text'
                 WHEN j % 10 IN (1, 3) THEN 'image'
                 WHEN j % 10 IN (2, 4, 5) THEN 'carousel'
                 WHEN j % 10 IN (6, 8) THEN 'video'
                 ELSE 'story'
               END
           END,
           CASE WHEN j % 10 IN (6, 8) THEN
             CASE $1 WHEN 'youtube' THEN 'short' WHEN 'tiktok' THEN 'video' ELSE 'reel' END
           END,
           'Load harness synthetic post ' || j || ' on ' || $1,
           CASE WHEN j % 10 = 0 AND $1 <> 'youtube' THEN NULL
                WHEN $1 = 'youtube' AND j % 10 < 6 THEN NULL
                ELSE 'https://example.invalid/media/' || $1 || '/' || j || '.bin' END,
           now() - interval '1 minute',
           'queued'
         FROM generate_series(0, $2 - 1) AS j`,
        [p.platform, p.items, p.destinations, WORKSPACES]
      );
      totalItems += p.items;
    }
    await client.query('COMMIT');
    return { totalItems };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
