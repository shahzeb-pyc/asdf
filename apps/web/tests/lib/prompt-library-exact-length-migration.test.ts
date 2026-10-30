/**
 * @file prompt-library-exact-length-migration.test.ts
 * @description Guards the exact-length migration file's contents:
 * it must ADD ONLY the video_duration_seconds column (nullable,
 * >= 0) and alter nothing else — in particular it must not touch
 * video_length_bucket, its enum, or any other column/constraint.
 *
 * Honest limit: this guards the file's text, it does not execute
 * the SQL (no live database in unit tests). The migration is
 * proven only when the parent applies it and verifies a prompt's
 * exact length can be set and read back.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    process.cwd(),
    "..",
    "..",
    "supabase",
    "migrations",
    "20261028150000_exact_prompt_length.sql",
  ),
  "utf8",
);

describe("prompt library exact-length migration file", () => {
  it("adds only the video_duration_seconds column, nullable and >= 0", () => {
    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS video_duration_seconds INTEGER",
    );
    expect(sql).toContain("CHECK (video_duration_seconds >= 0)");
  });

  it("alters nothing else: no drops, no renames, no bucket change", () => {
    expect(sql).not.toContain("DROP COLUMN");
    expect(sql).not.toContain("DROP CONSTRAINT");
    expect(sql).not.toContain("RENAME");
    expect(sql).not.toContain("ALTER COLUMN video_length_bucket");
    expect(sql).not.toContain(
      "DROP CONSTRAINT IF EXISTS prompt_library_prompts_video_length_bucket_check",
    );
    // The bucket enum must not be redefined here (naming the bucket
    // values in a comment is fine — redefining its CHECK is not).
    expect(sql).not.toContain("video_length_bucket IN");
    expect(sql).not.toContain("CHECK (video_length_bucket");
  });
});
