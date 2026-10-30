-- =============================================================================
-- Migration: 20261028140000_relax_prompt_library_taxonomy.sql
-- Prompt Library: category / tool / language are no longer DB enums.
--
-- CREATED here but NOT APPLIED by the builder. The parent (Kafka)
-- reviews and applies it himself afterwards, as with the previous
-- prompt-library migrations.
--
-- Why: today tool, category, and language are CHECK enums in
-- prompt_library_prompts AND Zod enums in contracts, so a brand-new
-- category (or tool, or language) needs a code change + migration
-- before any prompt can use it. Dynamic facets already show
-- whatever is in the DB, but nothing new could get into the DB —
-- this change closes that loop: after this migration, an admin
-- adds a new category/tool/language by simply using it in an
-- admin create call, with NO migration needed.
--
-- Typo risk is controlled at the admin layer, not by the DB enum:
-- writes go through the admin-only API (session.role = 'admin'),
-- which normalises values (category/tool lowercased, single
-- spaces; language lowercased ISO-style codes) and validates them
-- in contracts. No separate taxonomy table is invented.
--
-- What changes here, exactly:
--   DROPPED: the CHECK constraints on tool, category, language.
--   KEPT: NOT NULL on all three, and every other constraint —
--   status enum, length-bucket enum, format enum, format/aspect
--   invariant, video-poster rule, prompts/ prefix rules,
--   copied_count >= 0. Status, length, and format are SYSTEM
--   values, not growing taxonomies, so they stay as enums.
--   ADDED: light guards only, so the columns are not unconstrained
--   free-for-all text — tool/category must be non-empty (after
--   trimming) and at most 100 characters; language must be a
--   lowercase ISO-style code of 2-5 letters.
-- Existing data is untouched: the demo prompts' values
-- (dola_ai/veo3/google_flow, animals/comedy/cinematic/unboxing,
-- en/ur/hi) all pass the new guards.
-- =============================================================================

ALTER TABLE public.prompt_library_prompts
  DROP CONSTRAINT IF EXISTS prompt_library_prompts_tool_check,
  DROP CONSTRAINT IF EXISTS prompt_library_prompts_category_check,
  DROP CONSTRAINT IF EXISTS prompt_library_prompts_language_check;

ALTER TABLE public.prompt_library_prompts
  ADD CONSTRAINT prompt_library_prompts_tool_guarded
    CHECK (btrim(tool) <> '' AND char_length(tool) <= 100),
  ADD CONSTRAINT prompt_library_prompts_category_guarded
    CHECK (btrim(category) <> '' AND char_length(category) <= 100),
  ADD CONSTRAINT prompt_library_prompts_language_guarded
    CHECK (language ~ '^[a-z]{2,5}$');

COMMENT ON TABLE public.prompt_library_prompts IS
  'Admin-only prompt catalogue. Tool, category, and language are free text guarded only by length/format rules (see the *_guarded constraints) — new values need no migration; the admin API normalises and validates them. Status, length, and format remain enums: they are system values, not growing taxonomies.';
