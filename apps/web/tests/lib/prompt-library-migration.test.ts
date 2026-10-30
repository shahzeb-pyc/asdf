/**
 * @file prompt-library-migration.test.ts
 * @description Guards the multi-media migration file's contents:
 * it must create prompt_library_media with exactly-one-main
 * enforcement, carry every existing single preview over as
 * position 1 / is_main = true, and drop all four old preview
 * columns — one data model, no parallel old+new fields.
 *
 * Honest limit: this guards the file's text, it does not execute
 * the SQL (no live database in unit tests). The migration is
 * proven only when the parent applies it and verifies the demo
 * prompts still show their main media.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "..", "..", "supabase", "migrations", "20261028130000_prompt_library_media.sql"),
  "utf8",
);

describe("prompt library multi-media migration file", () => {
  it("creates prompt_library_media with exactly-one-main enforcement", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.prompt_library_media");
    expect(sql).toContain("REFERENCES public.prompt_library_prompts (id) ON DELETE CASCADE");
    expect(sql).toContain("UNIQUE (prompt_id, position)");
    expect(sql).toContain("WHERE is_main");
  });

  it("carries each existing preview over as position 1, main", () => {
    expect(sql).toContain("INSERT INTO public.prompt_library_media");
    expect(sql).toContain("preview_media_type");
    expect(sql).toContain("preview_storage_key");
    expect(sql).toContain("preview_poster_key");
    expect(sql).toContain("duration_seconds");
    // Position 1 and is_main = true in the carry-over SELECT.
    expect(sql).toMatch(/SELECT\s+id,\s*1,/);
    expect(sql).toContain(", true");
  });

  it("drops all four old single-preview columns and their constraint", () => {
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS prompt_library_prompts_video_poster");
    for (const column of [
      "preview_storage_key",
      "preview_poster_key",
      "preview_media_type",
      "duration_seconds",
    ]) {
      expect(sql).toContain(`DROP COLUMN IF EXISTS ${column}`);
    }
  });
});
