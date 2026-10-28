"use client";

import React from "react";
import {
  AlertTriangleIcon,
  HeartIcon,
  SearchIcon,
  SparklesIcon,
} from "lucide-react";

import type {
  PromptDetail,
  PromptFacets,
  PromptListItem,
  PromptListResponse,
} from "@fbuploadpro/contracts";
import {
  PromptCategoryLabels,
  PromptFacetsSchema,
  PromptLanguageLabels,
  PromptLengthLabels,
  PromptToolLabels,
} from "@fbuploadpro/contracts";

import { Banner } from "@/components/shared/ui/banner";
import { Button } from "@/components/shared/ui/button";
import { EmptyState } from "@/components/shared/ui/empty-state";
import { Skeleton } from "@/components/shared/ui/skeleton";
import { toast } from "@/components/shared/ui/toast";

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

/**
 * Selected filter display labels are translated back to API values
 * by reversing the contracts label maps at runtime — not by a
 * hardcoded list. That keeps filtering dynamic too: a value added
 * later (contracts label + DB migration) filters correctly with
 * no client change, and an unknown label sends no filter param
 * rather than a wrong one. "All" is not in any label map, so it
 * correctly yields no param. Sort is the exception: its modes are
 * fixed behaviours, so its small map stays fixed.
 */
function labelToApiValue(
  labels: Record<string, string>,
  label: string,
): string | undefined {
  for (const [value, display] of Object.entries(labels)) {
    if (display === label) return value;
  }
  return undefined;
}

/**
 * Reverse label lookup for TAXONOMY filters (category/tool/
 * language), whose values are free text since migration
 * 20261028140000: a brand-new value has no entry in the old
 * label maps, and its display label IS its raw value (the
 * top section falls back to the raw value for unknowns), so
 * falling back to the label itself is the correct api value.
 * Length keeps the strict lookup above — it is still an enum.
 * EXCEPTION: "All" is the no-filter sentinel, not a value — it
 * must yield no param. Without this guard the fallback sends
 * category=All / tool=All / language=All, and the API (correctly)
 * treats those as exact filters matching no prompt, so every
 * unfiltered list request returned zero items.
 */
function taxonomyLabelToApiValue(
  labels: Record<string, string>,
  label: string,
): string | undefined {
  if (label === "All") return undefined;
  return labelToApiValue(labels, label) ?? label;
}
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
  description?: string;
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
        // The shared EmptyState props are `description?: string` under
        // exactOptionalPropertyTypes, so an explicit `undefined` does
        // not typecheck (and Next's build-time typecheck fails the
        // Vercel deployment for it). Pass the prop only when defined.
        {...(description !== undefined ? { description } : {})}
        {...(action !== undefined ? { action } : {})}
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
  // Pagination: the list API already returns the server total (see
  // PromptListResponse: total/page/pageSize), so hasMore is derived
  // from that server total — never guessed client-side. Page 1 is
  // always fetched fresh; later pages append, never replace.
  const [page, setPage] = React.useState(1);
  const [hasMore, setHasMore] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  // Dynamic filter facets, from GET /prompts/facets: the distinct
  // values actually present in published prompts. Fetched once,
  // unfiltered by search/filters, so selecting one filter never
  // hides the other options. A failure sets facetsError and shows
  // a visible Banner above the grid — never a silent fallback to
  // hardcoded lists (those no longer exist in the top section).
  const [facets, setFacets] = React.useState<PromptFacets | null>(null);
  const [facetsError, setFacetsError] = React.useState(false);
  const [selectedSlug, setSelectedSlug] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<PromptDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState(false);
  const [fetchNonce, setFetchNonce] = React.useState(0);

  // fetchPage(1, false) is the fresh list: it runs on mount and
  // whenever search/filters/favorites change (via the debounced
  // effect below), so pagination always resets to page 1 on those
  // changes. fetchPage(page + 1, true) is Load more: it appends.
  const fetchPage = React.useCallback(
    async (pageToFetch: number, append: boolean) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setLoadingMore(false);
      }
      setError(false);
      setFavoritesAuthRequired(false);
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("search", query.trim());
        if (favoritesOnly) params.set("favorites_only", "true");
        const category = taxonomyLabelToApiValue(PromptCategoryLabels, filters.category);
        if (category) params.set("category", category);
        const tool = taxonomyLabelToApiValue(PromptToolLabels, filters.tool);
        if (tool) params.set("tool", tool);
        const language = taxonomyLabelToApiValue(PromptLanguageLabels, filters.language);
        if (language) params.set("language", language);
        const length = labelToApiValue(PromptLengthLabels, filters.length);
        if (length) params.set("length", length);
        params.set("sort", SORT_MAP[filters.sort] ?? "newest");
        params.set("page", String(pageToFetch));
        params.set("pageSize", "50");
        const response = await fetch(
          `/api/tenant/${subdomain}/prompts?${params.toString()}`,
        );
        if (!response.ok) {
          // Signed out + favorites on is not an error grid and never
          // a fake list: show the plain sign-in note instead, with no
          // silent fallback to all prompts.
          if (response.status === 401 && favoritesOnly && !append) {
            setFavoritesAuthRequired(true);
            setItems([]);
            setPage(1);
            setHasMore(false);
            return;
          }
          throw new Error(`List failed: ${response.status}`);
        }
        const body = (await response.json()) as PromptListResponse;
        setItems((previous) =>
          append ? [...previous, ...body.items] : body.items,
        );
        setPage(pageToFetch);
        // Server total, not a client guess: more pages exist only
        // while the fetched pages have not yet covered the total.
        setHasMore(pageToFetch * body.pageSize < body.total);
      } catch {
        // A failed Load more leaves the already-loaded pages and
        // the button in place, so the user can retry; a failed
        // fresh fetch is the loud list error, as before.
        if (!append) setError(true);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [subdomain, query, filters, favoritesOnly, fetchNonce],
  );

  React.useEffect(() => {
    const timer = setTimeout(() => {
      void fetchPage(1, false);
    }, 250);
    return () => clearTimeout(timer);
  }, [fetchPage]);

  // Facets are independent of search/filters/favorites: they run
  // on mount and on Retry (fetchNonce), never on a filter change.
  // A failed refetch keeps any previously loaded facets and still
  // raises the visible error, so the failure is never silent.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/tenant/${subdomain}/prompts/facets`,
        );
        if (!response.ok) throw new Error(`Facets failed: ${response.status}`);
        const parsed = PromptFacetsSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error("Facets invalid");
        if (!cancelled) {
          setFacets(parsed.data);
          setFacetsError(false);
        }
      } catch {
        if (!cancelled) setFacetsError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subdomain, fetchNonce]);

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
    const previousDetail = detail;
    setItems((previous) =>
      favoritesOnly && currentlyFavourite
        ? previous.filter((item) => item.slug !== slug)
        : previous.map((item) =>
            item.slug === slug
              ? { ...item, isFavourite: !currentlyFavourite }
              : item,
          ),
    );
    // The detail section's heart mirrors the same state (it reads
    // detail.isFavourite), so it updates and reverts together.
    setDetail((previous) =>
      previous && previous.slug === slug
        ? { ...previous, isFavourite: !currentlyFavourite }
        : previous,
    );
    try {
      const response = await fetch(
        `/api/tenant/${subdomain}/prompts/${slug}/favourite`,
        { method: currentlyFavourite ? "DELETE" : "POST" },
      );
      if (!response.ok) throw new Error("Favourite failed");
    } catch {
      // Revert, as before — but never silently: the tenant layout
      // mounts the shared Toaster, so this reaches the user as a
      // visible error toast (it auto-dismisses after 5s).
      setItems(previousItems);
      setDetail(previousDetail);
      toast.error("Couldn't save this change. Please try again.");
    }
  };

  const handleLoadMore = () => {
    if (loadingMore || !hasMore) return;
    void fetchPage(page + 1, true);
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
    // Reset pagination even when the values were already at their
    // defaults (no filter change for the effect to notice).
    setPage(1);
    setFetchNonce((n) => n + 1);
  };

  // "Show all prompts" restores the full grid: favorites off, and
  // search + filters cleared, so no other active filter can keep
  // the grid narrowed after leaving the favorites view.
  const showAll = () => {
    setFavoritesOnly(false);
    setQuery("");
    setFilters(FILTER_DEFAULTS);
    setFavoritesAuthRequired(false);
    setPage(1);
    setFetchNonce((n) => n + 1);
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
        facets={facets}
      />
      {selectedSlug ? (
        detailLoading ? (
          // Detail skeleton, matching the real detail layout at its
          // final geometry (same h-60 preview, master-prompt block,
          // how-to step lines) via the shared Skeleton primitive —
          // no real detail content, no fake text. Timing and
          // behaviour are unchanged: this shows only while the
          // detail fetch is in flight.
          <section
            data-testid="prompt-detail-loading"
            aria-busy="true"
            aria-live="polite"
            aria-label="Loading prompt"
            className="bg-canvas px-4 pb-12 sm:px-6 sm:pb-16"
          >
            <span className="sr-only">Loading prompt…</span>
            <div className="mx-auto w-full">
              <Skeleton className="h-9 w-1/2" />
              <Skeleton className="mt-2 h-4 w-2/3" />
              <Skeleton className="mt-6 h-60 w-full rounded-2xl" />
              <Skeleton className="mt-8 h-6 w-44" />
              <div className="mt-3 rounded-2xl border border-line bg-panel p-4">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="mt-2 h-4 w-full" />
                <Skeleton className="mt-2 h-4 w-5/6" />
              </div>
              <Skeleton className="mt-8 h-6 w-64" />
              <ol className="mt-3 space-y-2 pl-6">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
              </ol>
            </div>
          </section>
        ) : detailError || !detail ? (
          // Centred detail error, same pattern as the list error:
          // icon, heading, plain explanation, no error code — with
          // BOTH actions. Retry refetches the same slug (on success
          // the detail shows, on failure this error returns);
          // Back returns to the grid, exactly as before.
          <CentredEmptyState
            testId="prompt-detail-error"
            icon={
              <EmptyStateIcon>
                <AlertTriangleIcon className="size-7" />
              </EmptyStateIcon>
            }
            title="This prompt could not be loaded."
            description="Something went wrong while loading this prompt. Please try again."
            action={
              <div className="flex flex-wrap items-center justify-center gap-3">
                <Button
                  type="button"
                  size="lg"
                  data-testid="prompt-detail-retry"
                  onClick={() => {
                    if (selectedSlug) void fetchDetail(selectedSlug);
                  }}
                >
                  Retry
                </Button>
                <Button
                  type="button"
                  size="lg"
                  variant="secondary"
                  data-testid="prompt-detail-back"
                  onClick={handleBack}
                >
                  Back to prompts
                </Button>
              </div>
            }
          />
        ) : (
          <PromptDetailSection
            detail={detail}
            subdomain={subdomain}
            onBack={handleBack}
            onCopied={handleCopied}
            onToggleFavourite={handleToggleFavourite}
          />
        )
      ) : loading ? (
        <section
          data-testid="prompt-library-loading"
          aria-busy="true"
          aria-live="polite"
          aria-label="Loading prompts"
          className="bg-canvas px-4 pb-12 sm:px-6 sm:pb-16"
        >
          <span className="sr-only">Loading prompts</span>
          <div className="mx-auto grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((index) => (
              <article
                key={index}
                data-testid="prompt-card-skeleton"
                className="overflow-hidden rounded-2xl border border-line bg-panel shadow-card"
              >
                <Skeleton className="h-60 w-full rounded-none" />
                <div className="p-4">
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="mt-2 h-4 w-full" />
                  <Skeleton className="mt-2 h-4 w-5/6" />
                  <Skeleton className="mt-3 h-4 w-2/3" />
                  <div className="mt-3 border-t border-line pt-3">
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : error ? (
        <CentredEmptyState
          testId="prompt-library-error"
          icon={
            <EmptyStateIcon>
              <AlertTriangleIcon className="size-7" />
            </EmptyStateIcon>
          }
          title="Prompts could not be loaded."
          description="Something went wrong while loading the prompts. Please try again."
          action={
            <Button
              type="button"
              size="lg"
              data-testid="prompt-library-retry"
              onClick={() => setFetchNonce((n) => n + 1)}
            >
              Retry
            </Button>
          }
        />
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
          />
        )
      ) : (
        <>
          {facetsError ? (
            // Visible filter failure, never a silent hardcoded
            // fallback: the grid below is still shown, but its
            // dynamic filters offer only "All" until the options
            // load again. Persistent until resolved (no dismiss
            // that could hide the failure); Retry refetches facets
            // (fetchNonce) as well as the list.
            <div className="bg-canvas px-4 sm:px-6">
              <Banner
                variant="critical"
                data-testid="prompt-library-facets-error"
                title="Filter options could not be loaded."
                description="The prompts below are still shown, but the Category, Tool, Language and Length filters only offer All until the options load again."
                action={
                  <Button
                    type="button"
                    size="sm"
                    data-testid="prompt-library-facets-retry"
                    onClick={() => setFetchNonce((n) => n + 1)}
                  >
                    Retry
                  </Button>
                }
              />
            </div>
          ) : null}
          <PromptCardGrid
            items={items}
            onSelect={handleSelect}
            onToggleFavourite={handleToggleFavourite}
          />
          {hasMore ? (
            <div className="bg-canvas px-4 pb-12 sm:px-6 sm:pb-16">
              <div className="mx-auto flex justify-center">
                <Button
                  type="button"
                  size="lg"
                  data-testid="prompt-library-load-more"
                  onClick={handleLoadMore}
                  loading={loadingMore}
                >
                  {loadingMore ? "Loading more…" : "Load more"}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
