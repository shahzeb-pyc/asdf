/**
 * Regression test for the PR #56 SEND BACK finding: the worker's ADU
 * stale-publish path reads adu_posting_jobs.updated_at, but the
 * original ADU table migration defined that table without the column
 * and attached no trigger — so the stale select would error on an
 * unknown column once the tables exist. Migration
 * 20261031000000_adu_posting_jobs_updated_at.sql adds the column and
 * the shared set_updated_at() trigger. This test reads that migration
 * file (not a fake DB, which accepts any column name) and asserts the
 * column + trigger are really there.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('ADU posting jobs updated_at migration', () => {
  const migrationsDir = path.resolve(process.cwd(), '../../supabase/migrations');

  it('adds updated_at with a BEFORE UPDATE trigger on adu_posting_jobs', () => {
    const files = fs.readdirSync(migrationsDir);
    const migrationFile = files.find((f) => f.includes('adu_posting_jobs_updated_at'));

    expect(migrationFile).toBeDefined();

    const sqlContent = fs.readFileSync(path.join(migrationsDir, migrationFile!), 'utf-8');

    expect(sqlContent).toMatch(
      /ALTER\s+TABLE\s+(?:public\.)?adu_posting_jobs\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+updated_at\s+timestamptz/i,
    );
    expect(sqlContent).toMatch(
      /CREATE\s+TRIGGER\s+\S+\s+BEFORE\s+UPDATE\s+ON\s+(?:public\.)?adu_posting_jobs/i,
    );
    expect(sqlContent).toMatch(/EXECUTE\s+FUNCTION\s+(?:public\.)?set_updated_at\(\)/i);
  });
});
