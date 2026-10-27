import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  PageTabQueue,
  QUEUE_REORDER_NOOP_MESSAGE,
  QUEUE_REORDER_SUCCESS_MESSAGE,
} from './content-tab';
import {
  contentChecklistDismissedPreference,
  getPreference,
  removePreference,
} from '@/lib/storage/preferences';
import { toast } from '@/components/shared/ui/toast';
import type { FacebookPageItem } from '../../page-card';

vi.mock('next/navigation', () => ({
  useParams: () => ({ subdomain: 'acme' }),
}));

vi.mock('@/components/shared/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  Toast: () => null,
  Toaster: () => null,
}));

vi.mock('../bulk/bulk-add-modal', () => ({
  BulkAddModal: () => <div data-testid="bulk-add-stub" />,
}));

vi.mock('../composer/posting-time-quick-add', () => ({
  PostingTimeQuickAdd: () => <div data-testid="posting-time-quick-add" />,
}));

const PAGE_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const ID_A = '00000000-0000-4000-8000-000000000001';
const ID_B = '00000000-0000-4000-8000-000000000002';
const ID_F = '00000000-0000-4000-8000-000000000003';

const PAGE: FacebookPageItem = {
  id: PAGE_ID,
  facebookAccountId: ACCOUNT_ID,
  accountDisplayName: 'Acme Account',
  fbPageId: '100000000000001',
  pageName: 'Acme Page',
  category: 'Business Page',
  startingFollowers: 0,
  currentFollowers: 10,
  followersGained: 10,
  status: 'active',
  timezone: 'UTC',
  createdAt: '2026-10-01T00:00:00.000Z',
} as FacebookPageItem;

function queueItem(overrides: Record<string, unknown> = {}) {
  return {
    id: ID_A,
    userId: '11111111-1111-4111-8111-111111111111',
    pageId: PAGE_ID,
    slotId: null,
    mediaId: null,
    postFormat: 'text',
    linkUrl: null,
    caption: 'First post',
    firstComment: null,
    scheduledTime: '2026-12-01T09:00:00.000Z',
    status: 'queued',
    retryCount: 0,
    maxRetries: 3,
    fbPostId: null,
    fbCommentId: null,
    publishedAt: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    media: null,
    ...overrides,
  };
}

const SLOTS = {
  slots: ['09:00', '10:00', '11:00'].map((slotTime, i) => ({
    id: `00000000-0000-4000-8000-00000000010${i}`,
    userId: '11111111-1111-4111-8111-111111111111',
    pageId: PAGE_ID,
    slotTime,
    timezone: 'UTC',
    isActive: true,
    allowedFormats: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  })),
  total: 3,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchLog {
  patches: Array<{ id: string; body: Record<string, unknown> }>;
  deletes: string[];
  posts: Array<Record<string, unknown>>;
}

function makeFetch(items: Array<Record<string, unknown>>, accountStatus = 'active') {
  const log: FetchLog = { patches: [], deletes: [], posts: [] };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/publishing/queue') && method === 'PATCH') {
      const id = url.split('/publishing/queue/')[1] ?? '';
      log.patches.push({ id, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return jsonResponse({});
    }
    if (url.includes('/publishing/queue') && method === 'DELETE') {
      log.deletes.push(url.split('/publishing/queue/')[1] ?? '');
      return jsonResponse({ success: true });
    }
    if (url.includes('/publishing/queue') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      log.posts.push(body);
      return jsonResponse(queueItem({ id: ID_F, caption: body.caption, scheduledTime: body.scheduledTime }), 201);
    }
    if (url.includes('/publishing/queue')) {
      return jsonResponse({ items, total: items.length, limit: 50, offset: 0 });
    }
    if (url.includes('/slots')) return jsonResponse(SLOTS);
    if (url.includes('/accounts')) {
      return jsonResponse({
        accounts: [
          {
            id: ACCOUNT_ID,
            fbAccountId: '100000000000099',
            displayName: 'Acme Account',
            status: accountStatus,
            connectedPagesCount: 1,
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
        total: 1,
      });
    }
    return jsonResponse({});
  });
  return { fetchMock, log };
}

function renderPanel(items: Array<Record<string, unknown>>, accountStatus = 'active') {
  const { fetchMock, log } = makeFetch(items, accountStatus);
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: 0 } },
  });
  // Spec 131 PR-131-3 (props bridge deleted): the panel takes no item
  // props — it reads the shared queue cache key, which the fetch mock
  // below answers exactly as the route's server prefetch would seed it.
  const props = {
    page: PAGE,
    isLoading: false,
  };
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <PageTabQueue {...props} />
    </QueryClientProvider>
  );
  return { ...utils, props, log, queryClient };
}

const itemA = () => queueItem();
const itemB = () =>
  queueItem({ id: ID_B, caption: 'Second post', scheduledTime: '2026-12-01T10:00:00.000Z' });
const failedItem = () =>
  queueItem({
    id: ID_F,
    caption: 'Failed post',
    scheduledTime: '2026-11-01T11:00:00.000Z',
    status: 'failed',
  });

describe('PageTabQueue — rebuilt panel (spec 134 PR-134-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removePreference(contentChecklistDismissedPreference(PAGE_ID));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders rows from the cache with timezone-labelled times and status text', async () => {
    renderPanel([itemA(), itemB()]);
    expect(await screen.findByText('First post')).toBeVisible();
    expect(screen.getByText('Second post')).toBeVisible();
    expect(screen.getByTestId('queue-summary').textContent).toContain('2 posts queued');
    // Timezone is data, shown beside the time (UI Rule 6 / spec 112).
    expect(screen.getAllByText(/UTC/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Queued').length).toBeGreaterThan(0);
  });

  it('Move down reorders optimistically, PATCHes both items, and toasts the spec-112 success string', async () => {
    const user = userEvent.setup();
    const { log } = renderPanel([itemA(), itemB()]);
    await screen.findByText('First post');
    const rowA = screen.getByTestId(`queue-row-${ID_A}`);
    await user.click(within(rowA).getByRole('button', { name: /Move down post for Acme Page/ }));
    await waitFor(() => expect(log.patches).toHaveLength(2));
    expect(log.patches.map((p) => p.id).sort()).toEqual([ID_A, ID_B].sort());
    await waitFor(() =>
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(QUEUE_REORDER_SUCCESS_MESSAGE)
    );
  });

  it('keyboard reorder: Space lifts, ArrowDown moves, announcement carries position + new time', async () => {
    const user = userEvent.setup();
    const { log } = renderPanel([itemA(), itemB()]);
    await screen.findByText('First post');
    const handle = screen.getByTestId(`queue-drag-handle-${ID_A}`);
    handle.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(log.patches).toHaveLength(2));
    const live = screen.getByTestId('queue-reorder-announcer');
    expect(live.textContent).toContain('position 2 of 2');
    await user.keyboard(' ');
    expect(live.textContent).toContain('Dropped');
  });

  it('§3.1.1 fix: a no-op reorder attempt acknowledges visibly (no silent return)', async () => {
    const user = userEvent.setup();
    renderPanel([itemA(), itemB()]);
    await screen.findByText('First post');
    // Edge Move controls are disabled-with-reason, not silent no-ops.
    const rowA2 = screen.getByTestId(`queue-row-${ID_A}`);
    const moveUp = within(rowA2).getByRole('button', { name: /Move up post for Acme Page/ });
    expect(moveUp).toBeDisabled();
    expect(moveUp).toHaveAttribute(
      'data-disabled-reason',
      'This post is already at the top of the queue.'
    );
    // Keyboard attempt at the edge reaches applyReorder and acks visibly.
    const handle = screen.getByTestId(`queue-drag-handle-${ID_A}`);
    handle.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowUp}');
    await waitFor(() =>
      expect(vi.mocked(toast.info)).toHaveBeenCalledWith(QUEUE_REORDER_NOOP_MESSAGE)
    );
    expect(screen.getByTestId('queue-reorder-announcer').textContent).toContain(
      QUEUE_REORDER_NOOP_MESSAGE
    );
  });

  it('drop on the same row is a no-op that acknowledges visibly', async () => {
    renderPanel([itemA(), itemB()]);
    await screen.findByText('First post');
    const handle = screen.getByTestId(`queue-drag-handle-${ID_A}`);
    fireEvent.dragStart(handle);
    fireEvent.drop(screen.getByTestId(`queue-row-${ID_A}`));
    await waitFor(() =>
      expect(vi.mocked(toast.info)).toHaveBeenCalledWith(QUEUE_REORDER_NOOP_MESSAGE)
    );
  });

  it('failed post: Retry is disabled with its reason when the connection expired', async () => {
    renderPanel([failedItem()], 'expired');
    expect(await screen.findByText('Failed post')).toBeVisible();
    const retry = await screen.findByRole('button', { name: /Retry post for Acme Page/ });
    expect(retry).toBeDisabled();
    expect(screen.getAllByText('Reconnect your Facebook account to retry.').length).toBeGreaterThan(0);
    expect(screen.getByTestId('queue-failed-banner').textContent).toContain(
      '1 post failed to publish.'
    );
    // Plain-language reason, never a raw error (§3.5).
    expect(screen.getByText(/Your Facebook connection expired/)).toBeVisible();
  });

  it('failed post: Retry requeues at the next covering slot and states the new time', async () => {
    const user = userEvent.setup();
    const { log } = renderPanel([failedItem()], 'active');
    await screen.findByText('Failed post');
    const retry = await screen.findByRole('button', { name: /Retry post for Acme Page/ });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);
    await waitFor(() => expect(log.patches).toHaveLength(1));
    expect(log.patches[0]?.body).toMatchObject({ status: 'queued' });
    await waitFor(() =>
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(expect.stringContaining('Retrying'))
    );
  });

  it('batch bar states the count and bulk delete confirms via AlertDialog', async () => {
    const user = userEvent.setup();
    const { log } = renderPanel([itemA(), itemB()]);
    await screen.findByText('First post');
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('checkbox', { name: /Select post: First post/ }));
    expect(screen.getByText('1 selected')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Delete (1)' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Delete 1 post\?/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Delete posts' }));
    await waitFor(() => expect(log.deletes).toEqual([ID_A]));
    await waitFor(() =>
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith('1 post deleted.')
    );
  });

  it('single delete is immediate with an 8-second Undo toast; Undo restores via re-create', async () => {
    const user = userEvent.setup();
    const { log } = renderPanel([itemA(), itemB()]);
    await screen.findByText('First post');
    const rowA = screen.getByTestId(`queue-row-${ID_A}`);
    await user.click(within(rowA).getByRole('button', { name: /Delete post for Acme Page/ }));
    await waitFor(() => expect(log.deletes).toEqual([ID_A]));
    const successCalls = vi.mocked(toast.success).mock.calls;
    const undoCall = successCalls.find((c) => c[0] === 'Post deleted.');
    expect(undoCall).toBeTruthy();
    const options = undoCall?.[1] as { duration?: number; action?: { label: string; onClick: () => void } };
    expect(options.duration).toBe(8000);
    expect(options.action?.label).toBe('Undo');
    options.action?.onClick();
    await waitFor(() => expect(log.posts).toHaveLength(1));
    expect(log.posts[0]).toMatchObject({ caption: 'First post', pageId: PAGE_ID });
  });

  it('empty queue: first-use checklist + typed empty state; dismissal persists via the typed helper', async () => {
    const user = userEvent.setup();
    renderPanel([]);
    expect(await screen.findByText('Nothing here yet.')).toBeVisible();
    expect(screen.getByText('Get your queue running')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Get your queue running')).toBeNull();
    expect(getPreference(contentChecklistDismissedPreference(PAGE_ID))).toBe(true);
  });

  it('filter with no matches echoes the filter and Clear filters restores the list', async () => {
    const user = userEvent.setup();
    renderPanel([itemA(), itemB()]);
    await screen.findByText('First post');
    await user.click(screen.getByTestId('queue-filter-failed'));
    expect(await screen.findByText('Nothing here.')).toBeVisible();
    expect(screen.getByText(/Active filters: Failed/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('First post')).toBeVisible();
  });

  it('Reschedule saves a new time through the typed client', async () => {
    const user = userEvent.setup();
    const { log } = renderPanel([itemA(), itemB()]);
    await screen.findByText('First post');
    const rowA = screen.getByTestId(`queue-row-${ID_A}`);
    await user.click(within(rowA).getByRole('button', { name: /Reschedule post for Acme Page/ }));
    const input = await screen.findByTestId('queue-reschedule-input');
    fireEvent.change(input, { target: { value: '2026-12-05T09:00' } });
    await user.click(screen.getByRole('button', { name: 'Save new time' }));
    await waitFor(() => expect(log.patches).toHaveLength(1));
    expect(log.patches[0]?.id).toBe(ID_A);
    expect(String(log.patches[0]?.body.scheduledTime)).toContain('2026-12-05');
  });
});
