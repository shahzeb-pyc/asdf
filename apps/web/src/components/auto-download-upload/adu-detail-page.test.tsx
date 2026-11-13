/** @vitest-environment jsdom */
/**
 * ADU detail page — lazy tabs, targeted updates, reels pagination
 * (adu-opt-c F13/F14/F15/F17/F18/F19).
 *
 * Behavioural pins, not markup: an Overview landing fetches the
 * config only; the Reels tab fetches on first visit and pages with
 * keepPreviousData; a caption save never sends an empty caption and
 * never refetches; skip/delete clear the selection and draft and
 * update the list locally; a config failure after reels loaded does
 * not discard the reels; Insights receives the config timezone.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AduDetailPage } from './adu-detail-page';

const navMocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(''),
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('next/image', () => ({
  default: (props: { src?: string; alt?: string }) =>
    React.createElement('img', { src: props.src, alt: props.alt }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navMocks.push, replace: navMocks.replace }),
  useSearchParams: () => navMocks.searchParams,
}));

vi.mock('@/components/pages/dedicated', () => ({
  PageTabInsights: ({ pageTimezone }: { pageTimezone?: string }) => (
    <div data-testid="page-tab-insights">tz:{pageTimezone ?? 'none'}</div>
  ),
}));

const BASE = '/api/tenant/testws/auto-download-upload/cfg-1';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    destinationId: 'dest-1',
    destinationName: 'Ellie Blossom',
    destinationExternalId: 'fb-page-101',
    destinationAvatarUrl: null,
    accountName: 'Shahzeb Malik',
    accountAvatarUrl: null,
    sourcePlatform: 'tiktok',
    sourceUsername: 'someone',
    sourceLink: 'https://tiktok.com/@someone',
    sourceIdentity: '@someone',
    timezone: 'Asia/Karachi',
    postsPerDay: 3,
    scheduleType: 'dailyrandom',
    postingTimes: ['09:00', '13:00', '18:00'],
    status: 'active',
    syncStatus: 'synced',
    displayStatus: 'Active posting',
    alert: null,
    followersCount: 1000,
    followersGained: 5000,
    followersUpdatedAt: null,
    createdAt: '2026-10-12T00:00:00.000Z',
    postedCount: 3,
    pendingCount: 2,
    failedCount: 0,
    postedToday: 1,
    pendingToday: 2,
    failedToday: 0,
    ...overrides,
  };
}

const REEL1 = { id: 'r1', source_reel_id: 'sr-1', caption: 'First caption', media_url: null, status: 'downloaded', downloaded_at: '2026-11-12T10:00:00.000Z' };
const REEL2 = { id: 'r2', source_reel_id: 'sr-2', caption: 'Second caption', media_url: null, status: 'downloaded', downloaded_at: '2026-11-12T09:00:00.000Z' };
const REEL3 = { id: 'r3', source_reel_id: 'sr-3', caption: 'Third caption', media_url: null, status: 'downloaded', downloaded_at: '2026-11-12T08:00:00.000Z' };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

interface FetchCall {
  url: string;
  method: string;
  body?: unknown;
}

/** `failConfigAfterFirst`: every config GET after the first 500s. */
function setupFetch(opts: { failConfigAfterFirst?: boolean } = {}) {
  const calls: FetchCall[] = [];
  let configGets = 0;
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url === BASE && method === 'GET') {
      configGets += 1;
      if (opts.failConfigAfterFirst && configGets > 1) {
        return jsonResponse({ error: 'Boom.' }, false, 500);
      }
      return jsonResponse({ config: makeConfig() });
    }
    if (url === BASE && method === 'PATCH') return jsonResponse({ config: makeConfig() });
    if (url === `${BASE}/reels` && method === 'POST') return jsonResponse({ queued: true });
    if (url.startsWith(`${BASE}/reels?`) && method === 'GET') {
      const page = new URL(url, 'http://x').searchParams.get('page');
      if (page === '2') {
        return jsonResponse({ reels: [REEL3], page: 2, pageSize: 24, total: 26, totalPages: 2 });
      }
      return jsonResponse({ reels: [REEL1, REEL2], page: 1, pageSize: 24, total: 26, totalPages: 2 });
    }
    if (url === `${BASE}/failed`) return jsonResponse({ jobs: [] });
    if (url.startsWith(`${BASE}/reels/`) && method === 'PATCH') return jsonResponse({ updated: true });
    if (url.startsWith(`${BASE}/reels/`) && method === 'POST') return jsonResponse({ skipped: true });
    if (url.startsWith(`${BASE}/reels/`) && method === 'DELETE') return jsonResponse({ deleted: true });
    return jsonResponse({ error: `not mocked: ${method} ${url}` }, false, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function renderPage() {
  return render(<AduDetailPage subdomain="testws" configId="cfg-1" />);
}

async function openReelsTab() {
  // Radix TabsTrigger activates on mousedown, which fireEvent.click
  // never fires — use a real user click for tab switches.
  await userEvent.setup().click(screen.getByTestId('adu-detail-tab-reels-btn'));
  // The caption appears twice once loaded (grid card + synced draft),
  // so wait on the pagination label instead of the caption text.
  await screen.findByTestId('adu-reels-page-label');
}

async function clickTab(testId: string) {
  await userEvent.setup().click(screen.getByTestId(testId));
}

function getCalls(calls: FetchCall[], method: string, urlPrefix: string) {
  return calls.filter((c) => c.method === method && c.url.startsWith(urlPrefix));
}

describe('AduDetailPage (adu-opt-c)', { timeout: 20000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navMocks.searchParams = new URLSearchParams('');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('F13: an Overview landing fetches the config only — no reels, no failed jobs', async () => {
    const { calls } = setupFetch();
    renderPage();
    await screen.findByText('Ellie Blossom');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${BASE}`]);
  });

  it('F13/F15: first Reels visit fetches page 1; a page turn fetches page 2 and keeps page-1 rows visible while loading', async () => {
    const { calls } = setupFetch();
    renderPage();
    await screen.findByText('Ellie Blossom');
    await openReelsTab();
    expect(screen.getByTestId('adu-reels-page-label')).toHaveTextContent('Page 1 of 2 · 26 reels');
    expect(getCalls(calls, 'GET', `${BASE}/reels?`)).toHaveLength(1);
    expect(getCalls(calls, 'GET', `${BASE}/failed`)).toHaveLength(0);

    fireEvent.click(screen.getByTestId('adu-reels-next-page'));
    // keepPreviousData: the page-1 rows are still on screen while
    // the page-2 fetch is in flight.
    expect(screen.getAllByText('First caption').length).toBeGreaterThan(0);
    await screen.findByText('Page 2 of 2 · 26 reels');
    expect(screen.getAllByText('Third caption').length).toBeGreaterThan(0);
    expect(getCalls(calls, 'GET', `${BASE}/reels?page=2`)).toHaveLength(1);
  });

  it('F13: a ?tab=reels landing fetches reels on mount, still no failed jobs', async () => {
    navMocks.searchParams = new URLSearchParams('tab=reels');
    const { calls } = setupFetch();
    renderPage();
    await screen.findByTestId('adu-reels-page-label');
    expect(getCalls(calls, 'GET', `${BASE}/reels?`)).toHaveLength(1);
    expect(getCalls(calls, 'GET', `${BASE}/failed`)).toHaveLength(0);
  });

  it('F13: the Failed tab fetches failed jobs on first visit only', async () => {
    const { calls } = setupFetch();
    renderPage();
    await screen.findByText('Ellie Blossom');
    await clickTab('adu-detail-tab-failed-btn');
    await screen.findByText('No Failed Posts Found');
    expect(getCalls(calls, 'GET', `${BASE}/failed`)).toHaveLength(1);
    expect(getCalls(calls, 'GET', `${BASE}/reels?`)).toHaveLength(0);
  });

  it('F19/F14: the caption draft starts from the selected reel, and Save sends that caption with no refetch', async () => {
    const { calls } = setupFetch();
    renderPage();
    await screen.findByText('Ellie Blossom');
    await openReelsTab();
    // The workspace auto-selects the first reel: its caption is the
    // draft — never an empty string that would wipe it on save.
    expect(screen.getByDisplayValue('First caption')).toBeInTheDocument();
    const getsBefore = getCalls(calls, 'GET', BASE).length;
    fireEvent.click(screen.getByRole('button', { name: 'Save Caption' }));
    await screen.findByText('Caption saved.');
    const patch = calls.find((c) => c.method === 'PATCH' && c.url === `${BASE}/reels/r1`);
    expect(patch?.body).toEqual({ caption: 'First caption' });
    expect(getCalls(calls, 'GET', BASE).length).toBe(getsBefore);
    expect(getCalls(calls, 'GET', `${BASE}/reels?`).length).toBe(1);
    expect(screen.getAllByText('First caption').length).toBeGreaterThan(0);
  });

  it('F19/F14: Skip clears the selection and draft, removes the row locally, and never refetches', async () => {
    const { calls } = setupFetch();
    renderPage();
    await screen.findByText('Ellie Blossom');
    await openReelsTab();
    const getsBefore = calls.filter((c) => c.method === 'GET').length;
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await screen.findByText('Reel skipped.');
    expect(calls.find((c) => c.method === 'POST' && c.url === `${BASE}/reels/r1`)?.body).toEqual({ action: 'skip' });
    // The skipped reel is gone; the workspace now shows the next
    // reel with ITS caption — a later save cannot 400 on the skipped
    // reel.
    expect(screen.queryByText('First caption')).not.toBeInTheDocument();
    expect(await screen.findByDisplayValue('Second caption')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'GET').length).toBe(getsBefore);
  });

  it('F19/F14: Delete clears the selection and draft and removes the row locally', async () => {
    setupFetch();
    renderPage();
    await screen.findByText('Ellie Blossom');
    await openReelsTab();
    // Two "Delete" buttons exist (page header first, reel workspace
    // second); the workspace one removes the selected reel.
    const deletes = screen.getAllByRole('button', { name: 'Delete' });
    fireEvent.click(deletes[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove reel' }));
    await screen.findByText('Reel removed.');
    expect(screen.queryByText('First caption')).not.toBeInTheDocument();
    expect(await screen.findByDisplayValue('Second caption')).toBeInTheDocument();
  });

  it('F17: a config fetch failure after reels loaded keeps the reels on screen', async () => {
    const { calls } = setupFetch({ failConfigAfterFirst: true });
    renderPage();
    await screen.findByText('Ellie Blossom');
    await openReelsTab();
    // Discover triggers a silent config-only refresh, which now 500s.
    fireEvent.click(screen.getByRole('button', { name: 'Discover reels' }));
    await screen.findByText('Discovery done.');
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getAllByText('First caption').length).toBeGreaterThan(0);
    // Exactly two config GETs (initial + the silent refresh after
    // Discover) — the reels GET is a different URL, not a refetch.
    expect(calls.filter((c) => c.method === 'GET' && c.url === BASE).length).toBe(2);
  });

  it('F18: Insights receives the config timezone, not UTC', async () => {
    setupFetch();
    renderPage();
    await screen.findByText('Ellie Blossom');
    await clickTab('adu-detail-tab-insights-btn');
    expect(await screen.findByTestId('page-tab-insights')).toHaveTextContent('tz:Asia/Karachi');
  });

  it('return links: hub page 2 + filters are carried back — breadcrumb and Back to Hub keep page, search, sort and status, and drop tab', async () => {
    navMocks.searchParams = new URLSearchParams('page=2&q=ellie&status=Active&sort=Most+Followers&tab=reels');
    setupFetch();
    renderPage();
    await screen.findByText('Ellie Blossom');
    const expected = '/tenant/testws/auto-download-upload?q=ellie&status=Active&sort=Most+Followers&page=2';
    expect(screen.getByRole('link', { name: 'Auto Download/Upload' }).getAttribute('href')).toBe(expected);
    const backButton = screen.getByRole('button', { name: 'Back to Hub' });
    expect(backButton.closest('a')?.getAttribute('href')).toBe(expected);
  });

  it('return links: a filtered page-1 hub keeps the filter and adds no page param', async () => {
    navMocks.searchParams = new URLSearchParams('status=Active');
    setupFetch();
    renderPage();
    await screen.findByText('Ellie Blossom');
    const expected = '/tenant/testws/auto-download-upload?status=Active';
    expect(screen.getByRole('link', { name: 'Auto Download/Upload' }).getAttribute('href')).toBe(expected);
    expect(screen.getByRole('button', { name: 'Back to Hub' }).closest('a')?.getAttribute('href')).toBe(expected);
  });

  it('return links: no hub query on the detail URL keeps the bare hub path', async () => {
    setupFetch();
    renderPage();
    await screen.findByText('Ellie Blossom');
    const expected = '/tenant/testws/auto-download-upload';
    expect(screen.getByRole('link', { name: 'Auto Download/Upload' }).getAttribute('href')).toBe(expected);
    expect(screen.getByRole('button', { name: 'Back to Hub' }).closest('a')?.getAttribute('href')).toBe(expected);
  });
});
