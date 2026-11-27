/**
 * @file normalized-email-trigger-migration.test.ts
 * @description Regression test for ISSUE-45: trg_canonicalize_user_email Bypassed on Direct normalized_email Updates
 *
 * Verifies that:
 * 1. A forward migration updates trg_canonicalize_user_email to fire on BEFORE INSERT OR UPDATE OF email, normalized_email ON users.
 * 2. canonicalize_user_email() handles both email and normalized_email modifications, canonicalizing them identically.
 * 3. Empty usernames before '@' raise clean exceptions rather than leaking unhandled check constraint failures.
 * 4. All non-alphanumeric characters are stripped from the username and domain is restricted strictly to @gmail.com or @googlemail.com.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('ISSUE-45: trg_canonicalize_user_email Bypassed on Direct normalized_email Updates', () => {
  const migrationsDir = path.resolve(process.cwd(), '../../supabase/migrations');

  it('provides a forward database migration ensuring trigger fires on email and normalized_email updates with clean exception handling', () => {
    const files = fs.readdirSync(migrationsDir);
    const migrationFile = files.find((f) => f.includes('fix_normalized_email_trigger_and_check_constraint'));

    expect(migrationFile).toBeDefined();

    const sqlContent = fs.readFileSync(path.join(migrationsDir, migrationFile!), 'utf-8');

    // 1. Asserts function definition
    expect(sqlContent).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?canonicalize_user_email\(\)/i);

    // 2. Asserts trigger fires on BEFORE INSERT OR UPDATE OF email, normalized_email ON users
    expect(sqlContent).toMatch(/CREATE\s+TRIGGER\s+trg_canonicalize_user_email\s+BEFORE\s+INSERT\s+OR\s+UPDATE\s+OF\s+email,\s*normalized_email\s+ON\s+users/i);

    // 3. Asserts clean exception handling for empty username
    expect(sqlContent).toMatch(/RAISE\s+EXCEPTION\s+['"]Email username cannot be empty['"]/i);

    // 4. Asserts domain check and exception
    expect(sqlContent).toMatch(/RAISE\s+EXCEPTION\s+['"]Only @gmail\.com or @googlemail\.com email addresses are permitted['"]/i);

    // 5. Asserts handling for direct normalized_email update branch
    expect(sqlContent).toMatch(/ELSIF\s+NEW\.normalized_email\s+IS\s+NOT\s+NULL\s+THEN/i);

    // 6. Asserts non-alphanumeric character stripping
    expect(sqlContent).toMatch(/regexp_replace\(.*,\s*'\s*\[\^a-z0-9\]\s*',\s*''/i);
  });
});

describe('Spec 261: allow @fbuploadpro.com email addresses', () => {
  const migrationsDir = path.resolve(process.cwd(), '../../supabase/migrations');

  it('provides a forward migration permitting @fbuploadpro.com in canonicalize_user_email() while keeping Gmail behaviour and the user-facing message unchanged', () => {
    const files = fs.readdirSync(migrationsDir);
    const migrationFile = files.find((f) => f.includes('allow_fbuploadpro_email_domain'));

    expect(migrationFile).toBeDefined();

    const sqlContent = fs.readFileSync(path.join(migrationsDir, migrationFile!), 'utf-8');

    // 1. Replaces the trigger function.
    expect(sqlContent).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?canonicalize_user_email\(\)/i);

    // 2. Both branches (email + direct normalized_email) admit fbuploadpro.com:
    // the allow-list appears once per branch.
    const allowList = sqlContent.match(
      /NOT\s+IN\s*\(\s*'gmail\.com'\s*,\s*'googlemail\.com'\s*,\s*'fbuploadpro\.com'\s*\)/gi
    );
    expect(allowList).not.toBeNull();
    expect(allowList!.length).toBeGreaterThanOrEqual(2);

    // 3. A @fbuploadpro.com address is normalized as-is (lowercased, trimmed),
    // keeping its real domain — no Gmail dot-stripping / cleaning applied.
    expect(sqlContent).toMatch(/NEW\.normalized_email\s*:=\s*lower\(v_raw_email\)/i);

    // 4. The CHECK constraint accepts the Gmail pattern AND a fbuploadpro.com
    // normalized address (name kept: check_users_gmail_only).
    expect(sqlContent).toMatch(/ADD\s+CONSTRAINT\s+check_users_gmail_only/i);
    expect(sqlContent).toMatch(/normalized_email\s*~\s*'\^\[a-z0-9\._%\+-\]\+@fbuploadpro\\.com\$'/i);

    // 5. Gmail canonicalization is untouched (cleaning + @gmail.com rewrite
    // still present) and the user-facing rejection message is byte-identical.
    expect(sqlContent).toMatch(/regexp_replace\(.*,\s*'\s*\[\^a-z0-9\]\s*',\s*''/i);
    expect(sqlContent).toMatch(/RAISE\s+EXCEPTION\s+['"]Only @gmail\.com or @googlemail\.com email addresses are permitted['"]/i);

    // 6. No broad data cleanup: the migration must not UPDATE existing rows.
    expect(sqlContent).not.toMatch(/^\s*UPDATE\s+users\s+SET/im);
  });
});
