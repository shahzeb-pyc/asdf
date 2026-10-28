"use client";

import * as React from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  HeartIcon,
  SearchIcon,
} from "lucide-react";

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
 * This section is the hero + search/filter rows, laid out as
 * variant A (Shahzeb's choice): row 1 is the search input on its
 * own full-width row; a subtle divider follows; row 2 is all six
 * filter controls on one row — Category, Tool, Language, Length,
 * Sort, then My favorites, then Clear all last when active. Sort
 * is NOT pushed right: the previous ml-auto order (favorites, then
 * Sort at the far right) is gone. The split
 * is the design, not flex-wrap running out of room: the previous
 * single wrapping row orphaned Length + favorites + Sort on a
 * second row by accident. The page wires its search and filters to
 * the real prompt API (see prompt-library-client.tsx): selecting
 * a filter changes its trigger label and active state AND
 * refetches the grid. When used standalone (no controlled props),
 * it keeps its own state.
 * The dropdown option lists render only
 * when open (null when closed) and Clear all renders only when
 * active.
 *
 * The search card EXPANDS instead of wrapping: it is no longer
 * capped at any fixed max width the filters can outgrow (max-w-3xl,
 * then max-w-4xl, both failed as soon as longer values were
 * selected). The card is w-fit (capped only by the page width via
 * max-w-full, so it can never overflow the viewport): short
 * filters keep it compact and centred, long filters grow it wider
 * on one row instead of dropping Clear all onto a new line. The
 * filter row itself is no-wrap with every control shrink-0 and
 * whitespace-nowrap, so nothing wraps to a second line on
 * desktop/tablet. Only on narrow phone widths, where the content
 * can still exceed the full page width, does the filter row scroll
 * horizontally inside the card (overflow-x-auto below sm) — that
 * is the last resort, and wrapping is never allowed. Note the
 * phone tradeoff, stated honestly: a horizontally scrolling row
 * is a scroll container, so on phones an open dropdown lives
 * inside that scroll area rather than overflowing freely; on
 * desktop/tablet the row is overflow-visible, so dropdowns open
 * freely below the card as before.
 *
 * The hero section must NOT carry overflow-hidden: the filter
 * dropdowns are absolutely positioned below the search card at the
 * bottom of this section, and overflow-hidden clipped them so only
 * ~2 options showed. No decorative element inside this section
 * depends on clipping, so the class was removed entirely.
 *
 * Design-system primitives + tokens only: no literal colours, no
 * inline styles. Filter triggers are plain text (no pill shape, no
 * border, no background fill); a changed filter shows in gold with
 * an underline. Dropdowns are a simple accessible list in this
 * component rather than the shared Radix Menu primitive, so the
 * one-open-at-a-time behaviour and mobile overflow stay explicit
 * and testable without a portal. An open dropdown closes on a
 * click/tap outside it (including on the search input) and on
 * Escape; it previously only toggled on its own trigger, with no
 * outside-click listener, so it stayed open.
 */
export type PromptFilterKey = "category" | "tool" | "language" | "length" | "sort";
export type PromptFilterValues = Record<PromptFilterKey, string>;

type FilterKey = PromptFilterKey;

const FILTER_OPTIONS: Record<FilterKey, readonly string[]> = {
  category: ["All", "Animals", "Comedy", "Cinematic", "UGC", "Tutorial", "Unboxing"],
  tool: ["All", "Dola AI", "Veo 3", "Google Flow"],
  language: ["All", "English", "Urdu", "Hindi"],
  length: ["All", "Under 15s", "15-30s", "30s+", "1 min+"],
  sort: ["Newest", "Most copied", "A to Z"],
};

const FILTER_LABELS: Record<FilterKey, string> = {
  category: "Category",
  tool: "Tool",
  language: "Language",
  length: "Length",
  sort: "Sort",
};

const FILTER_DEFAULTS: Record<FilterKey, string> = {
  category: "All",
  tool: "All",
  language: "All",
  length: "All",
  sort: "Newest",
};

export type PromptTopSectionProps = {
  /** Controlled search + filters (the page wires these to the real
   * API). When omitted, the section keeps its own internal state,
   * which is what the standalone top-section tests exercise. */
  query?: string;
  onQueryChange?: (query: string) => void;
  values?: Record<FilterKey, string>;
  onFilterChange?: (key: FilterKey, value: string) => void;
  onClearAll?: () => void;
  /** "My favorites" toggle (variant A): plain text in the filter
   * row, gold + underlined when active. Controlled by the page
   * when given; standalone it keeps its own state. */
  favoritesOnly?: boolean;
  onFavoritesToggle?: () => void;
};

export function PromptTopSection(props: PromptTopSectionProps = {}) {
  const [internalQuery, setInternalQuery] = React.useState("");
  const [internalValues, setInternalValues] =
    React.useState<Record<FilterKey, string>>(FILTER_DEFAULTS);
  const [internalFavoritesOnly, setInternalFavoritesOnly] =
    React.useState(false);
  const query = props.query ?? internalQuery;
  const values = props.values ?? internalValues;
  const favoritesOnly = props.favoritesOnly ?? internalFavoritesOnly;
  const toggleFavorites = () => {
    if (props.onFavoritesToggle) {
      props.onFavoritesToggle();
    } else {
      setInternalFavoritesOnly((previous) => !previous);
    }
  };
  const setQuery = props.onQueryChange ?? setInternalQuery;
  const setFilterValue = (key: FilterKey, value: string) => {
    if (props.onFilterChange) {
      props.onFilterChange(key, value);
    } else {
      setInternalValues((previous) => ({ ...previous, [key]: value }));
    }
  };
  const [openFilter, setOpenFilter] = React.useState<FilterKey | null>(null);
  const filterWrappers = React.useRef<Partial<Record<FilterKey, HTMLDivElement | null>>>(
    {},
  );

  // Close an open dropdown on a click/tap outside that filter's trigger
  // + dropdown, or on Escape. Only the open filter's wrapper is checked,
  // so clicking another filter's trigger still switches to it (the
  // mousedown closes the old one, the trigger click then opens the new
  // one), clicking the same trigger still toggles it, and clicking an
  // option inside the open dropdown still selects it.
  React.useEffect(() => {
    if (openFilter === null) return undefined;
    const handleOutside = (event: MouseEvent | TouchEvent) => {
      const wrapper = filterWrappers.current[openFilter];
      if (wrapper && !wrapper.contains(event.target as Node)) {
        setOpenFilter(null);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenFilter(null);
    };
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("touchstart", handleOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("touchstart", handleOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [openFilter]);

  const isActive =
    query !== "" ||
    favoritesOnly ||
    (Object.keys(FILTER_DEFAULTS) as FilterKey[]).some(
      (key) => values[key] !== FILTER_DEFAULTS[key],
    );

  const resetAll = () => {
    if (props.onClearAll) {
      props.onClearAll();
    } else {
      setQuery("");
      setInternalValues(FILTER_DEFAULTS);
      setInternalFavoritesOnly(false);
    }
    setOpenFilter(null);
  };

  return (
    <section
      data-testid="prompt-top-section"
      className="bg-canvas px-4 py-12 sm:px-6 sm:py-16"
    >
      <div className="mx-auto flex w-full flex-col items-center text-center">
        <h1 className="text-5xl font-bold leading-[1.05] tracking-tight text-ink sm:text-6xl">
          Master Prompts Library
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-ink-sub sm:text-lg">
          Find a prompt, view the full text, and copy it into your video tool.
        </p>
      </div>

      <div
        data-testid="prompt-top-section-search-card"
        className="mx-auto mt-10 w-full rounded-2xl border border-line bg-panel p-3 shadow-card sm:w-fit sm:max-w-full sm:p-4"
      >
      <div
        data-testid="prompt-top-section-search-row"
        className="flex items-center"
      >
        <label className="flex w-full items-center gap-2 rounded-xl border border-line bg-panel px-3 py-1">
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
      </div>
      <div aria-hidden="true" className="my-3 border-t border-line" />
      {/*
        Card width: fit-content, NOT a fixed max-w. Fixed caps kept
        failing: max-w-3xl broke on Sort "Most copied", max-w-4xl
        broke again once ALL filters carried long values (Category:
        Comedy, Tool: Google Flow, Language: English, Length:
        Under 15s, Sort: Most copied, My favorites active). The
        card is now w-fit on sm+ (full-width below sm) capped only
        by max-w-full, i.e. the page width minus the section's
        padding, so it grows with its content instead of wrapping
        Clear all onto a new line. The filter row is no-wrap and
        scrolls horizontally only below sm, where the content can
        still exceed the page width. This is asserted in code
        terms only: jsdom cannot measure pixel widths, so the live
        preview eyeball (all filters selected, as in Shahzeb's
        screenshot) is the final proof.
      */}
      <div
        data-testid="prompt-top-section-filter-row"
        className="flex flex-nowrap items-center gap-x-3 overflow-x-auto sm:overflow-visible"
      >
        {(Object.keys(FILTER_OPTIONS) as FilterKey[]).map((key) => {
          const changed = values[key] !== FILTER_DEFAULTS[key];
          const open = openFilter === key;
          // "My favorites" (variant A) sits in the same row, after
          // Sort and before Clear all — plain text like the other
          // filters, gold + underlined when active, no pill, no
          // border, no button background. Tapping it toggles: on
          // shows only the user's favourited prompts, off shows all.
          // It is rendered AFTER the Sort control (not before it),
          // so the row order is Category, Tool, Language, Length,
          // Sort, My favorites, Clear all. Sort is not pushed right.
          const favoritesToggle =
            key === "sort" ? (
              <button
                type="button"
                data-testid="prompt-top-section-filter-favorites"
                aria-pressed={favoritesOnly}
                onClick={toggleFavorites}
                className={
                  favoritesOnly
                    ? "flex shrink-0 items-center gap-1 whitespace-nowrap text-sm font-semibold text-brand-gold underline underline-offset-4"
                    : "flex shrink-0 items-center gap-1 whitespace-nowrap text-sm font-semibold text-ink"
                }
              >
                <HeartIcon
                  aria-hidden
                  className="size-4 shrink-0"
                  fill={favoritesOnly ? "currentColor" : "none"}
                />
                My favorites
              </button>
            ) : null;
          return (
            <React.Fragment key={key}>
            <div
              className="relative shrink-0"
              ref={(element) => {
                filterWrappers.current[key] = element;
              }}
            >
              <button
                type="button"
                data-testid={`prompt-top-section-filter-${key}`}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpenFilter(open ? null : key)}
                className={
                  changed
                    ? "flex shrink-0 items-center gap-1 whitespace-nowrap text-sm font-semibold text-brand-gold underline underline-offset-4"
                    : "flex shrink-0 items-center gap-1 whitespace-nowrap text-sm font-semibold text-ink"
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
                        setFilterValue(key, option);
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
              {favoritesToggle}
            </React.Fragment>
          );
        })}

        {isActive ? (
          <button
            type="button"
            data-testid="prompt-top-section-clear-all"
            onClick={resetAll}
            className="shrink-0 whitespace-nowrap text-sm font-semibold text-brand-gold"
          >
            Clear all
          </button>
        ) : null}
      </div>
      </div>
    </section>
  );
}
