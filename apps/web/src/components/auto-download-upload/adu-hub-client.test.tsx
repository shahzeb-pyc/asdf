/**
 * ADU hub client — caching + URL pagination (Stream B, adu-opt-b).
 *
 * Behavioural tests for the regressions this slice fixes:
 * - a stale search response must never overwrite a newer one (F4);
 * - back-navigation restores page 2 from the URL (pagination step 1);
 * - a page turn keeps the previous page visible and does not refetch
 *   stats (F5/F6 + step 7).
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AduHubPage, resolveAduHubSearchParams } from './adu-hub-page';

// Mutable navigation state for the test: the mock reads it on every
// render, so changing `search` + rerendering simulates a popstate.
const navState = vi.hoisted(() => ({
  search: '',
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(navState.search),
  // replace updates the mocked URL, like the real router: the hub's
  // adopt effect must see the URL the hub itself just wrote, or it
  // would revert every filter/page change back to the stale URL.
  useRouter: () => ({
    push: navState.push,
    replace: (url: string, options?: { scroll: boolean }) => {
      navState.replace(url, options);
      navState.search = url.startsWith('?') ? url.slice(1) : '';
    },
  }),
}));

vi.mock('next/image', () => ({
  default: (props: { src?: string; alt?: string }) =>
    React.createElement('img', { src: props.src, alt: props.alt }),
}));

vi.mock('@/components/billing/entitlement-provider', () => ({
  useSharedEntitlement: () => ({ entitlement: null, isLoading: false }),
}));

function config(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cfg-a',
    destinationId: 'dest-a',
    destinationName: 'Alpha Page',
    destinationExternalId: 'fb-page-101',
    destinationAvatarUrl: null,
    sourcePlatform: 'tiktok',
    sourceUsername: 'someone',
    sourceIdentity: '@someone',
    sourceLink: 'https://tiktok.com/@someone',
    destinationStatus: 'active',
    accountName: 'Shahzeb Malik',
    status: 'active',
    displayStatus: 'Active posting',
    followersCount: 1000,
    followersGained: 5000,
    followersUpdatedAt: null,
    timezone: 'Asia/Karachi',
    createdAt: '2026-10-12T00:00:00.000Z',
    postedCount: 3,
    pendingCount: 1,
    failedCount: 0,
    postedToday: 1,
    pendingToday: 0,
    failedToday: 0,
    postsPerDay: 3,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function listBody(configs: unknown[], totalPages: number) {
  return {
    configs,
    totalPages,
    stats: { totalPages: configs.length, followersGained: 4000, totalFollowers: 5000 },
    migrationMissing: false,
  };
}

function statsBody() {
  return { stats: { totalPages: 2, followersGained: 4000, totalFollowers: 5000 } };
}

function renderHub(initialSearch = '') {
  navState.search = initialSearch;
  navState.replace.mockClear();
  navState.push.mockClear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderUi = () => (
    <QueryClientProvider client={client}>
      <AduHubPage subdomain="testws" />
    </QueryClientProvider>
  );
  const result = render(renderUi());
  return {
    ...result,
    client,
    // A fresh element on rerender: React bails out of re-rendering a
    // subtree given the identical element object, so the same `ui`
    // would never re-read the (changed) search params.
    rerenderHub: () => result.rerender(renderUi()),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('resolveAduHubSearchParams', () => {
  it('defaults an empty query string to page 1 with no filters', () => {
    expect(resolveAduHubSearchParams(new URLSearchParams(''))).toEqual({
      q: '',
      status: 'All Statuses',
      sort: 'Newest First',
      page: 1,
    });
  });

  it('reads q, status, sort and page from the URL', () => {
    expect(
      resolveAduHubSearchParams(
        new URLSearchParams('q=ellie&status=Active&sort=Most+Followers&page=2'),
      ),
    ).toEqual({ q: 'ellie', status: 'Active', sort: 'Most Followers', page: 2 });
  });

  it('falls back to defaults for invalid values, never a 404', () => {
    expect(
      resolveAduHubSearchParams(
        new URLSearchParams('status=Bogus&sort=Bogus&page=abc'),
      ),
    ).toEqual({ q: '', status: 'All Statuses', sort: 'Newest First', page: 1 });
    expect(resolveAduHubSearchParams(new URLSearchParams('page=0'))).toEqual({
      q: '',
      status: 'All Statuses',
      sort: 'Newest First',
      page: 1,
    });
  });
});

describe('AduHubPage URL state (pagination step 1)', () => {
  it('restores page 2, search, status and sort from the URL on mount', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('stats=only')) return jsonResponse(statsBody());
        return jsonResponse(listBody([config({ id: 'cfg-b', destinationName: 'Beta Page' })], 2));
      }),
    );
    renderHub('?page=2&status=Active&q=ellie&sort=Most+Followers');
    await screen.findByTestId('adu-page-card-cfg-b');
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();
    expect((screen.getByLabelText('Search pages or sources') as HTMLInputElement).value).toBe('ellie');
    expect(screen.getByLabelText('Filter by status').textContent).toContain('Active');
    expect(screen.getByLabelText('Sort pages').textContent).toContain('Most Followers');
    const listCall = calls.find((u) => u.includes('stats=none'));
    expect(listCall).toContain('page=2');
    expect(listCall).toContain('q=ellie');
    expect(listCall).toContain('status=Active');
    expect(listCall).toContain('sort=Most+Followers');
  });

  it('adopts a URL change (Back) back to page 1', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('stats=only')) return jsonResponse(statsBody());
        const page = new URL(url, 'http://test').searchParams.get('page');
        return jsonResponse(
          listBody(
            page === '2'
              ? [config({ id: 'cfg-b', destinationName: 'Beta Page' })]
              : [config({ id: 'cfg-a', destinationName: 'Alpha Page' })],
            2,
          ),
        );
      }),
    );
    const { rerenderHub } = renderHub('?page=2');
    await screen.findByTestId('adu-page-card-cfg-b');
    expect(screen.getByText('Page 2 of 2')).toBeTruthy();

    // Browser Back: the URL loses ?page=2; the hub adopts page 1.
    navState.search = '';
    rerenderHub();
    await screen.findByTestId('adu-page-card-cfg-a');
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    expect(calls.some((u) => u.includes('stats=none') && u.includes('page=1'))).toBe(true);
  });

  it('writes ?page= to the URL on a page turn, via replace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('stats=only')) return jsonResponse(statsBody());
        return jsonResponse(listBody([config()], 2));
      }),
    );
    renderHub();
    await screen.findByTestId('adu-page-card-cfg-a');
    fireEvent.click(screen.getByText('Next'));
    await waitFor(() =>
      expect(navState.replace).toHaveBeenCalledWith('?page=2', { scroll: false }),
    );
  });
});

describe('AduHubPage page turns (F5/F6, step 7)', () => {
  it('keeps the previous page visible while the next loads, and does not refetch stats', async () => {
    let resolvePage2: ((value: unknown) => void) | null = null;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('stats=only')) return jsonResponse(statsBody());
        if (url.includes('page=2')) {
          return new Promise((resolve) => {
            resolvePage2 = () =>
              resolve(jsonResponse(listBody([config({ id: 'cfg-b', destinationName: 'Beta Page' })], 2)));
          });
        }
        return jsonResponse(listBody([config({ id: 'cfg-a', destinationName: 'Alpha Page' })], 2));
      }),
    );
    renderHub();
    await screen.findByTestId('adu-page-card-cfg-a');
    expect(calls.filter((u) => u.includes('stats=only'))).toHaveLength(1);

    fireEvent.click(screen.getByText('Next'));
    // keepPreviousData: the old page stays rendered — no blanking,
    // no "Loading pages…" — while page 2 is in flight.
    expect(screen.getByTestId('adu-page-card-cfg-a')).toBeTruthy();
    expect(screen.queryByText('Loading pages…')).toBeNull();
    // A pure page turn never refetches stats (stats key has no page).
    expect(calls.filter((u) => u.includes('stats=only'))).toHaveLength(1);
    // Page buttons disable while the load is in flight (React Query
    // reports isFetching via a batched notification, so this is
    // awaited rather than asserted synchronously after the click).
    await waitFor(() =>
      expect((screen.getByText('Next') as HTMLButtonElement).disabled).toBe(true),
    );

    await act(async () => {
      resolvePage2?.(undefined);
    });
    await screen.findByTestId('adu-page-card-cfg-b');
    expect(screen.queryByTestId('adu-page-card-cfg-a')).toBeNull();
    expect(calls.filter((u) => u.includes('stats=only'))).toHaveLength(1);
  });
});

describe('AduHubPage search (F4)', () => {
  it('debounces search and a stale response never overwrites a newer one', async () => {
    const pending: Array<{ url: string; resolve: () => void }> = [];
    const calls: string[] = [];
    const bodyFor = (url: string) => {
      const q = new URL(url, 'http://test').searchParams.get('q') ?? '';
      if (q === 'ab') return listBody([config({ id: 'cfg-ab', destinationName: 'Alphabet Page' })], 1);
      if (q === 'a') return listBody([config({ id: 'cfg-a', destinationName: 'Alpha Page' })], 1);
      return listBody([config({ id: 'cfg-base', destinationName: 'Base Page' })], 1);
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('stats=only')) return jsonResponse(statsBody());
        const body = bodyFor(url);
        return new Promise((resolve) => {
          pending.push({ url, resolve: () => resolve(jsonResponse(body)) });
        });
      }),
    );
    renderHub();
    // Initial load resolves (list q='' + stats q='').
    await act(async () => {
      pending.splice(0).forEach((p) => p.resolve());
    });
    await screen.findByTestId('adu-page-card-cfg-base');
    // 'q=a&' (with the trailing &) matches q=a but not q=ab.
    const listCalls = (q: string) =>
      calls.filter((u) => u.includes('stats=none') && u.includes(`q=${q}&`));

    // Type 'a' and wait out the ~300 ms debounce: one list fetch.
    fireEvent.change(screen.getByLabelText('Search pages or sources'), { target: { value: 'a' } });
    await waitFor(() => expect(listCalls('a')).toHaveLength(1));

    // Type 'ab' before the 'a' response lands: one fetch for q=ab.
    fireEvent.change(screen.getByLabelText('Search pages or sources'), { target: { value: 'ab' } });
    await waitFor(() => expect(listCalls('ab')).toHaveLength(1));

    // The newer response lands first…
    await act(async () => {
      pending
        .splice(0)
        .filter((p) => p.url.includes('q=ab&'))
        .forEach((p) => p.resolve());
    });
    await screen.findByTestId('adu-page-card-cfg-ab');

    // …then the stale 'a' response lands — it must not overwrite.
    await act(async () => {
      pending.splice(0).forEach((p) => p.resolve());
    });
    expect(screen.getByTestId('adu-page-card-cfg-ab')).toBeTruthy();
    expect(screen.queryByTestId('adu-page-card-cfg-a')).toBeNull();
  });
});

describe('AduHubPage card navigation (pagination step 2)', () => {
  it('navigates with router.push, not a document reload, and prefetches the detail query once on hover', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('stats=only')) return jsonResponse(statsBody());
        if (url.endsWith('/auto-download-upload/cfg-a')) {
          return jsonResponse({ config: config() });
        }
        return jsonResponse(listBody([config()], 1));
      }),
    );
    renderHub();
    const card = await screen.findByTestId('adu-page-card-cfg-a');
    const hrefBefore = window.location.href;

    fireEvent.mouseEnter(card);
    fireEvent.mouseEnter(card);
    await waitFor(() =>
      expect(calls.filter((u) => u.endsWith('/auto-download-upload/cfg-a'))).toHaveLength(1),
    );

    fireEvent.click(card);
    expect(navState.push).toHaveBeenCalledWith('/tenant/testws/auto-download-upload/cfg-a');
    expect(window.location.href).toBe(hrefBefore);
  });
});

describe('AduHubPage create (F12)', () => {
  it('performs exactly one list refetch after a create', async () => {
    const calls: string[] = [];
    const accountId = '11111111-1111-4111-8111-111111111111';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        calls.push(url);
        if (init?.method === 'POST') return jsonResponse({ created: [{ destinationId: 'p2' }], failed: [] });
        if (url.includes('/options')) {
          return jsonResponse({
            accounts: [{ id: accountId, external_account_id: 'fb-acc-1', display_name: 'Shahzeb Malik', avatar_url: null, status: 'active' }],
            pages: [{ id: 'p2', account_id: accountId, external_destination_id: 'fb-page-102', name: 'UK Videos', avatar_url: null, status: 'active', metadata: {} }],
            configured: [],
            migrationMissing: false,
          });
        }
        if (url.includes('/pages/discover')) {
          return jsonResponse({
            accountId,
            accountDisplayName: 'Shahzeb Malik',
            pages: [{ fbPageId: 'fb-page-102', pageName: 'UK Videos', profilePictureUrl: null, category: 'Social media agency', currentFollowers: 0, followersCount: 0, tasks: [], isImported: false }],
            total: 1,
            truncated: false,
            partial: false,
            droppedCount: 0,
          });
        }
        if (url.includes('stats=only')) return jsonResponse(statsBody());
        return jsonResponse(listBody([config()], 1));
      }),
    );
    renderHub();
    await screen.findByTestId('adu-page-card-cfg-a');
    const listCalls = () => calls.filter((u) => u.includes('stats=none'));
    const statsCalls = () => calls.filter((u) => u.includes('stats=only'));
    expect(listCalls()).toHaveLength(1);
    expect(statsCalls()).toHaveLength(1);

    fireEvent.click(screen.getByText('+ Add Page'));
    await screen.findByText('Shahzeb Malik');
    fireEvent.click(screen.getByText('Shahzeb Malik'));
    fireEvent.click(screen.getByTestId('adu-accounts-next-btn'));
    await screen.findByTestId('adu-pages-list');
    fireEvent.click(screen.getByTestId(`adu-page-checkbox-${accountId}-fb-page-102`));
    fireEvent.click(screen.getByTestId('adu-pages-next-btn'));
    await screen.findByText('Sources');
    fireEvent.change(screen.getByPlaceholderText('@username'), { target: { value: 'sdf' } });
    fireEvent.click(screen.getByTestId('adu-sources-next-btn'));
    await screen.findByText('Posting Time');
    fireEvent.click(screen.getByText('Start Automation'));

    // The hub's onCreated closes the dialog (the result banner lives
    // inside it, so it unmounts with it) — the observable proof of the
    // create is the invalidation-driven refetch, not the banner text.
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    await waitFor(() => expect(statsCalls()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(listCalls()).toHaveLength(2);
    expect(statsCalls()).toHaveLength(2);
  });
});
