/**
 * Spec 139 db-hygiene assertion suite (real PostgreSQL, SQL level).
 *
 * Proves the changes in
 * supabase/migrations/20261023193000_db_hygiene.sql and
 * supabase/migrations/20261024100000_posting_slots_unique.sql:
 *
 *   1. idx_queue_items_publishing_claimed — a partial index on
 *      public.queue_items (platform, claimed_at) WHERE status =
 *      'publishing', backing the unified recovery sweep
 *      recover_stuck_publishing_items(platform, INT).
 *   2. REVOKE EXECUTE ... FROM PUBLIC on the five trigger functions
 *      (guard_users_role_status, set_updated_at,
 *      check_media_folders_cycle, prevent_workspace_owner_transfer,
 *      canonicalize_user_email) — hygiene only, because all five
 *      RETURN TRIGGER and are not PostgREST-exposable.
 *
 * Two modes:
 *   hardened (default) — run against a database with ALL migrations
 *     (incl. 20261023193000_db_hygiene.sql) applied. Every assertion
 *     must pass:
 *       (a) the index exists with the right table, column order and
 *           partial predicate;
 *       (b) all five functions exist, RETURN TRIGGER, and PUBLIC (and
 *           therefore anon / authenticated, who hold no direct grant)
 *           no longer has EXECUTE — verified in the catalog AND with a
 *           live 42501 probe on a direct call as `authenticated`;
 *       (c) REVOKE EXECUTE did not break trigger firing: the users
 *           role/status guard still raises 42501 for `authenticated`,
 *           set_updated_at still bumps updated_at, canonicalize still
 *           rewrites normalized_email, the workspace owner-transfer
 *           guard still raises, and the folder cycle guard still
 *           raises 23514;
 *       (d) the recovery sweep still works end-to-end as service_role
 *           and recovers exactly the stale facebook rows (incl. the
 *           claimed_at-NULL COALESCE fallback row);
 *       (e) on planner-scale seeded data, the sweep's exact filter
 *           shape is planned through idx_queue_items_publishing_claimed
 *           (enable_seqscan=off, so the assertion is about index
 *           eligibility for the shape, not about beating the
 *           planner's cost model on a small table);
 *       (f) the migration is idempotent (re-applying the file exits
 *           clean and the state above still holds);
 *       (g) uq_posting_slots_destination_time exists as a UNIQUE
 *           constraint on public.posting_slots (destination_id,
 *           time_of_day) — spec 139 N5: a duplicate insert at the same
 *           destination + time fails 23505 (including with
 *           is_active = false — the constraint is plain, not partial,
 *           matching the pre-unification slot-table semantics where
 *           is_active is toggled in place and removal is a hard
 *           DELETE), while a distinct time or a distinct destination
 *           succeeds; the migration file is idempotent.
 *   vulnerable — run against a database built with
 *     DB_HYGIENE_MIGRATIONS_UNTIL=20261023120000_rls_rpc_hardening.sql
 *     (pre-hygiene). Asserts the findings are still present (index
 *     absent, PUBLIC EXECUTE intact, posting_slots unique absent —
 *     a duplicate insert succeeds), proving the rig detects them.
 *     Trigger-firing and recovery sections still run: they document
 *     the pre-state behaviour the migration must preserve.
 *
 * Usage:
 *   DB_HYGIENE_PG_URL=postgres://postgres@/dbhygiene?host=<socket dir>&port=<port> \
 *     pnpm --filter @fbuploadpro/worker exec tsx tests/db-hygiene/check.ts
 * (database must already have bootstrap + migrations applied — see
 * README.md; fixtures.sql from this directory is applied by the runner.)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', '..', 'supabase', 'migrations');

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const USER_C = '33333333-3333-3333-3333-333333333333';
const WS_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FOLDER_PARENT = 'f001f001-f001-f001-f001-f001f001f001';
const FOLDER_CHILD = 'f002f002-f002-f002-f002-f002f002f002';
const ITEM_STALE_FB = 'c001c001-c001-c001-c001-c001c001c001';
const ITEM_FRESH_FB = 'c002c002-c002-c002-c002-c002c002c002';
const ITEM_STALE_IG = 'c003c003-c003-c003-c003-c003c003c003';
const ITEM_STALE_FB_NULLCLAIM = 'c004c004-c004-c004-c004-c004c004c004';

const TRIGGER_FUNCTIONS = [
  'guard_users_role_status',
  'set_updated_at',
  'check_media_folders_cycle',
  'prevent_workspace_owner_transfer',
  'canonicalize_user_email',
] as const;

type Role = 'authenticated' | 'anon' | 'service_role';

const mode = process.env.DB_HYGIENE_MODE === 'vulnerable' ? 'vulnerable' : 'hardened';
const hardened = mode === 'hardened';

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
  rowCount: number;
  rows: Record<string, unknown>[];
}

/**
 * Runs fn inside one transaction as the given role (SET LOCAL ROLE +
 * request.jwt.claim.sub), then rolls back unless commit=true.
 * Copied from the spec 117 rls-rpc rig.
 */
async function asRole(
  pool: Pool,
  role: Role,
  sub: string | null,
  fn: (client: PoolClient) => Promise<void>,
  opts: { commit?: boolean } = {}
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub ?? '']);
    await fn(client);
    await client.query(opts.commit ? 'COMMIT' : 'ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Single-statement probe as a role, in a rolled-back transaction. */
async function attempt(
  pool: Pool,
  role: Role,
  sub: string | null,
  sql: string,
  params: unknown[] = []
): Promise<Attempt> {
  let result: Attempt = { ok: false, code: undefined, message: undefined, rowCount: 0, rows: [] };
  try {
    await asRole(pool, role, sub, async (client) => {
      try {
        const res = await client.query(sql, params as never[]);
        result = {
          ok: true,
          code: undefined,
          message: undefined,
          rowCount: res.rowCount ?? 0,
          rows: res.rows as Record<string, unknown>[],
        };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        result = { ok: false, code: e.code, message: e.message, rowCount: 0, rows: [] };
      }
    });
  } catch (err) {
    if (!result.ok && !result.code) throw err;
  }
  return result;
}

/** Single-statement probe as the connection (superuser) role. */
async function attemptSuper(pool: Pool, sql: string, params: unknown[] = []): Promise<Attempt> {
  try {
    const res = await pool.query(sql, params as never[]);
    return {
      ok: true,
      code: undefined,
      message: undefined,
      rowCount: res.rowCount ?? 0,
      rows: res.rows as Record<string, unknown>[],
    };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { ok: false, code: e.code, message: e.message, rowCount: 0, rows: [] };
  }
}

async function sectionIndex(pool: Pool): Promise<void> {
  console.log('\n(a) idx_queue_items_publishing_claimed catalog state');
  const { rows } = await pool.query<{
    indexrelid: string;
    is_valid: boolean;
    columns: string;
    predicate: string | null;
  }>(`
    SELECT ix.indexrelid::regclass::text AS indexrelid,
           ix.indisvalid AS is_valid,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
           ) AS columns,
           pg_get_expr(ix.indpred, ix.indrelid) AS predicate
      FROM pg_index ix
      JOIN pg_class c ON c.oid = ix.indexrelid
     WHERE c.relname = 'idx_queue_items_publishing_claimed'
  `);
  if (!hardened) {
    check(rows.length === 0, 'index absent before the hygiene migration (finding present)');
    return;
  }
  check(rows.length === 1, 'index exists', `found ${rows.length}`);
  if (rows.length !== 1) return;
  const row = rows[0]!;
  check(row.indexrelid.includes('queue_items'), 'index is on public.queue_items', row.indexrelid);
  check(row.is_valid, 'index is valid');
  check(row.columns === 'platform,claimed_at', 'columns are (platform, claimed_at) in order', row.columns);
  check(
    row.predicate !== null && row.predicate.includes('status') && row.predicate.includes('publishing'),
    "partial predicate is status = 'publishing'",
    row.predicate ?? 'null'
  );
}

async function sectionAcls(pool: Pool): Promise<void> {
  console.log('\n(b) trigger-function EXECUTE ACLs');
  for (const fn of TRIGGER_FUNCTIONS) {
    const { rows } = await pool.query<{
      exists_: boolean;
      rettype: string | null;
      pub: boolean | null;
      anon_: boolean | null;
      auth_: boolean | null;
      proacl: string | null;
    }>(
      `SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                       WHERE n.nspname = 'public' AND p.proname = $1) AS exists_,
              (SELECT pg_catalog.format_type(p.prorettype, NULL) FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1) AS rettype,
              (SELECT has_function_privilege('public', p.oid, 'EXECUTE') FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1) AS pub,
              (SELECT has_function_privilege('anon', p.oid, 'EXECUTE') FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1) AS anon_,
              (SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1) AS auth_,
              (SELECT p.proacl::text FROM pg_proc p
                 JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = $1 LIMIT 1) AS proacl`,
      [fn]
    );
    const r = rows[0]!;
    check(r.exists_, `${fn}() exists`);
    check(r.rettype === 'trigger', `${fn}() returns trigger (not PostgREST-exposable)`, String(r.rettype));
    if (hardened) {
      check(r.pub === false, `${fn}(): PUBLIC EXECUTE removed`, `proacl=${r.proacl}`);
      check(r.anon_ === false, `${fn}(): anon EXECUTE removed (was via PUBLIC)`);
      check(r.auth_ === false, `${fn}(): authenticated EXECUTE removed (was via PUBLIC)`);
    } else {
      check(r.pub === true, `${fn}(): PUBLIC EXECUTE still present before the migration`, `proacl=${r.proacl}`);
    }
  }
  // Live probe: a direct call as `authenticated` must meet the ACL check
  // (42501) after the revoke; before it, the call gets past the ACL and
  // fails later (a trigger function refuses direct invocation), which is
  // exactly the needless surface the migration removes.
  const probe = await attempt(pool, 'authenticated', USER_A, 'SELECT public.set_updated_at()');
  if (hardened) {
    check(
      !probe.ok && probe.code === '42501',
      'direct SELECT public.set_updated_at() as authenticated -> 42501',
      probe.ok ? 'call succeeded' : `${probe.code} ${probe.message}`
    );
  } else {
    check(
      !probe.ok && probe.code !== '42501',
      'direct SELECT public.set_updated_at() as authenticated passes the ACL check pre-migration',
      `${probe.code} ${probe.message}`
    );
  }
}

async function sectionTriggers(pool: Pool): Promise<void> {
  console.log('\n(c) triggers still fire after the revokes');

  // guard_users_role_status: authenticated self-escalation is rejected.
  const guard = await attempt(pool, 'authenticated', USER_A, 'UPDATE public.users SET role = $2 WHERE id = $1', [
    USER_A,
    'admin',
  ]);
  check(
    !guard.ok && guard.code === '42501',
    'guard_users_role_status fires: authenticated UPDATE users.role -> 42501',
    guard.ok ? 'update succeeded' : `${guard.code}`
  );

  // canonicalize_user_email: a fresh INSERT is canonicalized.
  const ins = await attemptSuper(
    pool,
    `INSERT INTO public.users (id, email, name) VALUES ($1::uuid, 'Db.Hygiene+rig@googlemail.com', 'Rig User C')`,
    [USER_C]
  );
  check(ins.ok, 'INSERT user C (canonicalize probe) succeeds', `${ins.code} ${ins.message}`);
  const canon = await pool.query<{ normalized_email: string }>(
    'SELECT normalized_email FROM public.users WHERE id = $1',
    [USER_C]
  );
  check(
    canon.rows[0]?.normalized_email === 'dbhygiene@gmail.com',
    'canonicalize_user_email fires: normalized_email canonicalized on INSERT',
    `stored ${canon.rows[0]?.normalized_email}`
  );

  // set_updated_at: fixture users carry updated_at = now() - 1 day; an
  // UPDATE of an unrelated column must bump it to ~now.
  const bump = await attemptSuper(pool, 'UPDATE public.users SET name = $2 WHERE id = $1', [
    USER_A,
    'Rig User A Renamed',
  ]);
  check(bump.ok && bump.rowCount === 1, 'UPDATE users.name succeeds', `${bump.code} ${bump.message}`);
  const after = await pool.query<{ recent: boolean }>(
    `SELECT updated_at > now() - INTERVAL '1 minute' AS recent FROM public.users WHERE id = $1`,
    [USER_A]
  );
  check(after.rows[0]?.recent === true, 'set_updated_at fires: updated_at bumped on UPDATE');

  // prevent_workspace_owner_transfer: owner_id is immutable.
  const transfer = await attemptSuper(pool, 'UPDATE public.workspaces SET owner_id = $2 WHERE id = $1', [
    WS_A,
    USER_B,
  ]);
  check(
    !transfer.ok && (transfer.message ?? '').includes('immutable'),
    'prevent_workspace_owner_transfer fires: owner change rejected',
    transfer.ok ? 'update succeeded' : `${transfer.code} ${transfer.message}`
  );

  // check_media_folders_cycle: pointing the parent folder at its own
  // child creates a cycle and must raise 23514.
  const cycle = await attemptSuper(pool, 'UPDATE public.media_folders SET parent_id = $2 WHERE id = $1', [
    FOLDER_PARENT,
    FOLDER_CHILD,
  ]);
  check(
    !cycle.ok && cycle.code === '23514',
    'check_media_folders_cycle fires: cycle rejected with 23514',
    cycle.ok ? 'update succeeded' : `${cycle.code} ${cycle.message}`
  );
}

async function sectionRecovery(pool: Pool): Promise<void> {
  console.log('\n(d) recovery sweep end-to-end (unified overload)');
  // Committed on purpose (unlike the rolled-back probes elsewhere):
  // the row-state assertions below verify the sweep's effects.
  let recovered: number | undefined;
  let callErr: { code?: string; message?: string } | undefined;
  try {
    await asRole(
      pool,
      'service_role',
      null,
      async (client) => {
        try {
          const res = await client.query<{ n: number }>(
            `SELECT public.recover_stuck_publishing_items('facebook'::public.platform, 10) AS n`
          );
          recovered = res.rows[0]?.n;
        } catch (err) {
          callErr = err as { code?: string; message?: string };
          throw err;
        }
      },
      { commit: true }
    );
  } catch {
    // callErr captured above; the assertions report it.
  }
  check(callErr === undefined, 'recover_stuck_publishing_items(facebook, 10) executes as service_role', `${callErr?.code} ${callErr?.message}`);
  check(recovered === 2, 'exactly the 2 stale facebook rows are recovered', `returned ${recovered}`);
  const { rows } = await pool.query<{ id: string; status: string; claimed_at: string | null }>(
    'SELECT id, status, claimed_at FROM public.queue_items WHERE id = ANY($1::uuid[]) ORDER BY id',
    [[ITEM_STALE_FB, ITEM_FRESH_FB, ITEM_STALE_IG, ITEM_STALE_FB_NULLCLAIM]]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  check(
    byId.get(ITEM_STALE_FB)?.status === 'queued' && byId.get(ITEM_STALE_FB)?.claimed_at === null,
    'stale facebook row re-queued with claimed_at cleared'
  );
  check(
    byId.get(ITEM_STALE_FB_NULLCLAIM)?.status === 'queued' &&
      byId.get(ITEM_STALE_FB_NULLCLAIM)?.claimed_at === null,
    'stale facebook row with claimed_at NULL recovered via COALESCE(updated_at)'
  );
  check(byId.get(ITEM_FRESH_FB)?.status === 'publishing', 'fresh facebook row left publishing');
  check(byId.get(ITEM_STALE_IG)?.status === 'publishing', 'stale instagram row left publishing (platform filter)');
}

async function sectionExplain(pool: Pool): Promise<void> {
  console.log('\n(e) recovery-filter query plan');
  if (!hardened) {
    console.log('  skipped in vulnerable mode (index does not exist yet)');
    return;
  }
  await pool.query('SELECT public.dbhygiene_seed_bulk()');
  await pool.query('ANALYZE public.queue_items');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`
      EXPLAIN (COSTS OFF)
      SELECT id FROM public.queue_items
       WHERE status = 'publishing'
         AND platform = 'facebook'::public.platform
         AND COALESCE(claimed_at, updated_at) <= now() - INTERVAL '10 minutes'
    `);
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    console.log(
      plan
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n')
    );
    check(
      plan.includes('idx_queue_items_publishing_claimed'),
      'plan uses idx_queue_items_publishing_claimed for the sweep filter shape'
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

async function sectionIdempotent(pool: Pool): Promise<void> {
  console.log('\n(f) migration idempotency');
  if (!hardened) {
    console.log('  skipped in vulnerable mode (migration not in this chain)');
    return;
  }
  const file = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('_db_hygiene.sql'))
    .sort()
    .at(-1);
  check(file !== undefined, 'hygiene migration file found', migrationsDir);
  if (!file) return;
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  const again = await attemptSuper(pool, sql);
  check(again.ok, `re-applying ${file} exits clean`, `${again.code} ${again.message}`);
}

const DEST_A = 'f0000000-0000-0000-0000-000000000002';
const DEST_B = 'f0000000-0000-0000-0000-0000000000b2';
const ACCOUNT_A = 'f0000000-0000-0000-0000-000000000001';

async function sectionPostingSlots(pool: Pool): Promise<void> {
  console.log('\n(g) posting_slots UNIQUE(destination_id, time_of_day) — spec 139 N5');
  // Self-cleaning: the section commits its probes, so clear any slots it
  // owns before and after (fixture reset truncates destinations CASCADE,
  // which already removes slots, but re-runs of check.ts on one database
  // must see the same start state).
  await pool.query('DELETE FROM public.posting_slots WHERE destination_id = ANY($1::uuid[])', [
    [DEST_A, DEST_B],
  ]);
  await pool.query('DELETE FROM public.destinations WHERE id = $1', [DEST_B]);

  const { rows } = await pool.query<{ contype: string; columns: string | null }>(`
    SELECT c.contype::text AS contype,
           (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
              FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
           ) AS columns
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND t.relname = 'posting_slots'
       AND c.conname = 'uq_posting_slots_destination_time'
  `);
  if (!hardened) {
    check(rows.length === 0, 'constraint absent before the N5 migration (finding present)');
    const first = await attemptSuper(
      pool,
      'INSERT INTO public.posting_slots (destination_id, time_of_day) VALUES ($1::uuid, $2::time)',
      [DEST_A, '09:30']
    );
    check(first.ok, 'vulnerable: first slot insert succeeds', `${first.code} ${first.message}`);
    const dup = await attemptSuper(
      pool,
      'INSERT INTO public.posting_slots (destination_id, time_of_day) VALUES ($1::uuid, $2::time)',
      [DEST_A, '09:30']
    );
    check(dup.ok, 'vulnerable: duplicate (destination_id, time_of_day) insert succeeds (finding present)', `${dup.code} ${dup.message}`);
    await pool.query('DELETE FROM public.posting_slots WHERE destination_id = ANY($1::uuid[])', [
      [DEST_A, DEST_B],
    ]);
    return;
  }
  check(rows.length === 1, 'constraint exists', `found ${rows.length}`);
  if (rows.length === 1) {
    check(rows[0]!.contype === 'u', 'constraint is UNIQUE (contype u)', rows[0]!.contype);
    check(
      rows[0]!.columns === 'destination_id,time_of_day',
      'constraint columns are (destination_id, time_of_day) in order',
      rows[0]!.columns ?? 'null'
    );
  }

  const first = await attemptSuper(
    pool,
    'INSERT INTO public.posting_slots (destination_id, time_of_day) VALUES ($1::uuid, $2::time)',
    [DEST_A, '09:30']
  );
  check(first.ok, 'first slot at (dest A, 09:30) inserts', `${first.code} ${first.message}`);

  const dup = await attemptSuper(
    pool,
    'INSERT INTO public.posting_slots (destination_id, time_of_day) VALUES ($1::uuid, $2::time)',
    [DEST_A, '09:30']
  );
  check(
    !dup.ok && dup.code === '23505' && (dup.message ?? '').includes('uq_posting_slots_destination_time'),
    'duplicate active slot at (dest A, 09:30) rejected 23505 by uq_posting_slots_destination_time',
    dup.ok ? 'insert succeeded' : `${dup.code} ${dup.message}`
  );

  const dupInactive = await attemptSuper(
    pool,
    'INSERT INTO public.posting_slots (destination_id, time_of_day, is_active) VALUES ($1::uuid, $2::time, false)',
    [DEST_A, '09:30']
  );
  check(
    !dupInactive.ok && dupInactive.code === '23505',
    'duplicate INACTIVE slot at (dest A, 09:30) also rejected — plain unique, is_active is a toggle, not soft-delete',
    dupInactive.ok ? 'insert succeeded' : `${dupInactive.code} ${dupInactive.message}`
  );

  const otherTime = await attemptSuper(
    pool,
    'INSERT INTO public.posting_slots (destination_id, time_of_day) VALUES ($1::uuid, $2::time)',
    [DEST_A, '10:45']
  );
  check(otherTime.ok, 'distinct time at dest A (10:45) inserts', `${otherTime.code} ${otherTime.message}`);

  const mkDest = await attemptSuper(
    pool,
    `INSERT INTO public.destinations (id, workspace_id, account_id, platform, external_destination_id, name, encrypted_destination_token, status, section)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'facebook', 'ext-dest-b', 'Rig Unified Dest B', 'dummy-encrypted-destination-token', 'active', 'schedule')`,
    [DEST_B, WS_A, ACCOUNT_A]
  );
  check(mkDest.ok, 'second destination fixture inserts', `${mkDest.code} ${mkDest.message}`);
  const otherDest = await attemptSuper(
    pool,
    'INSERT INTO public.posting_slots (destination_id, time_of_day) VALUES ($1::uuid, $2::time)',
    [DEST_B, '09:30']
  );
  check(otherDest.ok, 'same time at a distinct destination (dest B, 09:30) inserts', `${otherDest.code} ${otherDest.message}`);

  const file = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('_posting_slots_unique.sql'))
    .sort()
    .at(-1);
  check(file !== undefined, 'posting_slots unique migration file found', migrationsDir);
  if (file) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const again = await attemptSuper(pool, sql);
    check(again.ok, `re-applying ${file} exits clean (idempotent)`, `${again.code} ${again.message}`);
  }

  await pool.query('DELETE FROM public.posting_slots WHERE destination_id = ANY($1::uuid[])', [
    [DEST_A, DEST_B],
  ]);
  await pool.query('DELETE FROM public.destinations WHERE id = $1', [DEST_B]);
}

async function dumpState(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ line: string }>(`
    SELECT format('%s  proacl=%s', p.proname, COALESCE(p.proacl::text, '(default: EXECUTE TO PUBLIC)')) AS line
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])
     ORDER BY p.proname
  `, [TRIGGER_FUNCTIONS as unknown as string[]]);
  console.log('\nACL summary:');
  for (const r of rows) console.log(`  ${r.line}`);
  const idx = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_queue_items_publishing_claimed'`
  );
  console.log(`  index: ${idx.rows[0]?.indexdef ?? '(absent)'}`);
  const uq = await pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname = 'posting_slots'
        AND c.conname = 'uq_posting_slots_destination_time'`
  );
  console.log(`  posting_slots unique: ${uq.rows[0]?.def ?? '(absent)'}`);
}

async function main(): Promise<void> {
  const url = process.env.DB_HYGIENE_PG_URL;
  if (!url) throw new Error('DB_HYGIENE_PG_URL is required');
  console.log(`db-hygiene rig — mode=${mode}`);
  const pool = new Pool({ connectionString: url });
  try {
    const fixtures = readFileSync(join(here, 'fixtures.sql'), 'utf8');
    await pool.query(fixtures);
    await pool.query('SELECT public.dbhygiene_reset()');

    await sectionIndex(pool);
    await sectionAcls(pool);
    await sectionTriggers(pool);
    await sectionRecovery(pool);
    await sectionExplain(pool);
    await sectionIdempotent(pool);
    await sectionPostingSlots(pool);
    await dumpState(pool);
  } finally {
    await pool.end();
  }
  console.log(`\n${checks} assertions, ${failures} failures`);
  if (failures > 0) process.exit(1);
}

try {
  await main();
} catch (err) {
  console.error('db-hygiene rig FAILED:', err);
  process.exit(1);
}
