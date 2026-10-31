/**
 * @file instagram-schedule-components.test.tsx
 * @description Behavioural tests for the Instagram Schedule section
 * components (PR #67): ScheduleCard, DashboardPanel, InsightsPanel
 * and CalendarPanel, rendered live (Testing Library, jsdom project)
 * and asserted on visible behaviour and interaction — never static
 * markup probes. Panels that fetch do so through the typed API
 * client, so fetch is mocked by queue status (queued / failed /
 * published) or, for the calendar, by the month window — the same
 * pattern as tests/ui/pages-behaviour.test.tsx. No timers and no
 * network: the calendar derives its expected month from the same
 * current UTC date the panel reads, so no fake clock is needed.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ScheduleCard } from '@/components/instagram/schedule/schedule-card';
import { DashboardPanel } from '@/components/instagram/schedule/dashboard-panel';
import { InsightsPanel } from '@/components/instagram/schedule/insights-panel';
import { CalendarPanel } from '@/components/instagram/schedule/calendar-panel';
import type {
  InstagramScheduleItem,
  InstagramScheduleQueueItem,
} from '@/lib/api/schemas/instagram-schedule';

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => (
    <img
      alt={String(props.alt ?? '')}
      src={String(props.src ?? '')}
      data-testid="schedule-card-avatar"
    />
  ),
}));

const DESTINATION_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function makeItem(
  overrides: Partial<InstagramScheduleItem> = {}
): InstagramScheduleItem {
  return {
    id: DESTINATION_ID,
    accountId: ACCOUNT_ID,
    accountDisplayName: 'Sunset Bakery',
    accountAvatarUrl: null,
    handle: 'sunsetbakery',
    accountType: 'Business',
    status: 'active',
    timezone: 'Asia/Karachi',
    slotCount: 3,
    counts: { queued: 7, posted: 12, failed: 2 },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

let queueCounter = 0;
function makeQueueItem(
  overrides: Partial<InstagramScheduleQueueItem> = {}
): InstagramScheduleQueueItem {
  queueCounter += 1;
  const n = String(queueCounter).padStart(2, '0');
  return {
    id: `44444444-4444-4444-8444-4444444444${n}`,
    userId: USER_ID,
    pageId: DESTINATION_ID,
    slotId: null,
    mediaId: null,
    postFormat: 'image',
    linkUrl: null,
    scheduledTime: '2026-11-10T09:00:00.000Z',
    caption: `Queued caption ${n}`,
    firstComment: null,
    status: 'queued',
    retryCount: 0,
    maxRetries: 3,
    fbPostId: null,
    fbCommentId: null,
    publishedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    media: null,
    kind: 'image',
    platformFormat: null,
    displayFormat: 'image',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface QueueData {
  queued?: InstagramScheduleQueueItem[];
  failed?: InstagramScheduleQueueItem[];
  published?: InstagramScheduleQueueItem[];
  calendar?: InstagramScheduleQueueItem[];
}

function installQueueFetch(data: QueueData) {
  const originalFetch = global.fetch;
  global.fetch = (async (input: unknown) => {
    const url = new URL(String(input), 'http://localhost');
    const status = url.searchParams.get('status');
    let items: InstagramScheduleQueueItem[];
    if (status === 'queued') items = data.queued ?? [];
    else if (status === 'failed') items = data.failed ?? [];
    else if (status === 'published') items = data.published ?? [];
    else items = data.calendar ?? [];
    return jsonResponse({
      items,
      total: items.length,
      limit: 200,
      offset: 0,
    });
  }) as unknown as typeof fetch;
  return originalFetch;
}

function withQueryClient(node: React.ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return (
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  );
}

/** The month the CalendarPanel opens on: the current UTC month. */
function currentMonth() {
  const today = new Date();
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const label = new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month, 1)));
  const next = new Date(Date.UTC(year, month + 1, 1));
  const nextLabel = new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(next);
  const nextDays = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)
  ).getUTCDate();
  const dayKey = (day: number) =>
    `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const noonUtc = (day: number) =>
    `${dayKey(day)}T12:00:00.000Z`;
  return { year, month, daysInMonth, label, nextLabel, nextDays, dayKey, noonUtc };
}

describe('ScheduleCard behaviour', () => {
  const statuses = [
    {
      status: 'active' as const,
      label: 'Connected',
      kind: 'operational',
    },
    { status: 'paused' as const, label: 'Paused', kind: 'queued' },
    {
      status: 'expired' as const,
      label: 'Session expired',
      kind: 'critical',
    },
    {
      status: 'disconnected' as const,
      label: 'Disconnected',
      kind: 'critical',
    },
  ];

  it.each(statuses)(
    'shows the $label status mark for a $status schedule',
    ({ status, label, kind }) => {
      render(
        <ScheduleCard
          item={makeItem({ status })}
          subdomain="acme"
          onSelect={vi.fn()}
        />
      );
      const mark = screen.getByTestId(
        `instagram-schedule-status-${DESTINATION_ID}`
      );
      expect(mark.getAttribute('aria-label')).toBe(label);
      expect(mark.getAttribute('data-status')).toBe(kind);
      expect(mark.textContent).toContain(label);
    }
  );

  it('shows queued / posted / failed counts, slot summary and timezone', () => {
    render(
      <ScheduleCard item={makeItem()} subdomain="acme" onSelect={vi.fn()} />
    );
    const card = screen.getByTestId(
      `instagram-schedule-card-${DESTINATION_ID}`
    );
    expect(card.textContent).toContain('Queued');
    expect(card.textContent).toContain('Posted');
    expect(card.textContent).toContain('Failed');
    // Counts are the item's own: 7 queued, 12 posted, 2 failed.
    const values = Array.from(card.querySelectorAll('dd')).map(
      (dd) => dd.textContent
    );
    expect(values).toEqual(['7', '12', '2']);
    expect(card.textContent).toContain('3 posting times · Asia/Karachi');
  });

  it('uses the singular "posting time" for one slot', () => {
    render(
      <ScheduleCard
        item={makeItem({ slotCount: 1, timezone: 'Europe/London' })}
        subdomain="acme"
        onSelect={vi.fn()}
      />
    );
    expect(
      screen.getByTestId(`instagram-schedule-card-${DESTINATION_ID}`)
        .textContent
    ).toContain('1 posting time · Europe/London');
  });

  it('shows the display name, @handle and account type', () => {
    render(
      <ScheduleCard item={makeItem()} subdomain="acme" onSelect={vi.fn()} />
    );
    expect(screen.getByText('Sunset Bakery')).toBeTruthy();
    expect(screen.getByText('@sunsetbakery · Business')).toBeTruthy();
  });

  it('falls back to "Instagram account" when there is no handle', () => {
    render(
      <ScheduleCard
        item={makeItem({ handle: null, accountType: null })}
        subdomain="acme"
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByText('Instagram account')).toBeTruthy();
  });

  it('applies the gold highlight only when highlighted', () => {
    const { rerender } = render(
      <ScheduleCard
        item={makeItem()}
        subdomain="acme"
        highlighted
        onSelect={vi.fn()}
      />
    );
    const highlighted = screen.getByTestId(
      `instagram-schedule-card-${DESTINATION_ID}`
    );
    expect(highlighted.className).toContain('border-brand-gold');
    expect(highlighted.className).toContain('bg-brand-gold/10');

    rerender(
      <ScheduleCard item={makeItem()} subdomain="acme" onSelect={vi.fn()} />
    );
    const plain = screen.getByTestId(
      `instagram-schedule-card-${DESTINATION_ID}`
    );
    expect(plain.className).not.toContain('border-brand-gold');
    expect(plain.className).not.toContain('bg-brand-gold/10');
  });

  it('clicking the card calls onSelect with the item', () => {
    const onSelect = vi.fn();
    const item = makeItem();
    render(<ScheduleCard item={item} subdomain="acme" onSelect={onSelect} />);
    fireEvent.click(
      screen.getByTestId(`instagram-schedule-card-${DESTINATION_ID}`)
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(item);
  });

  it('renders the avatar image when one exists, and the initial fallback when it does not', () => {
    const { rerender } = render(
      <ScheduleCard
        item={makeItem({ accountAvatarUrl: 'https://example.com/avatar.jpg' })}
        subdomain="acme"
        onSelect={vi.fn()}
      />
    );
    const avatar = screen.getByTestId('schedule-card-avatar');
    expect(avatar.getAttribute('src')).toContain('avatar.jpg');
    expect(screen.queryByText('S')).toBeNull();

    rerender(
      <ScheduleCard
        item={makeItem({ accountAvatarUrl: null })}
        subdomain="acme"
        onSelect={vi.fn()}
      />
    );
    expect(screen.queryByTestId('schedule-card-avatar')).toBeNull();
    // Fallback is the first letter of the display name, upper-cased.
    expect(screen.getByText('S')).toBeTruthy();
  });
});

describe('DashboardPanel behaviour', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function renderPanel(
    item: InstagramScheduleItem,
    callbacks: { onCreatePost?: () => void; onViewQueue?: () => void } = {}
  ) {
    const onCreatePost = callbacks.onCreatePost ?? vi.fn();
    const onViewQueue = callbacks.onViewQueue ?? vi.fn();
    render(
      withQueryClient(
        <DashboardPanel
          subdomain="acme"
          item={item}
          onCreatePost={onCreatePost}
          onViewQueue={onViewQueue}
        />
      )
    );
    return { onCreatePost, onViewQueue };
  }

  it('shows the queue counts from props and the posting-times summary', async () => {
    installQueueFetch({ queued: [], failed: [] });
    renderPanel(makeItem());
    const panel = screen.getByTestId('instagram-schedule-dashboard-panel');
    expect(panel.textContent).toContain('Queued');
    expect(panel.textContent).toContain('Posted');
    expect(panel.textContent).toContain('Failed');
    expect(panel.textContent).toContain('3 posting times · Asia/Karachi');
    // Counts render as the big numbers: 7 queued, 12 posted, 2 failed.
    const bigNumbers = Array.from(
      panel.querySelectorAll('p.text-xxl')
    ).map((p) => p.textContent);
    expect(bigNumbers).toEqual(['7', '12', '2']);
    await waitFor(() =>
      expect(
        screen.getByText('Nothing is queued yet. Create a post to fill this schedule.')
      ).toBeTruthy()
    );
  });

  it('shows the next scheduled post with its formatted date and caption', async () => {
    installQueueFetch({
      queued: [
        makeQueueItem({
          scheduledTime: '2026-11-05T09:00:00.000Z',
          caption: 'Morning reel draft',
        }),
      ],
      failed: [],
    });
    renderPanel(makeItem());
    // 09:00 UTC is 14:00 in Asia/Karachi on 05 Nov.
    expect(await screen.findByText(/05 Nov/)).toBeTruthy();
    expect(screen.getByText('Morning reel draft')).toBeTruthy();
  });

  it('shows "Next posting time" for a next post with no scheduled time, and "No caption" for a blank caption', async () => {
    installQueueFetch({
      queued: [makeQueueItem({ scheduledTime: null, caption: '' })],
      failed: [],
    });
    renderPanel(makeItem());
    expect(await screen.findByText('Next posting time')).toBeTruthy();
    expect(screen.getByText('No caption')).toBeTruthy();
  });

  it('shows the empty state and still offers Create post / View queue when nothing is queued', async () => {
    installQueueFetch({ queued: [], failed: [] });
    const onCreatePost = vi.fn();
    const onViewQueue = vi.fn();
    renderPanel(makeItem(), { onCreatePost, onViewQueue });
    expect(
      await screen.findByText(
        'Nothing is queued yet. Create a post to fill this schedule.'
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create post' }));
    expect(onCreatePost).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'View queue' }));
    expect(onViewQueue).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Recent failed posts')).toBeNull();
  });

  it('lists recent failed posts and routes "View all failed posts" to the queue', async () => {
    installQueueFetch({
      queued: [],
      failed: [
        makeQueueItem({ caption: 'Failed reel one', status: 'failed' }),
        makeQueueItem({ caption: '', status: 'failed' }),
      ],
    });
    const onViewQueue = vi.fn();
    renderPanel(makeItem(), { onViewQueue });
    expect(await screen.findByText('Recent failed posts')).toBeTruthy();
    expect(screen.getByText('Failed reel one')).toBeTruthy();
    expect(screen.getByText('No caption')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'View all failed posts' })
    );
    expect(onViewQueue).toHaveBeenCalledTimes(1);
  });

  it('hides the failed section entirely when nothing failed', async () => {
    installQueueFetch({ queued: [], failed: [] });
    renderPanel(makeItem());
    await screen.findByText(
      'Nothing is queued yet. Create a post to fill this schedule.'
    );
    expect(screen.queryByText('Recent failed posts')).toBeNull();
  });
});

describe('InsightsPanel behaviour', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('states plainly that Instagram insights are not connected yet, and shows posted/failed counts', async () => {
    installQueueFetch({ published: [] });
    render(
      withQueryClient(<InsightsPanel subdomain="acme" item={makeItem()} />)
    );
    const panel = screen.getByTestId('instagram-schedule-insights-panel');
    expect(panel.textContent).toContain(
      'Instagram insights are not connected yet'
    );
    const bigNumbers = Array.from(
      panel.querySelectorAll('p.text-xxl')
    ).map((p) => p.textContent);
    expect(bigNumbers).toEqual(['12', '2']);
    expect(
      await screen.findByText(
        'Nothing has been posted from this schedule yet.'
      )
    ).toBeTruthy();
  });

  it('lists posted posts with their Instagram post IDs', async () => {
    installQueueFetch({
      published: [
        makeQueueItem({
          caption: 'Launch day reel',
          status: 'published',
          fbPostId: 'ig_123456',
          publishedAt: '2026-10-20T09:00:00.000Z',
        }),
        makeQueueItem({
          caption: 'Second post',
          status: 'published',
          fbPostId: 'ig_789012',
          publishedAt: '2026-10-21T09:00:00.000Z',
        }),
      ],
    });
    render(
      withQueryClient(<InsightsPanel subdomain="acme" item={makeItem()} />)
    );
    expect(await screen.findByText('Launch day reel')).toBeTruthy();
    expect(screen.getByText('Second post')).toBeTruthy();
    expect(screen.getByText(/Instagram post ig_123456/)).toBeTruthy();
    expect(screen.getByText(/Instagram post ig_789012/)).toBeTruthy();
    expect(
      screen.queryByText('Nothing has been posted from this schedule yet.')
    ).toBeNull();
  });

  it('shows "No caption" for a posted post without a caption, and no Instagram ID suffix when there is none', async () => {
    installQueueFetch({
      published: [
        makeQueueItem({
          caption: '',
          status: 'published',
          fbPostId: null,
          publishedAt: '2026-10-20T09:00:00.000Z',
        }),
      ],
    });
    render(
      withQueryClient(<InsightsPanel subdomain="acme" item={makeItem()} />)
    );
    expect(await screen.findByText('No caption')).toBeTruthy();
    expect(screen.queryByText(/Instagram post /)).toBeNull();
  });
});

describe('CalendarPanel behaviour', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function dayButtons() {
    return document.querySelectorAll(
      '[data-testid^="instagram-schedule-calendar-day-"]'
    );
  }

  it('renders the current month grid with one button per day and weekday headers', async () => {
    installQueueFetch({ calendar: [] });
    const { label, daysInMonth, dayKey } = currentMonth();
    render(
      withQueryClient(
        <CalendarPanel
          subdomain="acme"
          destinationId={DESTINATION_ID}
          timezone="Asia/Karachi"
        />
      )
    );
    expect(await screen.findByText(label)).toBeTruthy();
    // The month label renders while the query is still pending; wait
    // for the grid itself before asserting on its headers and size.
    await screen.findByTestId(`instagram-schedule-calendar-day-${dayKey(1)}`);
    for (const header of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      expect(screen.getByText(header)).toBeTruthy();
    }
    expect(dayButtons().length).toBe(daysInMonth);
  });

  it('shows per-day post counts and lists the selected day with status', async () => {
    const { dayKey, noonUtc } = currentMonth();
    installQueueFetch({
      calendar: [
        makeQueueItem({
          caption: 'Day ten reel',
          status: 'queued',
          scheduledTime: noonUtc(10),
        }),
        makeQueueItem({
          caption: 'Day ten second post',
          status: 'queued',
          scheduledTime: noonUtc(10),
        }),
        makeQueueItem({
          caption: 'Day fifteen post',
          status: 'published',
          scheduledTime: noonUtc(15),
        }),
      ],
    });
    render(
      withQueryClient(
        <CalendarPanel
          subdomain="acme"
          destinationId={DESTINATION_ID}
          timezone="Asia/Karachi"
        />
      )
    );
    const dayTen = await screen.findByTestId(
      `instagram-schedule-calendar-day-${dayKey(10)}`
    );
    expect(dayTen.textContent).toContain('2 posts');
    const dayFifteen = screen.getByTestId(
      `instagram-schedule-calendar-day-${dayKey(15)}`
    );
    expect(dayFifteen.textContent).toContain('1 post');

    fireEvent.click(dayTen);
    expect(screen.getByText(dayKey(10))).toBeTruthy();
    expect(screen.getByText('Day ten reel')).toBeTruthy();
    expect(screen.getByText('Day ten second post')).toBeTruthy();
    expect(screen.queryByText('Day fifteen post')).toBeNull();
    // The selected day's posts carry their queue status as a mark.
    expect(screen.getAllByText('queued').length).toBe(2);

    // Clicking the selected day again deselects it.
    fireEvent.click(dayTen);
    expect(screen.queryByText('Day ten reel')).toBeNull();
  });

  it('shows "No posts on this day" for an empty selected day', async () => {
    const { dayKey } = currentMonth();
    installQueueFetch({ calendar: [] });
    render(
      withQueryClient(
        <CalendarPanel
          subdomain="acme"
          destinationId={DESTINATION_ID}
          timezone="Asia/Karachi"
        />
      )
    );
    fireEvent.click(
      await screen.findByTestId(`instagram-schedule-calendar-day-${dayKey(12)}`)
    );
    expect(screen.getByText(dayKey(12))).toBeTruthy();
    expect(screen.getByText('No posts on this day.')).toBeTruthy();
  });

  it('ignores posts without a scheduled time when grouping by day', async () => {
    const { dayKey, noonUtc } = currentMonth();
    installQueueFetch({
      calendar: [
        makeQueueItem({
          caption: 'Timed post',
          status: 'queued',
          scheduledTime: noonUtc(10),
        }),
        makeQueueItem({
          caption: 'Timeless post',
          status: 'queued',
          scheduledTime: null,
        }),
      ],
    });
    render(
      withQueryClient(
        <CalendarPanel
          subdomain="acme"
          destinationId={DESTINATION_ID}
          timezone="Asia/Karachi"
        />
      )
    );
    fireEvent.click(
      await screen.findByTestId(`instagram-schedule-calendar-day-${dayKey(10)}`)
    );
    expect(screen.getByText('Timed post')).toBeTruthy();
    expect(screen.queryByText('Timeless post')).toBeNull();
    fireEvent.click(
      screen.getByTestId(`instagram-schedule-calendar-day-${dayKey(12)}`)
    );
    expect(screen.getByText('No posts on this day.')).toBeTruthy();
  });

  it('moves to the next month and back, clearing the selection', async () => {
    const { label, nextLabel, nextDays, dayKey } = currentMonth();
    installQueueFetch({ calendar: [] });
    render(
      withQueryClient(
        <CalendarPanel
          subdomain="acme"
          destinationId={DESTINATION_ID}
          timezone="Asia/Karachi"
        />
      )
    );
    fireEvent.click(
      await screen.findByTestId(`instagram-schedule-calendar-day-${dayKey(5)}`)
    );
    expect(screen.getByText('No posts on this day.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(await screen.findByText(nextLabel)).toBeTruthy();
    // The new month's query refetches, so the grid reappears async.
    await waitFor(() => expect(dayButtons().length).toBe(nextDays));
    // Shifting month clears the selected-day list.
    expect(screen.queryByText('No posts on this day.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(await screen.findByText(label)).toBeTruthy();
    await waitFor(() =>
      expect(dayButtons().length).toBe(currentMonth().daysInMonth)
    );
  });

  it('shows the load error instead of the grid when the queue fetch fails', async () => {
    const original = global.fetch;
    global.fetch = (async () =>
      jsonResponse({ error: 'boom' }, 500)) as unknown as typeof fetch;
    try {
      render(
        withQueryClient(
          <CalendarPanel
            subdomain="acme"
            destinationId={DESTINATION_ID}
            timezone="Asia/Karachi"
          />
        )
      );
      expect(
        await screen.findByText(/Couldn't load the calendar/)
      ).toBeTruthy();
      expect(dayButtons().length).toBe(0);
    } finally {
      global.fetch = original;
    }
  });
});
