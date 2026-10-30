'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  NicheResponseSchema,
  RegionListResponseSchema,
  SimilarResponseSchema,
  TrendingResponseSchema,
  type Creator,
  type Region,
} from '@fbuploadpro/contracts';
import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import { Input } from '@/components/shared/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';
import { CreatorCard } from './creator-card';

type TabId = 'trending' | 'niche' | 'similar';

interface SearchState {
  status: 'idle' | 'loading' | 'done' | 'error';
  creators: Creator[];
  message: string | null;
  heading: string | null;
}

const IDLE_STATE: SearchState = {
  status: 'idle',
  creators: [],
  message: null,
  heading: null,
};

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
  const [hashtag, setHashtag] = React.useState('');
  const [word, setWord] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [trending, setTrending] = React.useState<SearchState>(IDLE_STATE);
  const [niche, setNiche] = React.useState<SearchState>(IDLE_STATE);
  const [similar, setSimilar] = React.useState<SearchState>(IDLE_STATE);

  const regionsQuery = useQuery({
    queryKey: ['creator-finder', 'regions', subdomain],
    queryFn: () =>
      api.get(buildTenantApiPath(subdomain, '/creator-finder/regions'), {
        schema: RegionListResponseSchema,
      }),
  });

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
      });
    } catch (err) {
      setTrending({
        status: 'error',
        creators: [],
        message: errorMessage(err),
        heading: null,
      });
    }
  }

  async function searchNiche(event: React.FormEvent) {
    event.preventDefault();
    setNiche({ status: 'loading', creators: [], message: null, heading: null });
    try {
      const result = await api.get(
        buildTenantApiPath(subdomain, '/creator-finder/niche'),
        {
          schema: NicheResponseSchema,
          query: { hashtag, word: word.trim() || undefined },
        },
      );
      setNiche({
        status: 'done',
        creators: result.creators,
        message:
          result.creators.length === 0
            ? `No creators were found for #${result.hashtag}${result.word ? ` matching "${result.word}"` : ''}.`
            : null,
        heading: `Creators for #${result.hashtag}`,
      });
    } catch (err) {
      setNiche({ status: 'error', creators: [], message: errorMessage(err), heading: null });
    }
  }

  async function searchSimilar(event: React.FormEvent) {
    event.preventDefault();
    setSimilar({ status: 'loading', creators: [], message: null, heading: null });
    try {
      const result = await api.get(
        buildTenantApiPath(subdomain, '/creator-finder/similar'),
        {
          schema: SimilarResponseSchema,
          query: { username },
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
      });
    } catch (err) {
      setSimilar({ status: 'error', creators: [], message: errorMessage(err), heading: null });
    }
  }

  function renderResults(state: SearchState) {
    if (state.status === 'loading') {
      return <p className="text-body text-ink-sub">Finding creators…</p>;
    }
    if (state.status === 'error') {
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
          already know. Finding only — nothing is contacted, published, or saved.
        </p>
      </div>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as TabId)}
      >
        <TabsList aria-label="Creator Finder">
          <TabsTrigger value="trending">Trending by country</TabsTrigger>
          <TabsTrigger value="niche">By niche / words</TabsTrigger>
          <TabsTrigger value="similar">Similar creators</TabsTrigger>
        </TabsList>

        <TabsContent value="trending">
          <div className="flex flex-col gap-3">
            {regionsQuery.isError ? (
              <Banner
                variant="critical"
                title="Couldn't load countries"
                description="The country list could not be loaded. Please try again."
              />
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
              Hashtag or niche word
              <Input
                value={hashtag}
                onChange={(event) => setHashtag(event.target.value)}
                placeholder="e.g. fitness"
                required
              />
            </label>
            <label className="flex flex-col gap-2 text-body font-medium text-ink">
              Filter by word in video titles (optional)
              <Input
                value={word}
                onChange={(event) => setWord(event.target.value)}
                placeholder="e.g. workout"
              />
            </label>
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
      </Tabs>
    </div>
  );
}
