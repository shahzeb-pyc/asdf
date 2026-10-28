/**
 * @file prompt-library-taxonomy-migration.test.ts
 * @description Guards the taxonomy-relaxation migration file's
 * contents: it must drop EXACTLY the tool/category/language CHECK
 * constraints (no others), add only light guards in their place,
 * and touch nothing else.
 *
 * Honest limit: this guards the file's text, it does not execute
 * the SQL (no live database in unit tests). The migration is
 * proven only when the parent applies it and verifies prompts
 * with new taxonomy values can be created.
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
    "20261028140000_relax_prompt_library_taxonomy.sql",
  ),
  "utf8",
);

describe("prompt library taxonomy relaxation migration file", () => {
  it("drops exactly the tool, category, and language CHECK constraints", () => {
    for (const column of ["tool", "category", "language"]) {
      expect(sql).toContain(
        `DROP CONSTRAINT IF EXISTS prompt_library_prompts_${column}_check`,
      );
    }
  });

  it("drops no other constraints and no columns", () => {
    expect(sql).not.toContain("DROP CONSTRAINT IF EXISTS prompt_library_prompts_status_check");
    expect(sql).not.toContain("DROP CONSTRAINT IF EXISTS prompt_library_prompts_video_length_bucket_check");
    expect(sql).not.toContain("DROP CONSTRAINT IF EXISTS prompt_library_prompts_format_check");
    expect(sql).not.toContain("DROP CONSTRAINT IF EXISTS prompt_library_prompts_format_aspect");
    expect(sql).not.toContain("DROP CONSTRAINT IF EXISTS prompt_library_prompts_video_poster");
    expect(sql).not.toContain("DROP COLUMN");
  });

  it("adds only light guards: non-empty + max length, language code shape", () => {
    expect(sql).toContain("prompt_library_prompts_tool_guarded");
    expect(sql).toContain("prompt_library_prompts_category_guarded");
    expect(sql).toContain("prompt_library_prompts_language_guarded");
    expect(sql).toContain("char_length(tool) <= 100");
    expect(sql).toContain("char_length(category) <= 100");
    expect(sql).toContain("^[a-z]{2,5}$");
  });
});
