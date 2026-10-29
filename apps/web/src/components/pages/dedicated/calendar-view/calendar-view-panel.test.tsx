/**
 * Calendar View panel: posts on the right days per status, filter
 * chips, month navigation, today highlight, and the shared edit
 * dialogue — against the mocked API client, mirroring the queue
 * panel test harness. The clock is frozen (fake timers advancing in
 * real time) so derived estimate days are deterministic: with one
 * daily 09:00 slot, the first queued post estimates the next day
 * and the second the day after.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { toast } from '@/components/shared/ui/toast';
import type { ApiFetchOptions } from '@/lib/api';
import { CalendarViewPanel } from './calendar-view-panel';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ID_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PAGE_ID = '22222222-2222-4222-a222-222222222222';

const item = (overrides: Record<string, unknown>) => ({
  id: ID_A,
  userId: '11111111-1111-4111-a111-111111111111',
  pageId: PAGE_ID,
  slotId: null,
  mediaId: null,
  postFormat: 'text',
  scheduledTime: null,
  caption: 'Seed caption',
  firstComment: null,
  status: 'queued',
  retryCount: 0,
  maxRetries: 3,
  fbPostId: null,
  fbCommentId: null,
  publishedAt: null,
  createdAt: '2026-10-28T07:00:00.000Z',
  updatedAt: '2026-10-28T07:00:00.000Z',
  media: null,
  ...overrides,
});

let seed: Array<ReturnType<typeof item>> = [];

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));
const apiGet = apiMocks.get;
const apiPatch = apiMocks.patch;

vi.mock('@/lib/api', () => ({
  api: apiMocks,
  buildTenantApiPath: (subdomain: string, path: string) => `/api/tenant/${subdomain}${path}`,
  isApiError: () => false,
}));

vi.mock('@/components/shared/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const allFormatsSlot = {
  id: 'slot-1',
  slotTime: '09:00',
  timezone: 'UTC',
  isActive: true,
  allowedFormats: null as string[] | null,
};

function renderPanel(overrides: Record<string, unknown> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <CalendarViewPanel
      subdomain="acme"
      pageId={PAGE_ID}
      pageTimezone={(overrides.pageTimezone as string | undefined) ?? 'UTC'}
      slots={(overrides.slots as typeof allFormatsSlot[] | undefined) ?? [allFormatsSlot]}
    />,
    { wrapper }
  );
}

function defaultSeed() {
  seed = [
    item({ id: ID_A, caption: 'First queued post', postFormat: 'text', status: 'queued' }),
    item({ id: ID_B, caption: 'Second queued post', postFormat: 'image', status: 'queued' }),
    item({
      id: ID_C,
      caption: 'Failed post',
      postFormat: 'text',
      status: 'failed',
      retryCount: 1,
      updatedAt: '2026-10-28T15:30:00.000Z',
    }),
    item({
      id: ID_D,
      caption: 'Published post',
      postFormat: 'text',
      status: 'published',
      publishedAt: '2026-10-27T09:00:00.000Z',
    }),
  ];
}

describe('CalendarViewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultSeed();
    // Frozen at Thu 29 Oct 2026, noon UTC; advancing in real time so
    // testing-library's waits keep working.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-29T12:00:00.000Z'));
    apiGet.mockImplementation(async (_path: string, options: ApiFetchOptions) => {
      const q = options.query ?? {};
      let items = [...seed];
      if (q.status) items = items.filter((row) => row.status === q.status);
      const offset = typeof q.offset === 'number' ? q.offset : 0;
      const limit = typeof q.limit === 'number' ? q.limit : 50;
      const page = items.slice(offset, offset + limit);
      return {
        items: page,
        total: items.length,
        limit,
        offset,
        queuedCount: seed.filter((row) => row.status === 'queued').length,
        publishedCount: seed.filter((row) => row.status === 'published').length,
        failedCount: seed.filter((row) => row.status === 'failed').length,
        cancelledCount: 0,
        skippedCount: 0,
      };
    });
    apiPatch.mockImplementation(async (_path: string, body: unknown) => ({
      ...(seed[0] as object),
      ...(body as object),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('places queued posts on estimate days, published on published days, failed on last-update days', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('calendar-view-panel')).toBeTruthy());
    // One daily 09:00 slot, clock at noon: first queued → Fri 30 Oct,
    // second queued → Sat 31 Oct (one post per slot per day).
    const day30 = within(screen.getByTestId('calendar-day-2026-10-30'));
    expect(day30.getByTestId(`calendar-entry-${ID_A}`)).toBeTruthy();
    expect(day30.getByText('First queued post')).toBeTruthy();
    const day31 = within(screen.getByTestId('calendar-day-2026-10-31'));
    expect(day31.getByTestId(`calendar-entry-${ID_B}`)).toBeTruthy();
    // Published on its published day, failed on its last-update day.
    const day27 = within(screen.getByTestId('calendar-day-2026-10-27'));
    expect(day27.getByTestId(`calendar-entry-${ID_D}`)).toBeTruthy();
    const day28 = within(screen.getByTestId('calendar-day-2026-10-28'));
    expect(day28.getByTestId(`calendar-entry-${ID_C}`)).toBeTruthy();
  });

  it('shows the current month with today highlighted, and navigates months', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('calendar-month-label')).toBeTruthy());
    expect(screen.getByTestId('calendar-month-label').textContent).toBe('October 2026');
    const todayCell = screen.getByTestId('calendar-day-2026-10-29');
    expect(todayCell.className).toContain('ring-link/20');
    await user.click(screen.getByTestId('calendar-next-btn'));
    expect(screen.getByTestId('calendar-month-label').textContent).toBe('November 2026');
    await user.click(screen.getByTestId('calendar-today-btn'));
    expect(screen.getByTestId('calendar-month-label').textContent).toBe('October 2026');
    await user.click(screen.getByTestId('calendar-prev-btn'));
    expect(screen.getByTestId('calendar-month-label').textContent).toBe('September 2026');
  });

  it('filter chips filter the calendar', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-entry-${ID_A}`)).toBeTruthy()
    );
    await user.click(screen.getByTestId('calendar-filter-failed'));
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-entry-${ID_C}`)).toBeTruthy()
    );
    expect(screen.queryByTestId(`calendar-entry-${ID_A}`)).toBeNull();
    expect(screen.queryByTestId(`calendar-entry-${ID_D}`)).toBeNull();
    await user.click(screen.getByTestId('calendar-filter-all'));
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-entry-${ID_A}`)).toBeTruthy()
    );
  });

  it('clicking a post opens the shared edit dialogue and saves the caption', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-entry-${ID_A}`)).toBeTruthy()
    );
    await user.click(screen.getByTestId(`calendar-entry-${ID_A}`));
    const dialog = await screen.findByTestId('queue-edit-dialog');
    const caption = within(dialog).getByTestId('queue-edit-caption') as HTMLTextAreaElement;
    expect(caption.value).toBe('First queued post');
    await user.clear(caption);
    await user.type(caption, 'Edited from calendar');
    await user.click(within(dialog).getByTestId('queue-edit-save-btn'));
    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    expect(apiPatch).toHaveBeenCalledWith(
      expect.stringContaining(`/publishing/queue/${ID_A}`),
      expect.objectContaining({ caption: 'Edited from calendar' }),
      expect.anything()
    );
    expect(toast.success).toHaveBeenCalledWith('Caption updated.');
  });

  it('published entries are not clickable for edit', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-entry-${ID_D}`)).toBeTruthy()
    );
    await user.click(screen.getByTestId(`calendar-entry-${ID_D}`));
    expect(screen.queryByTestId('queue-edit-dialog')).toBeNull();
  });

  it('reports queued posts with no estimate instead of dropping them', async () => {
    renderPanel({
      slots: [
        {
          id: 'slot-1',
          slotTime: '09:00',
          timezone: 'UTC',
          isActive: true,
          allowedFormats: ['image'],
        },
      ],
    });
    await waitFor(() =>
      expect(screen.getByTestId('calendar-unscheduled-note')).toBeTruthy()
    );
    // The text post has no matching slot, so no estimate and no cell;
    // the image post keeps its estimate day.
    expect(screen.queryByTestId(`calendar-entry-${ID_A}`)).toBeNull();
    expect(screen.getByTestId(`calendar-entry-${ID_B}`)).toBeTruthy();
    expect(screen.getByTestId('calendar-unscheduled-note').textContent).toMatch(/1 queued post/);
  });

  it('notes when the fetched set is capped at 100', async () => {
    apiGet.mockImplementation(async () => ({
      items: seed,
      total: 150,
      limit: 100,
      offset: 0,
      queuedCount: 120,
      publishedCount: 20,
      failedCount: 10,
      cancelledCount: 0,
      skippedCount: 0,
    }));
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId('calendar-capped-note')).toBeTruthy()
    );
  });

  it('keeps the overflow-safe grid structure at narrow widths', async () => {
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-entry-${ID_A}`)).toBeTruthy()
    );
    // Seven columns, cells that shrink instead of pushing the grid
    // off-screen, truncated captions, and internally scrolling day
    // cells — the same guards the E2E overflow check measures live.
    const dayCell = screen.getByTestId('calendar-day-2026-10-30');
    expect(dayCell.className).toContain('min-w-0');
    const entry = screen.getByTestId(`calendar-entry-${ID_A}`);
    expect(entry.className).toContain('min-w-0');
    const caption = within(entry).getByText('First queued post');
    expect(caption.className).toContain('truncate');
    const entriesArea = dayCell.querySelector('.overflow-y-auto');
    expect(entriesArea).not.toBeNull();
  });

  it('renders a clean empty state with no posts and no stale entries', async () => {
    seed = [];
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId('calendar-empty-state')).toBeTruthy()
    );
    expect(screen.getByTestId('calendar-empty-state').textContent).toMatch(/No posts yet/);
    expect(screen.queryByTestId('calendar-day-2026-10-29')).toBeNull();
    expect(screen.queryByTestId(`calendar-entry-${ID_A}`)).toBeNull();
  });

  it('queued and published filter chips show exactly that status', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-entry-${ID_A}`)).toBeTruthy()
    );
    await user.click(screen.getByTestId('calendar-filter-queued'));
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-entry-${ID_B}`)).toBeTruthy()
    );
    expect(screen.queryByTestId(`calendar-entry-${ID_C}`)).toBeNull();
    expect(screen.queryByTestId(`calendar-entry-${ID_D}`)).toBeNull();
    await user.click(screen.getByTestId('calendar-filter-published'));
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-entry-${ID_D}`)).toBeTruthy()
    );
    expect(screen.queryByTestId(`calendar-entry-${ID_A}`)).toBeNull();
    expect(screen.queryByTestId(`calendar-entry-${ID_C}`)).toBeNull();
  });

  it('clicking a failed post opens the shared edit dialogue and saves', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-entry-${ID_C}`)).toBeTruthy()
    );
    await user.click(screen.getByTestId(`calendar-entry-${ID_C}`));
    const dialog = await screen.findByTestId('queue-edit-dialog');
    const caption = within(dialog).getByTestId('queue-edit-caption') as HTMLTextAreaElement;
    expect(caption.value).toBe('Failed post');
    await user.clear(caption);
    await user.type(caption, 'Failed post fixed');
    await user.click(within(dialog).getByTestId('queue-edit-save-btn'));
    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    expect(apiPatch).toHaveBeenCalledWith(
      expect.stringContaining(`/publishing/queue/${ID_C}`),
      expect.objectContaining({ caption: 'Failed post fixed' }),
      expect.anything()
    );
  });

  it('today highlight follows the page timezone, not UTC', async () => {
    // 01:00 UTC on 29 Oct is still 28 Oct in Chicago.
    vi.setSystemTime(new Date('2026-10-29T01:00:00.000Z'));
    renderPanel({ pageTimezone: 'America/Chicago' });
    await waitFor(() =>
      expect(screen.getByTestId('calendar-month-label')).toBeTruthy()
    );
    expect(screen.getByTestId('calendar-month-label').textContent).toBe('October 2026');
    expect(screen.getByTestId('calendar-day-2026-10-28').className).toContain(
      'ring-link/20'
    );
    expect(screen.getByTestId('calendar-day-2026-10-29').className).not.toContain(
      'ring-link/20'
    );
  });

  it('a crowded day cell shows every post and scrolls internally', async () => {
    seed = Array.from({ length: 8 }, (_, i) =>
      item({
        id: `eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee${i}`,
        caption: `Crowded post ${i + 1}`,
        postFormat: 'text',
        status: 'failed',
        updatedAt: '2026-10-28T15:30:00.000Z',
      })
    );
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId('calendar-day-2026-10-28')).toBeTruthy()
    );
    const dayCell = screen.getByTestId('calendar-day-2026-10-28');
    expect(within(dayCell).getAllByTestId(/^calendar-entry-/)).toHaveLength(8);
    expect(dayCell.querySelector('.overflow-y-auto')).not.toBeNull();
  });

  it('month-boundary posts stay in their month across year-rollover navigation', async () => {
    const user = userEvent.setup();
    seed = [
      item({
        id: ID_A,
        caption: 'First of October',
        postFormat: 'text',
        status: 'published',
        publishedAt: '2026-10-01T09:00:00.000Z',
      }),
      item({
        id: ID_B,
        caption: 'Last of October',
        postFormat: 'text',
        status: 'published',
        publishedAt: '2026-10-31T09:00:00.000Z',
      }),
    ];
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId(`calendar-entry-${ID_A}`)).toBeTruthy()
    );
    expect(screen.getByTestId(`calendar-entry-${ID_B}`)).toBeTruthy();
    await user.click(screen.getByTestId('calendar-next-btn'));
    expect(screen.getByTestId('calendar-month-label').textContent).toBe('November 2026');
    await user.click(screen.getByTestId('calendar-next-btn'));
    expect(screen.getByTestId('calendar-month-label').textContent).toBe('December 2026');
    // Neither October post leaks into December's grid.
    expect(screen.queryByTestId(`calendar-entry-${ID_A}`)).toBeNull();
    expect(screen.queryByTestId(`calendar-entry-${ID_B}`)).toBeNull();
    await user.click(screen.getByTestId('calendar-next-btn'));
    expect(screen.getByTestId('calendar-month-label').textContent).toBe('January 2027');
    await user.click(screen.getByTestId('calendar-prev-btn'));
    expect(screen.getByTestId('calendar-month-label').textContent).toBe('December 2026');
  });
});
