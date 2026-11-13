/**
 * ADU RPC-grants rig (SEND BACK fix, PR #43 blocker B + hub bounds).
 *
 * Proves, against a real PostgreSQL database with bootstrap + ALL
 * repo migrations applied (see db/run-migrations.ts, modelled on the
 * spec 139 db-hygiene rig):
 *
 *   (a) All seven ADU claim RPCs from 20261030130000 exist, are
 *       SECURITY DEFINER, and are NOT executable by PUBLIC, anon or
 *       authenticated — but ARE executable by service_role. The
 *       check is both catalog (has_function_privilege) AND live: a
 *       direct call as authenticated must fail with 42501, while the
 *       same call as service_role succeeds. The RPCs are
 *       intentionally global for the service-side claim loop, so no
 *       in-function ownership check is asserted — the control is the
 *       execution scope (see 20261030140000 header comment).
 *   (b) The hub list/stats RPCs — the unified pair from
 *       20261113170000 (F21), one platform-parameterised pair for
 *       all three hubs — exist, are plain (NOT security definer),
 *       and carry the same grant closure.
 *   (c) Hub list/stats behaviour on seeded data: paging (limit +
 *       total_count window), status filter, search across source
 *       username / destination name / external id, Most/Least
 *       Followers sort, and stats sums (total followers = sum of
 *       current_followers; net gained = sum of max(0, current-starting)).
 *       Plus the spec 162 send-back fix (round 2): adu_hub_list
 *       returns followers_updated_at — a stamped config's timestamp
 *       round-trips through the RPC and an unstamped config reads
 *       null, so the Facebook hub route can hand the value to
 *       buildAduConfigView instead of it being null forever.
 *       Plus F21 platform isolation: the unified function called
 *       with p_platform 'facebook' returns only Facebook configs,
 *       'instagram' only Instagram configs, 'threads' only Threads
 *       configs, and an unknown platform returns zero rows — the
 *       Facebook-direction leak (an Instagram/Threads config on an
 *       adu-section destination appearing in the Facebook hub) is
 *       closed by the platform predicate.
 *   (d) The hub RPC definitions are idempotent: re-applying the
 *       20261113170000 (F21) migration exits clean and the grants
 *       above still hold. The 20261111010000 (spec 162) hub-RPC
 *       block is no longer re-appliable: its CREATE OR REPLACE
 *       statements define the old 6-arg/3-arg signatures, which
 *       would resurrect the old functions as overloads alongside
 *       the unified pair instead of replacing them.
 *
 * Usage:
 *   ADU_RPC_GRANTS_PG_URL=postgres://postgres@/adu_rpc?host=<socket>&port=5432 \
 *     pnpm --filter @fbuploadpro/worker exec tsx tests/adu-rpc-grants/db/run-migrations.ts
 *   ADU_RPC_GRANTS_PG_URL=... \
 *     pnpm --filter @fbuploadpro/worker exec tsx tests/adu-rpc-grants/check.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', '..', 'supabase', 'migrations');

const USER_ID = '11111111-1111-4111-a111-111111111111';
const WS_ID = 'aaaaaaaa-aaaa-4111-a111-aaaaaaaaaaaa';
const ACCT_ID = '22222222-2222-4222-a222-222222222222';
const DEST_A = '33333333-3333-4333-a333-333333333333';
const DEST_B = '44444444-4444-4333-a444-444444444444';
const DEST_C = '55555555-5555-4333-a555-555555555555';
const DEST_D = '66666666-6666-4333-a666-666666666666';
const DEST_E = '77777777-7777-4333-a777-777777777777';

const CLAIM_FUNCTIONS = [
  'get_next_pending_adu_config',
  'get_next_browser_pending_adu_config',
  'reset_stuck_adu_configs',
  'reset_stale_adu_reel_downloads',
  'claim_adu_buffer_downloads',
  // Claim split (migration 20261103150000): the Worker claims TikTok
  // rows, the VPS downloader everything else; both keep the same grant
  // closure as the original claim.
  'claim_tiktok_buffer_downloads',
  'claim_non_tiktok_buffer_downloads',
  'mark_adu_reel_downloaded',
  'mark_adu_reel_download_failed',
] as const;

const HUB_FUNCTIONS = ['adu_hub_list', 'adu_hub_stats'] as const;

type Role = 'authenticated' | 'anon' | 'service_role';

let checks = 0;
let failures = 0;

function check(cond: boolean, label: string, detail?: string): void {
  checks += 1;
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failures += 1;
    const suffix = detail ? ` (${detail})` : '';
    console.error(`  FAIL: ${label}${suffix}`);
  }
}

interface Attempt {
  ok: boolean;
  code: string | undefined;
  rows: Record<string, unknown>[];
}

async function asRole(
  pool: Pool,
  role: Role,
  fn: (client: PoolClient) => Promise<void>,
  opts: { commit?: boolean } = {},
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await fn(client);
    await client.query(opts.commit ? 'COMMIT' : 'ROLLBACK');
  } finally {
    client.release();
  }
}

async function attempt(
  pool: Pool,
  role: Role,
  sql: string,
  params: unknown[] = [],
): Promise<Attempt> {
  let result: Attempt = { ok: false, code: undefined, rows: [] };
  try {
    await asRole(pool, role, async (client) => {
      try {
        const res = await client.query(sql, params as never[]);
        result = { ok: true, code: undefined, rows: res.rows as Record<string, unknown>[] };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        result = { ok: false, code: e.code, rows: [] };
      }
    });
  } catch (err) {
    if (!result.ok && !result.code) throw err;
  }
  return result;
}

async function catalogGrants(
  pool: Pool,
  fn: string,
): Promise<{ exists: boolean; secdef: boolean; pub: boolean; anon_: boolean; auth_: boolean; svc: boolean }> {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = $1) AS exists_,
            (SELECT p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1) AS secdef,
            (SELECT has_function_privilege('public', p.oid, 'EXECUTE') FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1) AS pub,
            (SELECT has_function_privilege('anon', p.oid, 'EXECUTE') FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1) AS anon_,
            (SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1) AS auth_,
            (SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1) AS svc`,
    [fn],
  );
  const r = rows[0] as Record<string, unknown>;
  return {
    exists: r.exists_ === true,
    secdef: r.secdef === true,
    pub: r.pub === true,
    anon_: r.anon_ === true,
    auth_: r.auth_ === true,
    svc: r.svc === true,
  };
}

async function seed(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE public.adu_posting_jobs, public.adu_reels, public.adu_configs,
    public.destinations, public.social_accounts, public.workspaces, public.users CASCADE`);
  // The users table's canonicalize trigger only permits gmail/googlemail
  // addresses (see the db-hygiene rig's fixtures), so the rig user is
  // a gmail address, like the claim-rpc rig's.
  await pool.query(`INSERT INTO public.users (id, email, name) VALUES ($1, 'adu.rig@gmail.com', 'ADU Rig')`, [USER_ID]);
  await pool.query(
    `INSERT INTO public.workspaces (id, owner_id, name, subdomain) VALUES ($1, $2, 'ADU Rig WS', 'adu-rig-ws')`,
    [WS_ID, USER_ID],
  );
  await pool.query(
    `INSERT INTO public.social_accounts (id, workspace_id, platform, external_account_id, display_name, encrypted_access_token)
     VALUES ($1, $2, 'facebook', 'acct-ext-1', 'Rig Account', 'x')`,
    [ACCT_ID, WS_ID],
  );
  const dests: Array<[string, string, string, string]> = [
    [DEST_A, 'Alpha Page', 'alpha-ext', 'facebook'],
    [DEST_B, 'Beta Page', 'beta-ext', 'facebook'],
    [DEST_C, 'Gamma Page', 'gamma-ext', 'facebook'],
    // F21 platform isolation: one Instagram and one Threads
    // destination in the same workspace, so the unified function
    // called with p_platform 'facebook' must not return their configs.
    [DEST_D, 'Delta IG', 'delta-ig', 'instagram'],
    [DEST_E, 'Epsilon Threads', 'epsilon-th', 'threads'],
  ];
  for (const [id, name, ext, platform] of dests) {
    await pool.query(
      // Spec 174 1B: the hub RPCs only return `adu` rows, so the
      // seeded destinations must carry the section the rig asserts on.
      `INSERT INTO public.destinations (id, workspace_id, account_id, platform, external_destination_id, name, section)
       VALUES ($1, $2, $3, $4, $5, $6, 'adu')`,
      [id, WS_ID, ACCT_ID, platform, ext, name],
    );
  }
  // Three configs: A active/150 gained on 100 starting (net 50),
  // B active/300 gained on 300 starting (net 0), C paused/50 on 0 (net 50).
  // 'inactive' no longer exists (ADU statuses PR: turning automation
  // off is Pause now), so the third config is seeded 'paused'.
  // A carries a stamped followers_updated_at (spec 162 round 2):
  // the hub list must return the column and the stamp must round-trip.
  // D (Instagram) and E (Threads) exist only for the F21 platform
  // isolation assertions below — they must never appear in the
  // Facebook hub, and their stats must not leak into its sums.
  await pool.query(
    `INSERT INTO public.adu_configs (id, workspace_id, destination_id, source_platform, source_username,
       timezone, posts_per_day, schedule_type, posting_times, status, sync_status, starting_followers, current_followers, followers_updated_at)
     VALUES
       ('a0000000-0000-4000-8000-000000000001', $1, $2, 'instagram', 'alpha_source', 'UTC', 1, 'dailyrandom', '{}', 'active', 'synced', 100, 150, '2026-11-10T22:00:00.000Z'),
       ('a0000000-0000-4000-8000-000000000002', $1, $3, 'tiktok', 'beta_source', 'UTC', 2, 'dailyrandom', '{}', 'active', 'synced', 300, 300, NULL),
       ('a0000000-0000-4000-8000-000000000003', $1, $4, 'youtube', 'gamma_source', 'UTC', 1, 'dailyrandom', '{}', 'paused', 'synced', 0, 50, NULL),
       ('a0000000-0000-4000-8000-000000000004', $1, $5, 'instagram', 'delta_source', 'UTC', 1, 'dailyrandom', '{}', 'active', 'synced', 0, 400, NULL),
       ('a0000000-0000-4000-8000-000000000005', $1, $6, 'youtube', 'epsilon_source', 'UTC', 1, 'dailyrandom', '{}', 'active', 'synced', 0, 500, NULL)`,
    [WS_ID, DEST_A, DEST_B, DEST_C, DEST_D, DEST_E],
  );
}

async function main(): Promise<void> {
  const url = process.env.ADU_RPC_GRANTS_PG_URL;
  if (!url) throw new Error('ADU_RPC_GRANTS_PG_URL is required');
  const pool = new Pool({ connectionString: url });
  try {
    // Start from empty ADU tables so section (a)'s "claim on empty
    // tables" assertion holds even when the rig is re-run against a
    // database a previous run already seeded.
    await pool.query(
      `TRUNCATE public.adu_posting_jobs, public.adu_reels, public.adu_configs CASCADE`,
    );
    console.log('(a) claim RPC grant closure');
    for (const fn of CLAIM_FUNCTIONS) {
      const g = await catalogGrants(pool, fn);
      check(g.exists, `${fn}() exists`);
      check(g.secdef, `${fn}() is SECURITY DEFINER`);
      check(g.pub === false, `${fn}(): PUBLIC EXECUTE removed`);
      check(g.anon_ === false, `${fn}(): anon EXECUTE removed`);
      check(g.auth_ === false, `${fn}(): authenticated EXECUTE removed`);
      check(g.svc === true, `${fn}(): service_role EXECUTE kept`);
    }
    const claimProbe = await attempt(pool, 'authenticated', 'SELECT public.claim_adu_buffer_downloads(10)');
    check(!claimProbe.ok && claimProbe.code === '42501', 'claim as authenticated -> 42501', claimProbe.code);
    const markProbe = await attempt(
      pool,
      'authenticated',
      'SELECT public.mark_adu_reel_download_failed($1)',
      ['00000000-0000-4000-8000-000000000000'],
    );
    check(!markProbe.ok && markProbe.code === '42501', 'mark failed as authenticated -> 42501', markProbe.code);
    const svcClaim = await attempt(pool, 'service_role', 'SELECT public.claim_adu_buffer_downloads(10)');
    check(svcClaim.ok, 'claim as service_role succeeds', svcClaim.code);
    check(svcClaim.rows.length === 0, 'claim on empty tables returns 0 rows');

    console.log('(b) hub RPC grant closure');
    for (const fn of HUB_FUNCTIONS) {
      const g = await catalogGrants(pool, fn);
      check(g.exists, `${fn}() exists`);
      check(g.secdef === false, `${fn}() is NOT security definer`);
      check(g.pub === false, `${fn}(): PUBLIC EXECUTE removed`);
      check(g.anon_ === false, `${fn}(): anon EXECUTE removed`);
      check(g.auth_ === false, `${fn}(): authenticated EXECUTE removed`);
      check(g.svc === true, `${fn}(): service_role EXECUTE kept`);
    }

    console.log('(c) hub list/stats behaviour on seeded data');
    await seed(pool);
    // The corrected claim RPC (20261030140000 §0) must actually claim:
    // config A is active/synced with an empty buffer and one pending reel.
    await pool.query(
      `INSERT INTO public.adu_reels (id, config_id, source_reel_id, status, download_retries)
       VALUES ('b0000000-0000-4000-8000-000000000001',
               'a0000000-0000-4000-8000-000000000001', 'reel-1', 'pending', 0)`,
    );
    // Committed, not rolled back: the status/retry assertions below
    // read the reel after the claim, so the claim must persist.
    let claimed: Attempt = { ok: false, code: undefined, rows: [] };
    await asRole(pool, 'service_role', async (client) => {
      try {
        const res = await client.query('SELECT * FROM public.claim_adu_buffer_downloads(10)');
        claimed = { ok: true, code: undefined, rows: res.rows as Record<string, unknown>[] };
      } catch (err) {
        claimed = { ok: false, code: (err as { code?: string }).code, rows: [] };
      }
    }, { commit: true });
    check(claimed.ok, 'claim as service_role succeeds on seeded data', claimed.code);
    check(claimed.rows.length === 1, 'claim returns the one hungry pending reel', String(claimed.rows.length));
    check(
      claimed.rows[0]?.source_reel_id === 'reel-1' && claimed.rows[0]?.source_username === 'alpha_source',
      'claim returns the reel id and source identity from its config',
    );
    const reelAfter = await pool.query(
      `SELECT status, download_retries FROM public.adu_reels WHERE id = 'b0000000-0000-4000-8000-000000000001'`,
    );
    check(reelAfter.rows[0]?.status === 'processing', 'claimed reel moves to processing');
    check(Number(reelAfter.rows[0]?.download_retries) === 1, 'claimed reel retry count increments to 1');
    const listPage1 = await attempt(pool, 'service_role',
      'SELECT * FROM public.adu_hub_list($1, $2, NULL, NULL, NULL, 2, 0)', [WS_ID, 'facebook']);
    check(listPage1.ok && listPage1.rows.length === 2, 'hub list page 1 returns 2 rows', String(listPage1.rows.length));
    check(
      listPage1.rows[0]?.total_count === 3 || listPage1.rows[0]?.total_count === '3',
      'hub list total_count is 3 across pages',
      String(listPage1.rows[0]?.total_count),
    );
    const listSearch = await attempt(pool, 'service_role',
      'SELECT * FROM public.adu_hub_list($1, $2, $3, NULL, NULL, 9, 0)', [WS_ID, 'facebook', 'Alpha']);
    check(listSearch.rows.length === 1, 'hub list search by destination name finds 1 row', String(listSearch.rows.length));
    const listSearchSource = await attempt(pool, 'service_role',
      'SELECT * FROM public.adu_hub_list($1, $2, $3, NULL, NULL, 9, 0)', [WS_ID, 'facebook', 'beta_source']);
    check(listSearchSource.rows.length === 1, 'hub list search by source username finds 1 row');
    const listPaused = await attempt(pool, 'service_role',
      'SELECT * FROM public.adu_hub_list($1, $2, NULL, $3, NULL, 9, 0)', [WS_ID, 'facebook', 'paused']);
    check(listPaused.rows.length === 1, 'hub list status filter finds 1 paused row');
    const listMost = await attempt(pool, 'service_role',
      'SELECT * FROM public.adu_hub_list($1, $2, NULL, NULL, $3, 9, 0)', [WS_ID, 'facebook', 'Most Followers']);
    check(
      Number(listMost.rows[0]?.current_followers) === 300,
      'hub list Most Followers sorts by current_followers desc',
      String(listMost.rows[0]?.current_followers),
    );
    // Spec 162 round 2: the timestamp column must be present in the
    // RPC output at all — without it in RETURNS TABLE the key is
    // absent (not null) and the hub view reads null forever. The
    // stamped config's value must round-trip; unstamped configs read
    // null, never a faked time.
    const listAll = await attempt(pool, 'service_role',
      'SELECT * FROM public.adu_hub_list($1, $2, NULL, NULL, NULL, 9, 0)', [WS_ID, 'facebook']);
    check(listAll.ok && listAll.rows.length === 3, 'hub list returns all 3 rows for timestamp check', String(listAll.rows.length));
    check(
      listAll.rows.every((r) => 'followers_updated_at' in r),
      'hub list rows carry followers_updated_at',
    );
    const stamped = listAll.rows.find((r) => r.source_username === 'alpha_source');
    check(
      stamped !== undefined && new Date(stamped.followers_updated_at as string).toISOString() === '2026-11-10T22:00:00.000Z',
      'hub list returns the stamped followers_updated_at',
      String(stamped?.followers_updated_at),
    );
    check(
      listAll.rows
        .filter((r) => r.source_username !== 'alpha_source')
        .every((r) => r.followers_updated_at === null),
      'hub list returns null followers_updated_at for unstamped configs',
    );
    const stats = await attempt(pool, 'service_role',
      'SELECT * FROM public.adu_hub_stats($1, $2, NULL, NULL)', [WS_ID, 'facebook']);
    check(stats.rows.length === 1, 'hub stats returns 1 row');
    check(Number(stats.rows[0]?.total_count) === 3, 'hub stats total is 3', String(stats.rows[0]?.total_count));
    check(
      Number(stats.rows[0]?.total_followers_sum) === 500,
      'hub stats total followers = sum(current_followers) = 500',
      String(stats.rows[0]?.total_followers_sum),
    );
    check(
      Number(stats.rows[0]?.net_gained_sum) === 100,
      'hub stats net gained = 50 + 0 + 50 = 100',
      String(stats.rows[0]?.net_gained_sum),
    );
    const emptyList = await attempt(pool, 'service_role',
      'SELECT * FROM public.adu_hub_list($1, $2, NULL, NULL, NULL, 9, 0)', ['99999999-9999-4999-8999-999999999999', 'facebook']);
    check(emptyList.ok && emptyList.rows.length === 0, 'hub list for unknown workspace returns 0 rows');

    // F21 platform isolation: the same seeded rows through the other
    // platforms' literals, and an unknown platform. The Instagram and
    // Threads configs must never appear in the Facebook hub (the
    // pre-F21 leak), and each platform's stats must count only its
    // own configs.
    const listIg = await attempt(pool, 'service_role',
      'SELECT * FROM public.adu_hub_list($1, $2, NULL, NULL, NULL, 9, 0)', [WS_ID, 'instagram']);
    check(listIg.ok && listIg.rows.length === 1, 'hub list instagram returns 1 row', String(listIg.rows.length));
    check(
      listIg.rows[0]?.source_username === 'delta_source',
      'hub list instagram returns the Instagram config',
      String(listIg.rows[0]?.source_username),
    );
    const listTh = await attempt(pool, 'service_role',
      'SELECT * FROM public.adu_hub_list($1, $2, NULL, NULL, NULL, 9, 0)', [WS_ID, 'threads']);
    check(listTh.ok && listTh.rows.length === 1, 'hub list threads returns 1 row', String(listTh.rows.length));
    check(
      listTh.rows[0]?.source_username === 'epsilon_source',
      'hub list threads returns the Threads config',
      String(listTh.rows[0]?.source_username),
    );
    const listBogus = await attempt(pool, 'service_role',
      'SELECT * FROM public.adu_hub_list($1, $2, NULL, NULL, NULL, 9, 0)', [WS_ID, 'bogus']);
    check(listBogus.ok && listBogus.rows.length === 0, 'hub list unknown platform returns 0 rows');
    const statsIg = await attempt(pool, 'service_role',
      'SELECT * FROM public.adu_hub_stats($1, $2, NULL, NULL)', [WS_ID, 'instagram']);
    check(Number(statsIg.rows[0]?.total_count) === 1, 'hub stats instagram total is 1', String(statsIg.rows[0]?.total_count));
    check(Number(statsIg.rows[0]?.total_followers_sum) === 400, 'hub stats instagram followers = 400', String(statsIg.rows[0]?.total_followers_sum));
    const statsTh = await attempt(pool, 'service_role',
      'SELECT * FROM public.adu_hub_stats($1, $2, NULL, NULL)', [WS_ID, 'threads']);
    check(Number(statsTh.rows[0]?.total_count) === 1, 'hub stats threads total is 1', String(statsTh.rows[0]?.total_count));
    check(Number(statsTh.rows[0]?.total_followers_sum) === 500, 'hub stats threads followers = 500', String(statsTh.rows[0]?.total_followers_sum));

    console.log('(d) hub RPC definition idempotency (F21)');
    // The re-appliable unit now is the CURRENT hub-RPC block — the
    // 20261113170000 (F21) migration itself (DROP the six old
    // functions + CREATE the unified pair + grant closure). It is
    // self-contained, so the whole file re-applies. Re-applying it
    // must exit clean and leave the grant closure intact. The
    // spec-162 block is NOT re-applied: its old-signature CREATE OR
    // REPLACE statements would resurrect the six old functions as
    // overloads alongside the unified pair.
    const f21 = readFileSync(
      join(migrationsDir, '20261113170000_adu_hub_platform.sql'),
      'utf8',
    );
    await pool.query(f21);
    for (const fn of HUB_FUNCTIONS) {
      const g = await catalogGrants(pool, fn);
      check(g.exists, `${fn}() still exists after re-apply`);
      check(g.secdef === false, `${fn}() still NOT security definer after re-apply`);
      check(
        g.pub === false && g.anon_ === false && g.auth_ === false && g.svc === true,
        `${fn}() grant closure still holds after re-apply`,
      );
    }
    // The old per-platform pairs are gone for good: re-applying the
    // F21 migration must not resurrect them.
    for (const fn of [
      'threads_adu_hub_list',
      'threads_adu_hub_stats',
      'instagram_adu_hub_list',
      'instagram_adu_hub_stats',
    ] as const) {
      const g = await catalogGrants(pool, fn);
      check(g.exists === false, `${fn}() stays dropped after re-apply`);
    }
    const g2 = await catalogGrants(pool, 'claim_adu_buffer_downloads');
    check(g2.pub === false && g2.svc === true, 'claim grants still hold after re-applying the hub RPC definitions');
  } finally {
    await pool.end();
  }
  console.log(`\n${checks - failures}/${checks} assertions passed`);
  if (failures > 0) process.exit(1);
}

try {
  await main();
} catch (err) {
  console.error('[adu-rpc-grants] FAILED:', err);
  process.exit(1);
}
