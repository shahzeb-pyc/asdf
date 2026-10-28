"use client";

import * as React from "react";
import { SearchIcon } from "lucide-react";

import { Input } from "@/components/shared/ui/input";

/**
 * Prompt Library top section — STEP 1 ONLY, corrected.
 *
 * Structure only, app's own identity. The reference image supplied the
 * structure — centred hero, a large heading, a subtitle, then a wide
 * search card containing a full-width search input — and nothing else
 * from it. Its exact copy, cream/red colours, and ad-format pills were
 * removed in this correction, and the eyebrow pill, primary button,
 * and category pill row were removed entirely at Shahzeb's direction
 * (no replacements).
 *
 * This is the whole page for this step: hero + search card, and
 * nothing below it. No grid, no cards, no detail view, no copy action,
 * no demo media, no backend — those are later steps, decided by Shahzeb.
 * Design-system primitives + tokens only: no literal colours, no inline
 * styles.
 */
export function PromptTopSection() {
  return (
    <section
      data-testid="prompt-top-section"
      className="overflow-hidden bg-canvas px-4 py-12 sm:px-6 sm:py-16"
    >
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <h1 className="text-5xl font-bold leading-[1.05] tracking-tight text-ink sm:text-6xl">
          Prompt Library
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-ink-sub sm:text-lg">
          Find a prompt, view the full text, and copy it into your video tool.
        </p>
      </div>

      <div
        data-testid="prompt-top-section-search-card"
        className="mx-auto mt-10 w-full max-w-5xl rounded-2xl border border-line bg-panel p-3 shadow-card sm:p-4"
      >
        <label className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-1">
          <SearchIcon aria-hidden className="size-5 shrink-0 text-ink-sub" />
          <Input
            data-testid="prompt-top-section-search"
            type="search"
            placeholder="Search by title or words in the prompt"
            aria-label="Search by title or words in the prompt"
            className="border-0 bg-transparent shadow-none focus-visible:border-transparent"
          />
        </label>
      </div>
    </section>
  );
}
