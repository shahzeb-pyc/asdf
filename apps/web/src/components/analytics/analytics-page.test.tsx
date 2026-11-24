/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  AnalyticsAggregateResponseSchema,
  type AnalyticsAggregateResponse,
} from '@fbuploadpro/contracts';
import { AnalyticsPage } from './analytics-page';

const WS_ANAS = '7811b89e-92c8-4e7e-a069-44248230fc05';
const WS_KASHIF = '00949c27-bfc0-40ba-88e0-656c19ee98e2';
const WS_SOHAIL = '08776ad4-b356-4add-9056-6dcd97b51177';

const WORKSPACES = {
  workspaces: [
    { id: WS_ANAS, ownerId: '11111111-1111-4111-a111-111111111111', name: 'Anas Usman', subdomain: 'scorpionleos9' },
    { id: WS_KASHIF, ownerId: '11111111-1111-4111-a111-111111111111', name: 'Kashif Ahmad', subdomain: 'kashif' },
    { id: WS_SOHAIL, ownerId: '11111111-1111-4111-a111-111111111111', name: 'sohail', subdomain: 'sohail' },
  ],
};

function chartPoints(
  days: number,
  mediaPerDay: number,
  viewersPerDay: number,
): AnalyticsAggregateResponse['chart'] {
  const points: AnalyticsAggregateResponse['chart'] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(2026, 10, 22 - i));
    points.push({
      date: date.toISOString().slice(0, 10),
      mediaViews: mediaPerDay + i,
      uniqueViewers: viewersPerDay + i,
    });
  }
  return points;
}

function aggregateFixture(overrides: Partial<AnalyticsAggregateResponse>): AnalyticsAggregateResponse {
  return AnalyticsAggregateResponseSchema.parse({
    success: true,
    workspace: WS_ANAS,
    period: '28',
    dateRangeLabel: '26 Oct – 22 Nov 2026',
    periodLabel: 'Last 28 days · combined',
    pagesIncluded: 5,
    updatedAt: '2026-11-23T03:12:00.000Z',
    followers: { total: 60975, gained: 59803 },
    mediaViews: 590700,
    uniqueViewers: 250100,
    profileViews: 13600,
    engagement: 43740,
    videoViews: 458000,
    videoCompleteViews30s: 101000,
    watchTimeMs: 372 * 3_600_000,
    totalActions: 7600,
    newFollows: 6100,
    unfollows: 1370,
    netFollows: 4730,
    chart: chartPoints(28, 21000, 8900),
    topCountries: [
      { name: 'Pakistan', count: 40244, sharePct: 66 },
      { name: 'United States', count: 7927, sharePct: 13 },
      { name: 'United Kingdom', count: 3659, sharePct: 6 },
      { name: 'India', count: 2439, sharePct: 4 },
      { name: 'Bangladesh', count: 1829, sharePct: 3 },
      { name: 'Australia', count: 1219, sharePct: 2 },
    ],
    topCities: [
      { name: 'Karachi', count: 13415, sharePct: 22 },
      { name: 'Lahore', count: 8537, sharePct: 14 },
      { name: 'Islamabad', count: 4878, sharePct: 8 },
      { name: 'New York', count: 3659, sharePct: 6 },
      { name: 'Dhaka', count: 2439, sharePct: 4 },
      { name: 'London', count: 1829, sharePct: 3 },
    ],
    hasNoData: false,
    ...overrides,
  });
}

const FIXTURES = {
  '28': aggregateFixture({}),
  '7': aggregateFixture({
    period: '7',
    dateRangeLabel: '16 – 22 Nov 2026',
    periodLabel: 'Last 7 days · combined',
    mediaViews: 147650,
    uniqueViewers: 69750,
    profileViews: 3400,
    engagement: 10900,
    videoViews: 114000,
    videoCompleteViews30s: 25300,
    watchTimeMs: 93 * 3_600_000,
    totalActions: 1900,
    newFollows: 1480,
    unfollows: 340,
    netFollows: 1140,
    chart: chartPoints(7, 21000, 9900),
  }),
  '1': aggregateFixture({
    period: '1',
    dateRangeLabel: '22 Nov 2026',
    periodLabel: 'Yesterday · combined',
    mediaViews: 20260,
    uniqueViewers: 11580,
    profileViews: 591,
    engagement: 1461,
    videoViews: 15800,
    videoCompleteViews30s: 3600,
    watchTimeMs: 13 * 3_600_000,
    totalActions: 265,
    newFollows: 210,
    unfollows: 48,
    netFollows: 162,
    chart: chartPoints(1, 20260, 11580),
  }),
  all: aggregateFixture({
    workspace: 'all',
    mediaViews: 700000,
    uniqueViewers: 300000,
    followers: { total: 72000, gained: 61000 },
  }),
  empty: aggregateFixture({
    dateRangeLabel: '',
    periodLabel: 'Last 28 days · combined',
    pagesIncluded: 0,
    updatedAt: null,
    followers: { total: 0, gained: 0 },
    mediaViews: 0,
    uniqueViewers: 0,
    profileViews: 0,
    engagement: 0,
    videoViews: 0,
    videoCompleteViews30s: 0,
    watchTimeMs: 0,
    totalActions: 0,
    newFollows: 0,
    unfollows: 0,
    netFollows: 0,
    chart: [],
    topCountries: [],
    topCities: [],
    hasNoData: true,
  }),
};

// Mutable mock state: the mock reads it on every call, so a test can
// flip the aggregate fixture (or fail once) and rerender / retry.
const mockState = vi.hoisted(() => ({
  aggregate: '28' as '28' | '7' | '1' | 'all' | 'empty',
  failAnalyticsOnce: false,
  calls: [] as string[],
}));

const mockGet = vi.hoisted(() =>
  vi.fn(async (path: string) => {
    mockState.calls.push(path);
    // A macrotask delay, so the first paint is the loading state and
    // the tests can assert on it before the data arrives.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (path.startsWith('/api/workspaces')) return WORKSPACES;
    if (path.includes('/analytics')) {
      if (mockState.failAnalyticsOnce) {
        mockState.failAnalyticsOnce = false;
        throw new Error('boom');
      }
      const url = new URL(path, 'http://localhost');
      const workspace = url.searchParams.get('workspace');
      const period = url.searchParams.get('period');
      if (workspace === 'all') return FIXTURES.all;
      if (mockState.aggregate === 'empty') return FIXTURES.empty;
      return FIXTURES[period === '7' ? '7' : period === '1' ? '1' : '28'];
    }
    throw new Error(`unexpected api path ${path}`);
  }),
);

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return { ...original, api: { ...original.api, get: mockGet } };
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <AnalyticsPage subdomain="scorpionleos9" />
    </QueryClientProvider>,
  );
  return { ...result, client };
}

beforeEach(() => {
  mockState.aggregate = '28';
  mockState.failAnalyticsOnce = false;
  mockState.calls = [];
  mockGet.mockClear();
});

describe('AnalyticsPage', () => {
  it('renders every section with the current workspace and 28-day values by default', async () => {
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Loading analytics…');

    await screen.findByText('60,975');
    expect(screen.getByText('+59,803')).toBeInTheDocument();
    expect(screen.getByText('590,700')).toBeInTheDocument();
    expect(screen.getByText('250,100')).toBeInTheDocument();
    expect(screen.getByText('458,000')).toBeInTheDocument();
    expect(screen.getByText('101,000')).toBeInTheDocument();
    expect(screen.getByText('372')).toBeInTheDocument();
    expect(screen.getByText('hours')).toBeInTheDocument();
    expect(screen.getByText('43,740')).toBeInTheDocument();
    expect(screen.getByText('13,600')).toBeInTheDocument();
    expect(screen.getByText('7,600')).toBeInTheDocument();
    expect(screen.getByText('+4,730')).toBeInTheDocument();
    expect(screen.getByText('6,100')).toBeInTheDocument();
    expect(screen.getByText('1,370')).toBeInTheDocument();
    expect(screen.getByText('Pakistan')).toBeInTheDocument();
    expect(screen.getByText('40,244')).toBeInTheDocument();
    expect(screen.getByText('Karachi')).toBeInTheDocument();
    expect(screen.getByText('13,415')).toBeInTheDocument();
    expect(screen.getByText('26 Oct – 22 Nov 2026')).toBeInTheDocument();
    expect(screen.getByText('Last 28 days · combined')).toBeInTheDocument();
    expect(screen.getByText('Media views & unique viewers over time')).toBeInTheDocument();
    expect(screen.getByTestId('insights-trend-chart')).toBeInTheDocument();
    expect(screen.getByText('Video')).toBeInTheDocument();
    expect(screen.getByText('Interactions')).toBeInTheDocument();
    expect(screen.getByText('Follows')).toBeInTheDocument();
    expect(
      screen.getByText("Facebook's count in the period — not the gained number"),
    ).toBeInTheDocument();

    const picker = screen.getByLabelText('Workspace') as HTMLSelectElement;
    expect(picker.value).toBe(WS_ANAS);
    const selectedOption = picker.options[picker.selectedIndex];
    expect(selectedOption.textContent).toContain('Anas Usman');
    expect(selectedOption.textContent).toContain('current workspace');
    expect(screen.getByRole('button', { name: '28 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switching to 7 days swaps every value, including the date chip and sub-line', async () => {
    renderPage();
    await screen.findByText('590,700');

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));

    await screen.findByText('147,650');
    expect(screen.getByText('69,750')).toBeInTheDocument();
    expect(screen.getByText('114,000')).toBeInTheDocument();
    expect(screen.getByText('25,300')).toBeInTheDocument();
    expect(screen.getByText('93')).toBeInTheDocument();
    expect(screen.getByText('10,900')).toBeInTheDocument();
    expect(screen.getByText('3,400')).toBeInTheDocument();
    expect(screen.getByText('1,900')).toBeInTheDocument();
    expect(screen.getByText('1,480')).toBeInTheDocument();
    expect(screen.getByText('340')).toBeInTheDocument();
    expect(screen.getByText('+1,140')).toBeInTheDocument();
    expect(screen.getByText('16 – 22 Nov 2026')).toBeInTheDocument();
    expect(screen.getByText('Last 7 days · combined')).toBeInTheDocument();
    expect(screen.queryByText('590,700')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switching to 1 day shows yesterday only', async () => {
    renderPage();
    await screen.findByText('590,700');

    fireEvent.click(screen.getByRole('button', { name: '1 day' }));

    await screen.findByText('20,260');
    expect(screen.getByText('11,580')).toBeInTheDocument();
    expect(screen.getByText('15,800')).toBeInTheDocument();
    expect(screen.getByText('3,600')).toBeInTheDocument();
    expect(screen.getByText('13')).toBeInTheDocument();
    expect(screen.getByText('1,461')).toBeInTheDocument();
    expect(screen.getByText('591')).toBeInTheDocument();
    expect(screen.getByText('265')).toBeInTheDocument();
    expect(screen.getByText('210')).toBeInTheDocument();
    expect(screen.getByText('48')).toBeInTheDocument();
    expect(screen.getByText('+162')).toBeInTheDocument();
    expect(screen.getByText('22 Nov 2026')).toBeInTheDocument();
    expect(screen.getByText('Yesterday · combined')).toBeInTheDocument();
    expect(screen.queryByText('590,700')).not.toBeInTheDocument();
  });

  it('switching the workspace to All workspaces swaps the numbers', async () => {
    renderPage();
    await screen.findByText('590,700');

    const picker = screen.getByLabelText('Workspace') as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: 'all' } });

    await screen.findByText('700,000');
    expect(screen.getByText('300,000')).toBeInTheDocument();
    expect(screen.getByText('72,000')).toBeInTheDocument();
    expect(screen.queryByText('590,700')).not.toBeInTheDocument();
  });

  it('shows empty states when no page has stored analytics', async () => {
    mockState.aggregate = 'empty';
    renderPage();

    await screen.findByText('No analytics data yet — pages with 100+ followers are picked up on the next daily run.');
    expect(screen.getAllByText('No location data yet.')).toHaveLength(2);
    expect(screen.getByText('No daily data for this period yet.')).toBeInTheDocument();
    expect(screen.getByText('No data yet')).toBeInTheDocument();
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
  });

  it('shows an error with a retry when the aggregate fetch fails', async () => {
    mockState.failAnalyticsOnce = true;
    renderPage();

    await screen.findByText("Couldn't load analytics.");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText('590,700');
    await waitFor(() =>
      expect(screen.queryByText("Couldn't load analytics.")).not.toBeInTheDocument(),
    );
  });
});
