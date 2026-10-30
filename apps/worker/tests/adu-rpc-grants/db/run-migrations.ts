/**
 * Applies the adu-rpc-grants rig bootstrap + repo migrations, in filename
 * order, to a plain PostgreSQL database (spec 139 adu-rpc-grants rig).
 * Modelled on the spec 117 rls-rpc rig's db/run-migrations.ts.
 *
 * Usage:
 *   ADU_RPC_GRANTS_PG_URL=postgres://postgres@/dbhygiene?host=/path/to/pgsocket&port=5432 \
 *     pnpm --filter @fbuploadpro/worker exec tsx tests/db-hygiene/db/run-migrations.ts
 *
 * Prerequisite: the target database exists and is empty (or disposable).
 * See tests/db-hygiene/README.md for the full reproducible setup.
 *
 * ADU_RPC_GRANTS_MIGRATIONS_UNTIL=<filename> applies only migrations up to
 * and including that file — used to build the PRE-HYGIENE database (all
 * migrations except 20261023193000_db_hygiene.sql) for the before-state
 * evidence run.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', '..', '..', 'supabase', 'migrations');

async function main(): Promise<void> {
  const url = process.env.ADU_RPC_GRANTS_PG_URL;
  if (!url) throw new Error('ADU_RPC_GRANTS_PG_URL is required');
  const until = process.env.ADU_RPC_GRANTS_MIGRATIONS_UNTIL;
  const pool = new Pool({ connectionString: url });
  try {
    const bootstrap = readFileSync(join(here, 'bootstrap.sql'), 'utf8');
    await pool.query(bootstrap);
    console.log('[migrations] bootstrap applied');

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) => !until || f <= until);
    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      await pool.query(sql);
      console.log(`[migrations] applied ${file}`);
    }
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'"
    );
    console.log(`[migrations] done: ${files.length} migrations, ${rows[0]?.n} public tables`);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch (err) {
  console.error('[migrations] FAILED:', err);
  process.exit(1);
}
