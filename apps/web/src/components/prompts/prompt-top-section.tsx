"use client";

import * as React from "react";
import { SearchIcon } from "lucide-react";

import { Button } from "@/components/shared/ui/button";
import { Input } from "@/components/shared/ui/input";

/**
 * Prompt Library top section — STEP 1 ONLY, corrected.
 *
 * Structure only, app's own identity. The reference image supplied the
 * structure — centred hero, a small pill above the heading, a large
 * heading, a subtitle, a primary button, then a wide search card
 * containing a full-width search input plus a row of category pills —
 * and nothing else from it. Its exact copy, cream/red colours, and
 * ad-format pills were removed in this correction.
 *
 * This is the whole page for this step: hero + search card, and
 * nothing below it. No grid, no cards, no detail view, no copy action,
 * no demo media, no backend — those are later steps, decided by Shahzeb.
 * Design-system primitives + tokens only: no literal colours, no inline
 * styles. Active pill is the Button default (Binance gold-on-black via
 * tokens); inactive pills are the outline variant.
 */
export const PROMPT_TOP_CATEGORIES = ["All", "Animals", "Comedy", "Cinematic"] as const;

function pillTestId(category: string) {
  return `prompt-top-section-pill-${category.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
}

export function PromptTopSection() {
  const [activeCategory, setActiveCategory] = React.useState<string>("All");
  const searchWrapRef = React.useRef<HTMLLabelElement>(null);

  // "Browse prompts" is a top-section action for this step only: it
  // scrolls to and focuses the search box below. It opens no new page,
  // signup, or generator flow — those do not exist yet.
  const focusSearch = () => {
    const input = searchWrapRef.current?.querySelector("input");
    input?.scrollIntoView?.({ block: "center" });
    input?.focus();
  };

  return (
    <section
      data-testid="prompt-top-section"
      className="overflow-hidden bg-canvas px-4 py-12 sm:px-6 sm:py-16"
    >
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <span className="rounded-full border border-line bg-panel px-3 py-1 text-metadata font-medium text-ink-sub">
          AI video prompts
        </span>
        <h1 className="mt-5 text-5xl font-bold leading-[1.05] tracking-tight text-ink sm:text-6xl">
          Prompt Library
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-ink-sub sm:text-lg">
          Find a prompt, view the full text, and copy it into your video tool.
        </p>
        <Button
          data-testid="prompt-top-section-browse-prompts"
          size="lg"
          onClick={focusSearch}
          className="mt-7 h-11 rounded-lg px-7 text-base font-medium"
        >
          Browse prompts
        </Button>
      </div>

      <div
        data-testid="prompt-top-section-search-card"
        className="mx-auto mt-10 w-full max-w-5xl rounded-2xl border border-line bg-panel p-3 shadow-card sm:p-4"
      >
        <label
          ref={searchWrapRef}
          className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-1"
        >
          <SearchIcon aria-hidden className="size-5 shrink-0 text-ink-sub" />
          <Input
            data-testid="prompt-top-section-search"
            type="search"
            placeholder="Search by title or words in the prompt"
            aria-label="Search by title or words in the prompt"
            className="border-0 bg-transparent shadow-none focus-visible:border-transparent"
          />
        </label>

        <div
          role="group"
          aria-label="Prompt categories"
          className="mt-3 flex flex-wrap gap-2"
        >
          {PROMPT_TOP_CATEGORIES.map((category) => {
            const active = category === activeCategory;
            return (
              <Button
                key={category}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                data-testid={pillTestId(category)}
                onClick={() => setActiveCategory(category)}
                className="rounded-full px-4"
              >
                {category}
              </Button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
