"use client";

import React from "react";
import { HeartIcon, SearchIcon, SparklesIcon } from "lucide-react";

import type {
  PromptDetail,
  PromptListItem,
  PromptListResponse,
} from "@fbuploadpro/contracts";

import { Button } from "@/components/shared/ui/button";
import { EmptyState } from "@/components/shared/ui/empty-state";

import { PromptCardGrid } from "@/components/prompts/prompt-card-grid";
import { PromptDetailSection } from "@/components/prompts/prompt-detail-section";
import {
  PromptTopSection,
  type PromptFilterKey,
} from "@/components/prompts/prompt-top-section";

/**
 * Prompt Library page — real API wiring.
 *
 * Search + Category / Tool / Language / Length / Sort filters
 * refetch the list from the API (debounced for typing); the grid,
 * the dedicated section, the favourite heart, and the copied count
 * all come from the API, never from mock data. The catalogue starts
 * empty until an admin adds prompts via the backend, so the empty
 * state says so plainly. An API failure shows a loud error with a
 * retry — never a silent empty grid, never fake cards.
 * Favourite toggles update immediately and revert on failure.
 */

const FILTER_DEFAULTS: Record<PromptFilterKey, string> = {
  category: "All",
  tool: "All",
  language: "All",
  length: "All",
  sort: "Newest",
};

const CATEGORY_MAP: Record<string, string | undefined> = {
  All: undefined,
  Animals: "animals",
  Comedy: "comedy",
  Cinematic: "cinematic",
  UGC: "ugc",
  Tutorial: "tutorial",
  Unboxing: "unboxing",
};
const TOOL_MAP: Record<string, string | undefined> = {
  All: undefined,
  "Dola AI": "dola_ai",
  "Veo 3": "veo3",
  "Google Flow": "google_flow",
};
const LANGUAGE_MAP: Record<string, string | undefined> = {
  All: undefined,
  English: "en",
  Urdu: "ur",
  Hindi: "hi",
};
const LENGTH_MAP: Record<string, string | undefined> = {
  All: undefined,
  "Under 15s": "under_15s",
  "15-30s": "15_30s",
  "30s+": "30s_plus",
  "1 min+": "1min_plus",
};
const SORT_MAP: Record<string, string> = {
  Newest: "newest",
  "Most copied": "most_copied",
  "A to Z": "a_to_z",
};

/**
 * Centred empty state, shared by every empty case on this page
 * (favorites empty, favorites signed-out, no-match, catalogue
 * empty). The wrapper fills the grid area and centres the state
 * both horizontally and vertically, so it sits in the middle of
 * the empty page instead of hugging the search card as small
 * left-aligned lines. Actions are real shared Buttons, never plain
 * text links; behaviours are exactly the existing ones (showAll:
 * favorites off, search + filters cleared, full grid restored;
 * clearAll: same clearing, used by the no-match state). Testids
 * are kept unchanged so existing tests keep finding the states.
 */
function CentredEmptyState({
  testId,
  icon,
  title,
  description,
  action,
}: {
  testId: string;
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="flex min-h-[55svh] flex-col items-center justify-center bg-canvas px-4 pb-12 sm:px-6"
    >
      <EmptyState
        type="first-use"
        icon={icon}
        title={title}
        description={description}
        action={action}
      />
    </div>
  );
}

function EmptyStateIcon({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-hidden
      className="mb-2 flex size-14 items-center justify-center rounded-full bg-primary text-on-primary"
    >
      {children}
    </div>
  );
}

function FavoritesEmptyState({
  testId,
  title,
  description,
  onShowAll,
}: {
  testId: string;
  title: string;
  description: string;
  onShowAll: () => void;
}) {
  return (
    <CentredEmptyState
      testId={testId}
      icon={
        <EmptyStateIcon>
          <HeartIcon className="size-7" fill="currentColor" />
        </EmptyStateIcon>
      }
      title={title}
      description={description}
      action={
        <Button
          type="button"
          size="lg"
          data-testid="prompt-library-show-all"
          onClick={onShowAll}
        >
          Show all prompts
        </Button>
      }
    />
  );
}

export function PromptLibraryClient({
  subdomain,
}: {
  subdomain: string;
}) {
  const [query, setQuery] = React.useState("");
  const [filters, setFilters] =
    React.useState<Record<PromptFilterKey, string>>(FILTER_DEFAULTS);
  const [favoritesOnly, setFavoritesOnly] = React.useState(false);
  const [favoritesAuthRequired, setFavoritesAuthRequired] =
    React.useState(false);
  const [items, setItems] = React.useState<readonly PromptListItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [selectedSlug, setSelectedSlug] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<PromptDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState(false);
  const [fetchNonce, setFetchNonce] = React.useState(0);

  const fetchList = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    setFavoritesAuthRequired(false);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("search", query.trim());
      if (favoritesOnly) params.set("favorites_only", "true");
      const category = CATEGORY_MAP[filters.category];
      if (category) params.set("category", category);
      const tool = TOOL_MAP[filters.tool];
      if (tool) params.set("tool", tool);
      const language = LANGUAGE_MAP[filters.language];
      if (language) params.set("language", language);
      const length = LENGTH_MAP[filters.length];
      if (length) params.set("length", length);
      params.set("sort", SORT_MAP[filters.sort] ?? "newest");
      params.set("page", "1");
      params.set("pageSize", "50");
      const response = await fetch(
        `/api/tenant/${subdomain}/prompts?${params.toString()}`,
      );
      if (!response.ok) {
        // Signed out + favorites on is not an error grid and never
        // a fake list: show the plain sign-in note instead, with no
        // silent fallback to all prompts.
        if (response.status === 401 && favoritesOnly) {
          setFavoritesAuthRequired(true);
          setItems([]);
          return;
        }
        throw new Error(`List failed: ${response.status}`);
      }
      const body = (await response.json()) as PromptListResponse;
      setItems(body.items);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [subdomain, query, filters, favoritesOnly, fetchNonce]);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      void fetchList();
    }, 250);
    return () => clearTimeout(timer);
  }, [fetchList]);

  const fetchDetail = React.useCallback(
    async (slug: string) => {
      setDetailLoading(true);
      setDetailError(false);
      setDetail(null);
      try {
        const response = await fetch(
          `/api/tenant/${subdomain}/prompts/${slug}`,
        );
        if (!response.ok) throw new Error(`Detail failed: ${response.status}`);
        setDetail((await response.json()) as PromptDetail);
      } catch {
        setDetailError(true);
      } finally {
        setDetailLoading(false);
      }
    },
    [subdomain],
  );

  const handleSelect = (slug: string) => {
    setSelectedSlug(slug);
    void fetchDetail(slug);
  };

  const handleBack = () => {
    setSelectedSlug(null);
    setDetail(null);
    setDetailError(false);
  };

  const handleToggleFavourite = async (
    slug: string,
    currentlyFavourite: boolean,
  ) => {
    // Optimistic update; revert loudly on failure. While the
    // favorites filter is ON, unfavouriting removes the card from
    // the grid immediately — otherwise the last unfavourited card
    // would sit there stale instead of showing the empty state.
    const previousItems = items;
    setItems((previous) =>
      favoritesOnly && currentlyFavourite
        ? previous.filter((item) => item.slug !== slug)
        : previous.map((item) =>
            item.slug === slug
              ? { ...item, isFavourite: !currentlyFavourite }
              : item,
          ),
    );
    try {
      const response = await fetch(
        `/api/tenant/${subdomain}/prompts/${slug}/favourite`,
        { method: currentlyFavourite ? "DELETE" : "POST" },
      );
      if (!response.ok) throw new Error("Favourite failed");
    } catch {
      setItems(previousItems);
    }
  };

  const handleCopied = (slug: string, copiedCount: number) => {
    setItems((previous) =>
      previous.map((item) =>
        item.slug === slug ? { ...item, copiedCount } : item,
      ),
    );
    setDetail((previous) =>
      previous && previous.slug === slug
        ? { ...previous, copiedCount }
        : previous,
    );
  };

  const clearAll = () => {
    setQuery("");
    setFilters(FILTER_DEFAULTS);
    setFavoritesOnly(false);
    setFavoritesAuthRequired(false);
  };

  // "Show all prompts" restores the full grid: favorites off, and
  // search + filters cleared, so no other active filter can keep
  // the grid narrowed after leaving the favorites view.
  const showAll = () => {
    setFavoritesOnly(false);
    setQuery("");
    setFilters(FILTER_DEFAULTS);
    setFavoritesAuthRequired(false);
  };

  const isActive =
    query !== "" ||
    favoritesOnly ||
    (Object.keys(FILTER_DEFAULTS) as PromptFilterKey[]).some(
      (key) => filters[key] !== FILTER_DEFAULTS[key],
    );

  return (
    <>
      <PromptTopSection
        query={query}
        onQueryChange={setQuery}
        values={filters}
        onFilterChange={(key, value) =>
          setFilters((previous) => ({ ...previous, [key]: value }))
        }
        onClearAll={clearAll}
        favoritesOnly={favoritesOnly}
        onFavoritesToggle={() =>
          setFavoritesOnly((previous) => !previous)
        }
      />
      {selectedSlug ? (
        detailLoading ? (
          <p
            data-testid="prompt-detail-loading"
            className="bg-canvas px-4 pb-12 text-sm text-ink-sub sm:px-6"
          >
            Loading prompt…
          </p>
        ) : detailError || !detail ? (
          <div
            data-testid="prompt-detail-error"
            className="bg-canvas px-4 pb-12 sm:px-6"
          >
            <p className="text-sm text-ink">
              This prompt could not be loaded. Please try again.
            </p>
            <button
              type="button"
              onClick={handleBack}
              className="mt-3 text-sm font-semibold text-brand-gold"
            >
              ← Back to prompts
            </button>
          </div>
        ) : (
          <PromptDetailSection
            detail={detail}
            subdomain={subdomain}
            onBack={handleBack}
            onCopied={handleCopied}
          />
        )
      ) : loading ? (
        <p
          data-testid="prompt-library-loading"
          className="bg-canvas px-4 pb-12 text-sm text-ink-sub sm:px-6"
        >
          Loading prompts…
        </p>
      ) : error ? (
        <div
          data-testid="prompt-library-error"
          className="bg-canvas px-4 pb-12 sm:px-6"
        >
          <p className="text-sm text-ink">
            Prompts could not be loaded. Please try again.
          </p>
          <button
            type="button"
            data-testid="prompt-library-retry"
            onClick={() => setFetchNonce((n) => n + 1)}
            className="mt-3 text-sm font-semibold text-brand-gold"
          >
            Retry
          </button>
        </div>
      ) : favoritesOnly && favoritesAuthRequired ? (
        <FavoritesEmptyState
          testId="prompt-library-favorites-signin"
          title="Sign in to see your favorites."
          description="Your saved prompts will appear here once you are signed in."
          onShowAll={showAll}
        />
      ) : items.length === 0 ? (
        favoritesOnly ? (
          <FavoritesEmptyState
            testId="prompt-library-favorites-empty"
            title="No favorites yet."
            description="Tap the heart on any prompt card to save it here."
            onShowAll={showAll}
          />
        ) : isActive ? (
          <CentredEmptyState
            testId="prompt-library-empty"
            icon={
              <EmptyStateIcon>
                <SearchIcon className="size-7" />
              </EmptyStateIcon>
            }
            title="No prompts match your search."
            description="Try different words, or clear the filters to see every prompt."
            action={
              <Button
                type="button"
                size="lg"
                data-testid="prompt-library-clear-filters"
                onClick={clearAll}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <CentredEmptyState
            testId="prompt-library-empty"
            icon={
              <EmptyStateIcon>
                <SparklesIcon className="size-7" />
              </EmptyStateIcon>
            }
            title="No prompts yet."
            description="New prompts are added here by the team through the backend — check back soon."
          />
        )
      ) : (
        <PromptCardGrid
          items={items}
          onSelect={handleSelect}
          onToggleFavourite={handleToggleFavourite}
        />
      )}
    </>
  );
}
