"use client";

import * as React from "react";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";

import { Input } from "@/components/shared/ui/input";

/**
 * Prompt Library top section — STEP 1 ONLY, corrected.
 *
 * Structure only, app's own identity. The reference image supplied the
 * structure — centred hero, a large heading, a subtitle, then a wide
 * search card containing the search input and the filter controls
 * inside that same card — and nothing else from it. Its exact copy, cream/red colours,
 * and ad-format pills were removed in a correction, and the eyebrow
 * pill, primary button, and category pill row were removed entirely
 * at Shahzeb's direction (no replacements).
 *
 * This is the whole page for this step: hero + search/filter row,
 * and nothing below it. No grid, no cards, no detail view, no copy
 * action, no demo media, no backend — those are later steps, decided
 * by Shahzeb. The filters below are UI state only: selecting one
 * changes its trigger label and active state, and filters nothing
 * yet, because there is no content below to filter.
 *
 * Design-system primitives + tokens only: no literal colours, no
 * inline styles. Filter triggers are plain text (no pill shape, no
 * border, no background fill); a changed filter shows in gold with
 * an underline. Dropdowns are a simple accessible list in this
 * component rather than the shared Radix Menu primitive, so the
 * one-open-at-a-time behaviour and mobile overflow stay explicit
 * and testable without a portal.
 */
type FilterKey = "category" | "tool" | "length" | "sort";

const FILTER_OPTIONS: Record<FilterKey, readonly string[]> = {
  category: ["All", "Animals", "Comedy", "Cinematic", "UGC", "Tutorial", "Unboxing"],
  tool: ["All", "Dola AI", "Veo 3", "Google Flow"],
  length: ["All", "Under 15s", "15-30s", "30s+"],
  sort: ["Newest", "Most copied", "A to Z"],
};

const FILTER_LABELS: Record<FilterKey, string> = {
  category: "Category",
  tool: "Tool",
  length: "Length",
  sort: "Sort",
};

const FILTER_DEFAULTS: Record<FilterKey, string> = {
  category: "All",
  tool: "All",
  length: "All",
  sort: "Newest",
};

export function PromptTopSection() {
  const [query, setQuery] = React.useState("");
  const [values, setValues] = React.useState<Record<FilterKey, string>>(FILTER_DEFAULTS);
  const [openFilter, setOpenFilter] = React.useState<FilterKey | null>(null);

  const isActive =
    query !== "" ||
    (Object.keys(FILTER_DEFAULTS) as FilterKey[]).some(
      (key) => values[key] !== FILTER_DEFAULTS[key],
    );

  const resetAll = () => {
    setQuery("");
    setValues(FILTER_DEFAULTS);
    setOpenFilter(null);
  };

  return (
    <section
      data-testid="prompt-top-section"
      className="overflow-hidden bg-canvas px-4 py-12 sm:px-6 sm:py-16"
    >
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <h1 className="text-5xl font-bold leading-[1.05] tracking-tight text-ink sm:text-6xl">
          Master Prompts Library
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-ink-sub sm:text-lg">
          Find a prompt, view the full text, and copy it into your video tool.
        </p>
      </div>

      <div
        data-testid="prompt-top-section-search-card"
        className="mx-auto mt-10 w-full max-w-5xl rounded-2xl border border-line bg-panel p-3 shadow-card sm:p-4"
      >
      <div
        data-testid="prompt-top-section-filter-row"
        className="flex flex-wrap items-center gap-x-5 gap-y-3"
      >
        <label className="flex w-full shrink-0 items-center gap-2 rounded-xl border border-line bg-panel px-3 py-1 sm:w-80">
          <SearchIcon aria-hidden className="size-5 shrink-0 text-ink-sub" />
          <Input
            data-testid="prompt-top-section-search"
            type="search"
            placeholder="Search prompts…"
            aria-label="Search prompts…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="border-0 bg-transparent shadow-none focus-visible:border-transparent"
          />
        </label>

        {(Object.keys(FILTER_OPTIONS) as FilterKey[]).map((key) => {
          const changed = values[key] !== FILTER_DEFAULTS[key];
          const open = openFilter === key;
          return (
            <div key={key} className="relative">
              <button
                type="button"
                data-testid={`prompt-top-section-filter-${key}`}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpenFilter(open ? null : key)}
                className={
                  changed
                    ? "flex items-center gap-1 text-sm font-semibold text-brand-gold underline underline-offset-4"
                    : "flex items-center gap-1 text-sm font-semibold text-ink"
                }
              >
                {FILTER_LABELS[key]}: {values[key]}
                <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
              </button>
              {open ? (
                <div
                  role="listbox"
                  aria-label={FILTER_LABELS[key]}
                  data-testid={`prompt-top-section-filter-${key}-options`}
                  className="absolute left-0 top-full z-popover mt-1 min-w-48 rounded-md border border-line bg-panel p-1 shadow-elevated"
                >
                  {FILTER_OPTIONS[key].map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="option"
                      aria-selected={values[key] === option}
                      onClick={() => {
                        setValues((previous) => ({ ...previous, [key]: option }));
                        setOpenFilter(null);
                      }}
                      className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left text-body text-ink hover:bg-hover"
                    >
                      {values[key] === option ? (
                        <CheckIcon aria-hidden className="size-4 shrink-0" />
                      ) : (
                        <span aria-hidden className="size-4 shrink-0" />
                      )}
                      {option}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}

        {isActive ? (
          <button
            type="button"
            data-testid="prompt-top-section-clear-all"
            onClick={resetAll}
            className="text-sm font-semibold text-brand-gold"
          >
            Clear all
          </button>
        ) : null}
      </div>
      </div>
    </section>
  );
}
