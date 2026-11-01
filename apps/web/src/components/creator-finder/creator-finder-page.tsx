'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CreatorFinderUsageResponseSchema,
  NicheResponseSchema,
  RegionListResponseSchema,
  SavedCreatorDeleteResponseSchema,
  SavedCreatorListResponseSchema,
  SimilarResponseSchema,
  TrendingResponseSchema,
  type Creator,
  type Region,
  type SavedCreator,
} from '@fbuploadpro/contracts';
import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/shared/ui/alert-dialog';
import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import { Input } from '@/components/shared/ui/input';
import { ListPagination } from '@/components/shared/ui/list-pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shared/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';
import { CreatorCard } from './creator-card';

type TabId = 'trending' | 'niche' | 'similar' | 'saved';

interface SearchState {
  status: 'idle' | 'loading' | 'done' | 'error';
  creators: Creator[];
  message: string | null;
  heading: string | null;
  saveFailed?: boolean | undefined;
  /** True when the search was blocked by the daily cap (429 flag). */
  dailyLimit?: boolean | undefined;
}

const IDLE_STATE: SearchState = {
  status: 'idle',
  creators: [],
  message: null,
  heading: null,
  saveFailed: false,
  dailyLimit: false,
};

/**
 * The owner's words for the cap, shown with the usage display
 * and with every blocked message. Single source so the wording
 * can never drift between the two places.
 */
const TEMPORARY_LIMIT_NOTE =
  "This limit is temporary — I'll increase it later if you guys like this feature.";

/**
 * A 429 is a daily-cap block only when the error body carries
 * the dailyLimitExceeded flag — never from the message string
 * alone, so a provider rate-limit 429 never renders as a cap
 * block. The typed client preserves the raw body on err.cause.
 */
function isDailyLimitError(err: unknown): boolean {
  if (!isApiError(err)) return false;
  if (err.status !== 429) return false;
  const cause = err.cause as { dailyLimitExceeded?: unknown } | null | undefined;
  return (
    cause !== null &&
    typeof cause === 'object' &&
    cause.dailyLimitExceeded === true
  );
}

function errorMessage(err: unknown): string {
  if (isApiError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return 'Creator search could not be completed. Please try again.';
}

export function CreatorFinderPage({
  subdomain,
}: Readonly<{ subdomain: string }>) {
  const [tab, setTab] = React.useState<TabId>('trending');
  const [region, setRegion] = React.useState<string>('');
  /**
   * Country typeahead state. countryQuery is null until the user
   * types, so the input initially shows the default country's name
   * without any set-state-in-effect. Once the user types, only an
   * exact name match (or a row they clicked) counts as a selected
   * region — typing a partial name never searches the old default.
   */
  const [countryQuery, setCountryQuery] = React.useState<string | null>(null);
  const [countryListOpen, setCountryListOpen] = React.useState(false);
  const [keyword, setKeyword] = React.useState('');
  const [username, setUsername] = React.useState('');
  /**
   * Niche filters. The country typeahead is a second instance of the
   * trending tab's behaviour (type to filter, list below, click to
   * select) over the SAME regions list — no second regions fetch.
   * Unlike trending, it starts empty: empty means all regions, not
   * the default country. Time/Sort default to the API's unfiltered
   * values (All time / Relevance), which are never sent.
   */
  const [nicheRegion, setNicheRegion] = React.useState<string>('');
  const [nicheCountryQuery, setNicheCountryQuery] = React.useState('');
  const [nicheCountryListOpen, setNicheCountryListOpen] = React.useState(false);
  const [nicheTime, setNicheTime] = React.useState('0');
  const [nicheSort, setNicheSort] = React.useState('0');
  const [trending, setTrending] = React.useState<SearchState>(IDLE_STATE);
  const [niche, setNiche] = React.useState<SearchState>(IDLE_STATE);
  const [similar, setSimilar] = React.useState<SearchState>(IDLE_STATE);
  const [removingHandle, setRemovingHandle] = React.useState<string | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [exportError, setExportError] = React.useState<string | null>(null);
  // Saved tab controls. The applied search/source/page are what the
  // query runs on; typing in the search box alone does not refetch.
  // Any new search, source choice, or Clear-all resets to page 1.
  const [savedSearchInput, setSavedSearchInput] = React.useState('');
  const [savedSearch, setSavedSearch] = React.useState('');
  const [savedSource, setSavedSource] = React.useState('all');
  const [savedPage, setSavedPage] = React.useState(1);
  const [clearAllOpen, setClearAllOpen] = React.useState(false);
  const [clearingAll, setClearingAll] = React.useState(false);

  const savedQuery = useQuery({
    queryKey: [
      'creator-finder',
      'saved',
      subdomain,
      savedSearch,
      savedSource,
      savedPage,
    ],
    queryFn: () =>
      api.get(buildTenantApiPath(subdomain, '/creator-finder/saved'), {
        schema: SavedCreatorListResponseSchema,
        query: {
          q: savedSearch || undefined,
          source: savedSource,
          page: savedPage,
        },
      }),
  });
  const savedCreators: SavedCreator[] = savedQuery.data?.creators ?? [];
  const savedTotal: number = savedQuery.data?.total ?? 0;
  const savedTotalPages: number = savedQuery.data?.totalPages ?? 0;
  const savedFiltersActive =
    savedSearch.trim() !== '' || savedSource !== 'all';

  async function removeSaved(handle: string) {
    setRemovingHandle(handle);
    try {
      await api.delete(
        buildTenantApiPath(subdomain, '/creator-finder/saved'),
        {
          schema: SavedCreatorDeleteResponseSchema,
          query: { handle },
        },
      );
      // If this was the last card on a page past the first, step back
      // a page instead of leaving an empty page behind.
      if (savedCreators.length === 1 && savedPage > 1) {
        setSavedPage(savedPage - 1);
      } else {
        await savedQuery.refetch();
      }
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setRemovingHandle(null);
    }
  }

  /** Clear-all, gated by the confirmation dialogue in the Saved tab. */
  async function clearAllSaved() {
    setClearingAll(true);
    setExportError(null);
    try {
      await api.delete(
        buildTenantApiPath(subdomain, '/creator-finder/saved'),
        {
          schema: SavedCreatorDeleteResponseSchema,
          query: { clearAll: 'true' },
        },
      );
      // Reset every control so the tab returns to the plain
      // no-saved-creators empty state, not a filtered empty state.
      setSavedSearchInput('');
      setSavedSearch('');
      setSavedSource('all');
      setSavedPage(1);
      setClearAllOpen(false);
      await savedQuery.refetch();
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setClearingAll(false);
    }
  }

  async function exportSavedCsv() {
    setExporting(true);
    setExportError(null);
    try {
      const response = await fetch(
        buildTenantApiPath(subdomain, '/creator-finder/saved/export'),
        { credentials: 'include' },
      );
      if (!response.ok) {
        throw new Error('Saved creators could not be exported. Please try again.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'saved-creators.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  const regionsQuery = useQuery({
    queryKey: ['creator-finder', 'regions', subdomain],
    queryFn: () =>
      api.get(buildTenantApiPath(subdomain, '/creator-finder/regions'), {
        schema: RegionListResponseSchema,
      }),
  });

  /**
   * Daily-cap usage for today. Never counted, never gated — it
   * makes no upstream call. Refetched after every search so a
   * block (or a completed search) updates the number at once.
   */
  const usageQuery = useQuery({
    queryKey: ['creator-finder', 'usage', subdomain],
    queryFn: () =>
      api.get(buildTenantApiPath(subdomain, '/creator-finder/usage'), {
        schema: CreatorFinderUsageResponseSchema,
      }),
  });
  const usage = usageQuery.data;

  const regions: Region[] = regionsQuery.data?.regions ?? [];
  const defaultRegion = regionsQuery.data?.defaultRegion ?? null;
  const defaultRegionName =
    regions.find((item) => item.code === defaultRegion)?.name ?? '';
  const selectedRegionName =
    region === '' ? '' : (regions.find((item) => item.code === region)?.name ?? '');
  const countryInputValue = countryQuery ?? defaultRegionName;
  const exactCountryMatch = regions.find(
    (item) => item.name.toLowerCase() === countryInputValue.trim().toLowerCase(),
  );
  const effectiveRegion =
    countryQuery === null
      ? region || defaultRegion || ''
      : selectedRegionName === countryInputValue
        ? region
        : (exactCountryMatch?.code ?? '');
  const countryFilter = countryInputValue.trim().toLowerCase();
  const filteredCountries = regions.filter(
    (item) =>
      countryFilter === '' ||
      item.name.toLowerCase().includes(countryFilter) ||
      item.code.toLowerCase().includes(countryFilter),
  );
  const countryListId = 'creator-finder-country-list';
  // Niche country typeahead, same safety rule as trending: a
  // half-typed name never searches a previously selected country —
  // only an exact name match or a clicked row counts as selected.
  const nicheSelectedRegionName =
    nicheRegion === ''
      ? ''
      : (regions.find((item) => item.code === nicheRegion)?.name ?? '');
  const nicheExactCountryMatch = regions.find(
    (item) => item.name.toLowerCase() === nicheCountryQuery.trim().toLowerCase(),
  );
  const nicheEffectiveRegion =
    nicheCountryQuery.trim() === ''
      ? ''
      : nicheSelectedRegionName === nicheCountryQuery
        ? nicheRegion
        : (nicheExactCountryMatch?.code ?? '');
  const nicheCountryFilter = nicheCountryQuery.trim().toLowerCase();
  const nicheFilteredCountries = regions.filter(
    (item) =>
      nicheCountryFilter === '' ||
      item.name.toLowerCase().includes(nicheCountryFilter) ||
      item.code.toLowerCase().includes(nicheCountryFilter),
  );
  const nicheCountryListId = 'creator-finder-niche-country-list';

  async function searchTrending() {
    if (!effectiveRegion) return;
    setTrending({ status: 'loading', creators: [], message: null, heading: null });
    try {
      const result = await api.get(
        buildTenantApiPath(subdomain, '/creator-finder/trending'),
        {
          schema: TrendingResponseSchema,
          query: { region: effectiveRegion },
        },
      );
      setTrending({
        status: 'done',
        creators: result.creators,
        message:
          result.creators.length === 0
            ? 'No trending creators were found for this country right now.'
            : null,
        heading: `Trending creators in ${effectiveRegion}`,
        saveFailed: result.saveFailed ?? false,
      });
      void savedQuery.refetch();
    } catch (err) {
      setTrending({
        status: 'error',
        creators: [],
        message: errorMessage(err),
        heading: null,
        dailyLimit: isDailyLimitError(err),
      });
    }
    void usageQuery.refetch();
  }

  async function searchNiche(event: React.FormEvent) {
    event.preventDefault();
    setNiche({ status: 'loading', creators: [], message: null, heading: null });
    try {
      const result = await api.get(
        buildTenantApiPath(subdomain, '/creator-finder/niche'),
        {
          schema: NicheResponseSchema,
          query: {
            keyword,
            region: nicheEffectiveRegion || undefined,
            publish_time: nicheTime !== '0' ? nicheTime : undefined,
            sort_type: nicheSort !== '0' ? nicheSort : undefined,
          },
        },
      );
      setNiche({
        status: 'done',
        creators: result.creators,
        message:
          result.creators.length === 0
            ? `No creators were found for ${result.keyword}.`
            : null,
        heading: `Creators for ${result.keyword}`,
        saveFailed: result.saveFailed ?? false,
      });
      void savedQuery.refetch();
    } catch (err) {
      setNiche({ status: 'error', creators: [], message: errorMessage(err), heading: null, dailyLimit: isDailyLimitError(err) });
    }
    void usageQuery.refetch();
  }

  async function searchSimilar(event: React.FormEvent) {
    event.preventDefault();
    setSimilar({ status: 'loading', creators: [], message: null, heading: null });
    try {
      const result = await api.get(
        buildTenantApiPath(subdomain, '/creator-finder/similar'),
        {
          schema: SimilarResponseSchema,
          query: { username: username.trim().replace(/^@/, '') },
        },
      );
      setSimilar({
        status: 'done',
        creators: result.creators,
        message:
          result.creators.length === 0
            ? `No similar creators were found for @${result.username}.`
            : null,
        heading: `Similar to @${result.username}`,
        saveFailed: result.saveFailed ?? false,
      });
      void savedQuery.refetch();
    } catch (err) {
      setSimilar({ status: 'error', creators: [], message: errorMessage(err), heading: null, dailyLimit: isDailyLimitError(err) });
    }
    void usageQuery.refetch();
  }

  function renderResults(state: SearchState) {
    if (state.status === 'loading') {
      return <p className="text-body text-ink-sub">Finding creators…</p>;
    }
    if (state.status === 'error') {
      // A cap block renders distinctly from any other search
      // error: "Daily limit exceeded" plus the temporary note —
      // no raw technical string, no countdown, no retry timer.
      if (state.dailyLimit) {
        return (
          <Banner
            variant="critical"
            title="Daily limit exceeded"
            description={TEMPORARY_LIMIT_NOTE}
          />
        );
      }
      return (
        <Banner
          variant="critical"
          title="Couldn't find creators"
          description={state.message ?? 'Please try again.'}
        />
      );
    }
    if (state.status === 'done') {
      return (
        <div>
          {state.saveFailed ? (
            <div className="mb-3">
              <Banner
                variant="warning"
                title="Couldn't save creators"
                description="Search results could not be saved. Please try searching again."
              />
            </div>
          ) : null}
          {state.heading ? (
            <h2 className="mb-3 text-lg font-semibold text-ink">{state.heading}</h2>
          ) : null}
          {state.message ? (
            <p className="text-body text-ink-sub">{state.message}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {state.creators.map((creator) => (
                <CreatorCard key={creator.handle} creator={creator} />
              ))}
            </div>
          )}
        </div>
      );
    }
    return null;
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6">
      <div>
        <h1 className="text-xl font-bold text-ink">Creator Finder</h1>
        <p className="mt-1 text-body text-ink-sub">
          Find TikTok creators by what is trending, by niche, or by a creator you
          already know. Creators you find are saved automatically — nothing is
          contacted or published.
        </p>
        {usage ? (
          <div className="mt-3">
            <p className="text-body text-ink-sub">
              {usage.used} of {usage.limit} used today
            </p>
            <p className="mt-1 text-metadata text-ink-dim">
              {TEMPORARY_LIMIT_NOTE}
            </p>
          </div>
        ) : null}
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as TabId)}
      >
        <TabsList aria-label="Creator Finder">
          <TabsTrigger value="trending">Trending by country</TabsTrigger>
          <TabsTrigger value="niche">By niche / words</TabsTrigger>
          <TabsTrigger value="similar">Similar creators</TabsTrigger>
          <TabsTrigger value="saved">Saved</TabsTrigger>
        </TabsList>

        <TabsContent value="trending">
          <div className="flex flex-col gap-3">
            {regionsQuery.isError ? (
              isDailyLimitError(regionsQuery.error) ? (
                <Banner
                  variant="critical"
                  title="Daily limit exceeded"
                  description={TEMPORARY_LIMIT_NOTE}
                />
              ) : (
                <Banner
                  variant="critical"
                  title="Couldn't load countries"
                  description="The country list could not be loaded. Please try again."
                />
              )
            ) : null}
            <div className="flex flex-col gap-2 text-body font-medium text-ink">
              <label htmlFor="creator-finder-country">Country</label>
              <div className="relative w-full max-w-xs">
                <Input
                  id="creator-finder-country"
                  role="combobox"
                  aria-expanded={countryListOpen}
                  aria-controls={countryListId}
                  autoComplete="off"
                  value={countryInputValue}
                  placeholder="Type a country"
                  disabled={regionsQuery.isLoading || regions.length === 0}
                  onFocus={() => setCountryListOpen(true)}
                  onBlur={() => setCountryListOpen(false)}
                  onChange={(event) => {
                    const value = event.target.value;
                    setCountryQuery(value);
                    if (value.trim() === '') {
                      setRegion('');
                    }
                    setCountryListOpen(true);
                  }}
                />
                {countryListOpen && regions.length > 0 ? (
                  <ul
                    id={countryListId}
                    role="listbox"
                    aria-label="Countries"
                    className="absolute left-0 right-0 top-full z-overlay-top mt-1 max-h-60 overflow-y-auto rounded-md border border-line bg-panel p-1 text-ink shadow-elevated"
                  >
                    {filteredCountries.length === 0 ? (
                      <li className="px-2 py-2 text-body text-ink-dim">
                        No country matches that.
                      </li>
                    ) : (
                      filteredCountries.map((item) => (
                        <li key={item.code} role="option" aria-selected={item.code === effectiveRegion}>
                          <button
                            type="button"
                            className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-2 text-left text-body text-ink hover:bg-hover"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              setRegion(item.code);
                              setCountryQuery(item.name);
                              setCountryListOpen(false);
                            }}
                          >
                            <span>{item.name}</span>
                            <span className="text-metadata text-ink-dim">{item.code}</span>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                ) : null}
              </div>
            </div>
            <div>
              <Button onClick={searchTrending} disabled={!effectiveRegion || trending.status === 'loading'}>
                Find trending creators
              </Button>
            </div>
            {renderResults(trending)}
          </div>
        </TabsContent>

        <TabsContent value="niche">
          <form onSubmit={searchNiche} className="flex flex-col gap-3">
            <label className="flex flex-col gap-2 text-body font-medium text-ink">
              Niche or keyword
              <Input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="e.g. fitness"
                required
              />
            </label>
            <div className="flex flex-col gap-2 text-body font-medium text-ink">
              <label htmlFor="creator-finder-niche-country">Country (optional)</label>
              <div className="relative w-full max-w-xs">
                <Input
                  id="creator-finder-niche-country"
                  role="combobox"
                  aria-expanded={nicheCountryListOpen}
                  aria-controls={nicheCountryListId}
                  autoComplete="off"
                  value={nicheCountryQuery}
                  placeholder="All countries"
                  disabled={regionsQuery.isLoading || regions.length === 0}
                  onFocus={() => setNicheCountryListOpen(true)}
                  onBlur={() => setNicheCountryListOpen(false)}
                  onChange={(event) => {
                    const value = event.target.value;
                    setNicheCountryQuery(value);
                    if (value.trim() === '') {
                      setNicheRegion('');
                    }
                    setNicheCountryListOpen(true);
                  }}
                />
                {nicheCountryListOpen && regions.length > 0 ? (
                  <ul
                    id={nicheCountryListId}
                    role="listbox"
                    aria-label="Countries"
                    className="absolute left-0 right-0 top-full z-overlay-top mt-1 max-h-60 overflow-y-auto rounded-md border border-line bg-panel p-1 text-ink shadow-elevated"
                  >
                    {nicheFilteredCountries.length === 0 ? (
                      <li className="px-2 py-2 text-body text-ink-dim">
                        No country matches that.
                      </li>
                    ) : (
                      nicheFilteredCountries.map((item) => (
                        <li key={item.code} role="option" aria-selected={item.code === nicheEffectiveRegion}>
                          <button
                            type="button"
                            className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-2 text-left text-body text-ink hover:bg-hover"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => {
                              setNicheRegion(item.code);
                              setNicheCountryQuery(item.name);
                              setNicheCountryListOpen(false);
                            }}
                          >
                            <span>{item.name}</span>
                            <span className="text-metadata text-ink-dim">{item.code}</span>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="flex flex-col gap-2 text-body font-medium text-ink">
                Time
                <Select value={nicheTime} onValueChange={setNicheTime}>
                  <SelectTrigger aria-label="Time">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">All time</SelectItem>
                    <SelectItem value="1">Past 24 hours</SelectItem>
                    <SelectItem value="7">This week</SelectItem>
                    <SelectItem value="30">This month</SelectItem>
                    <SelectItem value="90">Last 3 months</SelectItem>
                    <SelectItem value="180">Last 6 months</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-2 text-body font-medium text-ink">
                Sort
                <Select value={nicheSort} onValueChange={setNicheSort}>
                  <SelectTrigger aria-label="Sort">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Relevance</SelectItem>
                    <SelectItem value="1">Like count</SelectItem>
                    <SelectItem value="3">Date posted</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>
            <p className="text-metadata text-ink-dim">
              Country filters video results and videos under matching hashtags.
              Time and sort apply to the video search only — not to matching
              hashtags or their videos.
            </p>
            <div>
              <Button type="submit" disabled={niche.status === 'loading'}>
                Find creators
              </Button>
            </div>
          </form>
          <div className="mt-4">{renderResults(niche)}</div>
        </TabsContent>

        <TabsContent value="similar">
          <form onSubmit={searchSimilar} className="flex flex-col gap-3">
            <label className="flex flex-col gap-2 text-body font-medium text-ink">
              TikTok username
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="e.g. tiktok"
                required
              />
            </label>
            <div>
              <Button type="submit" disabled={similar.status === 'loading'}>
                Find similar creators
              </Button>
            </div>
          </form>
          <div className="mt-4">{renderResults(similar)}</div>
        </TabsContent>

        <TabsContent value="saved">
          <div className="flex flex-col gap-3">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setSavedSearch(savedSearchInput);
                setSavedPage(1);
              }}
              className="flex flex-col gap-3"
            >
              <label className="flex flex-col gap-2 text-body font-medium text-ink">
                Search saved creators
                <Input
                  value={savedSearchInput}
                  onChange={(event) => setSavedSearchInput(event.target.value)}
                  placeholder="e.g. name or @handle"
                />
              </label>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-2 text-body font-medium text-ink">
                  Source
                  <Select
                    value={savedSource}
                    onValueChange={(value) => {
                      setSavedSource(value);
                      setSavedPage(1);
                    }}
                  >
                    <SelectTrigger aria-label="Source">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="trending">Trending</SelectItem>
                      <SelectItem value="niche">Niche</SelectItem>
                      <SelectItem value="similar">Similar</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <Button type="submit">Search</Button>
                {savedFiltersActive ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setSavedSearchInput('');
                      setSavedSearch('');
                      setSavedSource('all');
                      setSavedPage(1);
                    }}
                  >
                    Clear search
                  </Button>
                ) : null}
              </div>
            </form>
            <div className="flex flex-wrap gap-3">
              <Button
                onClick={exportSavedCsv}
                disabled={exporting || savedTotal === 0}
              >
                {exporting ? 'Exporting…' : 'Export CSV'}
              </Button>
              <Button
                variant="destructive"
                onClick={() => setClearAllOpen(true)}
                disabled={savedTotal === 0}
              >
                Clear all
              </Button>
            </div>
            <p className="text-metadata text-ink-dim">
              Export downloads every saved creator, not just this page.
            </p>
            {exportError ? (
              <Banner
                variant="critical"
                title="Couldn't update saved creators"
                description={exportError}
              />
            ) : null}
            {savedQuery.isLoading ? (
              <p className="text-body text-ink-sub">Loading saved creators…</p>
            ) : savedQuery.isError ? (
              <Banner
                variant="critical"
                title="Couldn't load saved creators"
                description="Saved creators could not be loaded. Please try again."
              />
            ) : savedCreators.length === 0 ? (
              <p className="text-body text-ink-sub">
                {savedFiltersActive
                  ? 'No saved creators match that search.'
                  : 'No saved creators yet. Search trending, niche, or similar creators and they will be saved automatically.'}
              </p>
            ) : (
              <div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {savedCreators.map((creator) => (
                    <div key={creator.handle} className="flex flex-col gap-2">
                      <CreatorCard creator={creator} />
                      <Button
                        variant="outline"
                        className="self-end"
                        onClick={() => removeSaved(creator.handle)}
                        disabled={removingHandle === creator.handle}
                      >
                        {removingHandle === creator.handle ? 'Removing…' : 'Remove'}
                      </Button>
                    </div>
                  ))}
                </div>
                <ListPagination
                  page={savedPage}
                  totalPages={savedTotalPages}
                  total={savedTotal}
                  limit={30}
                  onPageChange={setSavedPage}
                />
              </div>
            )}
          </div>
          {clearAllOpen ? (
            <AlertDialog
              open
              onOpenChange={(open) => {
                if (!open) setClearAllOpen(false);
              }}
            >
              <AlertDialogContent data-testid="clear-all-saved-modal" className="sm:max-w-md">
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear all saved creators?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This deletes every saved creator for you —{' '}
                    {savedTotal === 1
                      ? '1 creator'
                      : `${savedTotal} creators`}
                    — and it cannot be undone. New searches will keep saving
                    automatically afterwards.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={clearingAll}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    data-testid="confirm-clear-all-saved-btn"
                    disabled={clearingAll}
                    onClick={(event) => {
                      event.preventDefault();
                      void clearAllSaved();
                    }}
                  >
                    {clearingAll ? 'Clearing…' : 'Clear all'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
