/**
 * Queue panel (Queue section rebuild): rows, derived estimates,
 * unmatched flags, filter chips, and the five actions — against the
 * mocked API client, mirroring the posting-times shell test harness.
 * The estimate algorithm itself is covered by the contracts tests;
 * these tests prove the panel wires the derived map to the right rows.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { toast } from '@/components/shared/ui/toast';
import type { ApiFetchOptions } from '@/lib/api';
import { QueuePanel } from './queue-panel';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ID_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PAGE_ID = '22222222-2222-4222-a222-222222222222';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
let mockQuery = '';

// vi.mock factories are hoisted: the fns must be created inside
// vi.hoisted, and their implementations (which read `seed`) are set
// per-test in beforeEach, after module evaluation.
const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));
const apiGet = apiMocks.get;
const apiPatch = apiMocks.patch;
const apiPost = apiMocks.post;
const apiDelete = apiMocks.delete;

vi.mock('@/lib/api', () => ({
  api: apiMocks,
  buildTenantApiPath: (subdomain: string, path: string) => `/api/tenant/${subdomain}${path}`,
  isApiError: () => false,
}));

vi.mock('@/components/shared/ui/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ subdomain: 'acme', pageId: PAGE_ID }),
  useSearchParams: () => ({
    get: (key: string) => new URLSearchParams(mockQuery).get(key),
    toString: () => mockQuery,
  }),
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
    <QueuePanel
      subdomain="acme"
      pageId={PAGE_ID}
      pageTimezone="UTC"
      pageStatus={overrides.pageStatus as 'active' | 'paused' | 'fb_rate_limited' | 'page_checkpoint' | 'invalid_token' | 'disconnected' | undefined}
      slots={(overrides.slots as typeof allFormatsSlot[] | undefined) ?? [allFormatsSlot]}
      onCreatePost={(overrides.onCreatePost as (() => void) | undefined) ?? vi.fn()}
    />,
    { wrapper }
  );
}

function defaultSeed() {
  seed = [
    item({ id: ID_A, caption: 'First queued post', postFormat: 'text', status: 'queued' }),
    item({
      id: ID_B,
      caption: 'Second queued post',
      postFormat: 'image',
      status: 'queued',
      media: {
        id: 'media-1',
        name: 'photo.jpg',
        mediaType: 'image',
        url: 'https://images.example.com/photo.jpg',
        thumbnailUrl: 'https://images.example.com/photo.jpg',
        aspectRatio: '1:1',
        durationSeconds: null,
      },
    }),
    item({
      id: ID_C,
      caption: 'Failed post',
      postFormat: 'text',
      status: 'failed',
      retryCount: 1,
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

describe('QueuePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery = '';
    defaultSeed();
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
    apiPatch.mockImplementation(async () => seed[0]);
    apiPost.mockImplementation(async () => ({}));
    apiDelete.mockImplementation(async () => ({ success: true, itemId: ID_A }));
    // Publish-now / retry mint crypto.randomUUID() per tap; jsdom may
    // not provide Web Crypto, so stub only when it is missing.
    if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
      vi.stubGlobal('crypto', {
        randomUUID: () => '99999999-9999-4999-8999-999999999999',
      });
    }
  });

  it('renders queued rows with derived estimates in queue order', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_A}`)).toBeTruthy());
    const rowA = within(screen.getByTestId(`queue-row-${ID_A}`));
    expect(rowA.getByText(/Est\./)).toBeTruthy();
    expect(rowA.getByText('First queued post')).toBeTruthy();
    // The list fetches 30 per page with no status filter on All.
    expect(apiGet).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ query: expect.objectContaining({ limit: 30, offset: 0 }) })
    );
  });

  it('flags a queued row whose format no active slot allows, with no estimate', async () => {
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
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_A}`)).toBeTruthy());
    const rowA = within(screen.getByTestId(`queue-row-${ID_A}`));
    expect(
      rowA.getByText('No posting time matches this post type yet — add one and it will get an estimate')
    ).toBeTruthy();
    expect(rowA.queryByText(/Est\./)).toBeNull();
    // The image row still has a matching slot, so it keeps an estimate.
    const rowB = within(screen.getByTestId(`queue-row-${ID_B}`));
    expect(rowB.getByText(/Est\./)).toBeTruthy();
  });

  it('disables edit and delete on published rows', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_D}`)).toBeTruthy());
    const row = within(screen.getByTestId(`queue-row-${ID_D}`));
    // Edit/Delete are visible buttons on the row, disabled — never removed.
    const edit = row.getByTestId('queue-row-edit') as HTMLButtonElement;
    const del = row.getByTestId('queue-row-delete') as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    expect(del.disabled).toBe(true);
    // Status and published time both say Published, so two matches is correct.
    expect(row.getAllByText(/Published/).length).toBeGreaterThan(0);
  });

  it('renders structured card rows: position, thumbnail/icon slot, estimate pill, visible Edit/Delete', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_A}`)).toBeTruthy());
    const rowA = within(screen.getByTestId(`queue-row-${ID_A}`));
    // Queued text row: position #1 in true queue order, caption at
    // readable size clamped to two lines, type tag, status, estimate pill.
    expect(rowA.getByTestId('queue-row-position').textContent).toContain('#1');
    const captionA = rowA.getByText('First queued post');
    expect(captionA.className).toContain('text-body');
    expect(captionA.className).toContain('line-clamp-2');
    expect(rowA.getByText('Text')).toBeTruthy();
    expect(rowA.getByText('Queued')).toBeTruthy();
    expect(rowA.getByTestId('queue-row-estimate').textContent).toMatch(/Est\./);
    // Text posts: the thumbnail slot holds a type icon, no image.
    expect(rowA.getByTestId('queue-row-thumbnail')).toBeTruthy();
    expect(rowA.queryByRole('img')).toBeNull();
    // Media rows: position #2, real thumbnail in the slot (cover, not
    // a full attachment preview), no video player in the row.
    const rowB = within(screen.getByTestId(`queue-row-${ID_B}`));
    expect(rowB.getByTestId('queue-row-position').textContent).toContain('#2');
    const thumbImg = rowB.getByRole('img');
    expect(thumbImg.className).toContain('object-cover');
    expect(rowB.queryByTestId('queue-row-media-preview')).toBeNull();
    expect(screen.getByTestId(`queue-row-${ID_B}`).querySelector('video')).toBeNull();
    // Structured card, not a flat divider row.
    expect(screen.getByTestId(`queue-row-${ID_A}`).className).toContain('bg-panel');
    expect(screen.getByTestId(`queue-row-${ID_A}`).className).toContain('rounded-lg');
  });

  it('renders a video thumbnail in the slot from the poster, never a player', async () => {
    seed = [
      item({
        id: ID_A,
        caption: '',
        postFormat: 'reel',
        status: 'queued',
        media: {
          id: 'media-2',
          name: 'clip.mp4',
          mediaType: 'video',
          url: 'https://images.example.com/clip.mp4',
          thumbnailUrl: 'https://images.example.com/clip-poster.jpg',
          aspectRatio: '9:16',
          durationSeconds: 30,
        },
      }),
    ];
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_A}`)).toBeTruthy());
    const rowA = within(screen.getByTestId(`queue-row-${ID_A}`));
    const thumb = rowA.getByTestId('queue-row-thumbnail');
    const img = within(thumb).getByRole('img');
    expect(img.getAttribute('src')).toContain('clip-poster.jpg');
    expect(screen.getByTestId(`queue-row-${ID_A}`).querySelector('video')).toBeNull();
    // Empty caption renders as an italic placeholder, not a blank middle.
    expect(rowA.getByText('No caption')).toBeTruthy();
  });

  it('shows Edit and Delete as visible buttons on the row', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_A}`)).toBeTruthy());
    const row = within(screen.getByTestId(`queue-row-${ID_A}`));
    expect(row.getByTestId('queue-row-edit')).toBeTruthy();
    expect(row.getByTestId('queue-row-delete')).toBeTruthy();
    expect(row.queryByTestId('queue-row-menu')).toBeNull();
  });

  it('disables Publish Now and Retry with a plain reason on a paused page', async () => {
    renderPanel({ pageStatus: 'paused' });
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_A}`)).toBeTruthy());
    expect(screen.getByTestId('queue-publish-blocked-note').textContent).toContain('Paused');
    const queuedRow = within(screen.getByTestId(`queue-row-${ID_A}`));
    const publishBtn = queuedRow.getByTestId('queue-row-publish-now') as HTMLButtonElement;
    expect(publishBtn.disabled).toBe(true);
    expect(publishBtn.getAttribute('title')).toContain('Paused');
    const failedRow = within(screen.getByTestId(`queue-row-${ID_C}`));
    const retryBtn = failedRow.getByTestId('queue-row-retry') as HTMLButtonElement;
    expect(retryBtn.disabled).toBe(true);
    expect(retryBtn.getAttribute('title')).toContain('Paused');
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('shows Retry as the primary action on failed rows, no Publish now', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_C}`)).toBeTruthy());
    const row = within(screen.getByTestId(`queue-row-${ID_C}`));
    expect(row.getByTestId('queue-row-retry')).toBeTruthy();
    expect(row.queryByTestId('queue-row-publish-now')).toBeNull();
    expect(row.queryByTestId('queue-row-move-up')).toBeNull();
  });

  it('shows the retry count on failed rows and retries via the destination route', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_C}`)).toBeTruthy());
    const row = within(screen.getByTestId(`queue-row-${ID_C}`));
    expect(row.getByText(/Retry 1 of 3/)).toBeTruthy();
    await user.click(row.getByTestId('queue-row-retry'));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const call = apiPost.mock.calls.find((args) =>
      String(args[0]).includes(`/destinations/${PAGE_ID}/queue/${ID_C}/retry`)
    );
    expect(call).toBeDefined();
    const headers = (call![2] as ApiFetchOptions).headers ?? {};
    expect(UUID_RE.test(headers['Idempotency-Key'] ?? '')).toBe(true);
  });

  it('publishes now with a fresh idempotency key per tap', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_A}`)).toBeTruthy());
    const row = within(screen.getByTestId(`queue-row-${ID_A}`));
    await user.click(row.getByTestId('queue-row-publish-now'));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const call = apiPost.mock.calls.find((args) =>
      String(args[0]).includes(`/publishing/queue/${ID_A}/publish-now`)
    );
    expect(call).toBeDefined();
    const headers = (call![2] as ApiFetchOptions).headers ?? {};
    expect(UUID_RE.test(headers['Idempotency-Key'] ?? '')).toBe(true);
  });

  it('edits only the caption via PATCH', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_A}`)).toBeTruthy());
    const row = within(screen.getByTestId(`queue-row-${ID_A}`));
    await user.click(row.getByTestId('queue-row-edit'));
    const textarea = screen.getByTestId('queue-edit-caption') as HTMLTextAreaElement;
    expect(textarea.value).toBe('First queued post');
    await user.clear(textarea);
    await user.type(textarea, 'Edited caption');
    await user.click(screen.getByTestId('queue-edit-save-btn'));
    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    const call = apiPatch.mock.calls[0];
    expect(String(call[0])).toContain(`/publishing/queue/${ID_A}`);
    expect(call[1]).toEqual({ caption: 'Edited caption' });
  });

  it('deletes only after confirmation', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_C}`)).toBeTruthy());
    const row = within(screen.getByTestId(`queue-row-${ID_C}`));
    await user.click(row.getByTestId('queue-row-delete'));
    await user.click(screen.getByTestId('queue-delete-confirm-btn'));
    await waitFor(() => expect(apiDelete).toHaveBeenCalled());
    expect(String(apiDelete.mock.calls[0][0])).toContain(`/publishing/queue/${ID_C}`);
  });

  it('reorders with the full new queued order', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_A}`)).toBeTruthy());
    const row = within(screen.getByTestId(`queue-row-${ID_A}`));
    await user.click(row.getByTestId('queue-row-move-down'));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const call = apiPost.mock.calls.find((args) =>
      String(args[0]).includes('/publishing/queue/reorder')
    );
    expect(call).toBeDefined();
    expect(call![1]).toEqual({ pageId: PAGE_ID, itemIds: [ID_B, ID_A] });
  });

  it('moves the row immediately, before the reorder request resolves, with no success toast', async () => {
    const user = userEvent.setup();
    // Deferred reorder: the request stays in flight until the test
    // resolves it, so anything the UI does before that point is the
    // optimistic update, not the server round trip. The mock applies
    // the order to the seed like a real server would, so the refetch
    // after success converges on the same order.
    let resolveReorder: (() => void) | null = null;
    apiPost.mockImplementation(async (path: string, body: { itemIds?: unknown }) => {
      if (String(path).includes('/publishing/queue/reorder')) {
        const ids = body.itemIds as string[];
        const byId = new Map(seed.map((row) => [row.id, row]));
        seed = [
          ...ids.map((id) => byId.get(id)!).filter(Boolean),
          ...seed.filter((row) => !ids.includes(row.id)),
        ];
        return new Promise((resolve) => {
          resolveReorder = () => resolve({});
        });
      }
      return {};
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_A}`)).toBeTruthy());
    const panel = screen.getByTestId('queue-panel');
    const estimateBefore = within(screen.getByTestId(`queue-row-${ID_A}`))
      .getByTestId('queue-row-estimate').textContent;
    const estimateBBefore = within(screen.getByTestId(`queue-row-${ID_B}`))
      .getByTestId('queue-row-estimate').textContent;
    const rowA = within(screen.getByTestId(`queue-row-${ID_A}`));
    await user.click(rowA.getByTestId('queue-row-move-down'));
    // Still in flight — but the row has already moved, its position
    // and estimate have already followed, and the button is live.
    await waitFor(() =>
      expect(panel.querySelectorAll('ul > li').item(0).textContent).toContain('Second queued post')
    );
    expect(
      within(screen.getByTestId(`queue-row-${ID_A}`)).getByTestId('queue-row-position')
        .textContent
    ).toContain('#2');
    expect(
      within(screen.getByTestId(`queue-row-${ID_B}`)).getByTestId('queue-row-position')
        .textContent
    ).toContain('#1');
    expect(
      within(screen.getByTestId(`queue-row-${ID_A}`)).getByTestId('queue-row-estimate')
        .textContent
    ).toBe(estimateBBefore);
    expect(
      within(screen.getByTestId(`queue-row-${ID_B}`)).getByTestId('queue-row-estimate')
        .textContent
    ).toBe(estimateBefore);
    // Buttons stay live during the sync: A was first (up disabled)
    // and is now last, so its move-up is live and B's move-down is
    // live — nothing is stuck behind the in-flight request.
    expect(
      (
        within(screen.getByTestId(`queue-row-${ID_A}`)).getByTestId(
          'queue-row-move-up'
        ) as HTMLButtonElement
      ).disabled
    ).toBe(false);
    expect(
      (
        within(screen.getByTestId(`queue-row-${ID_B}`)).getByTestId(
          'queue-row-move-down'
        ) as HTMLButtonElement
      ).disabled
    ).toBe(false);
    expect(resolveReorder).not.toBeNull();
    resolveReorder!();
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    const call = apiPost.mock.calls.find((args) =>
      String(args[0]).includes('/publishing/queue/reorder')
    );
    expect(call![1]).toEqual({ pageId: PAGE_ID, itemIds: [ID_B, ID_A] });
    // Success stays silent: no per-click toast, and the order sticks
    // after the refetch converges on the server order.
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(panel.querySelectorAll('ul > li').item(0).textContent).toContain('Second queued post')
    );
  });

  it('applies rapid consecutive clicks in order, syncing only the newest order', async () => {
    const user = userEvent.setup();
    seed = [
      item({ id: ID_A, caption: 'First queued post', postFormat: 'text', status: 'queued' }),
      item({ id: ID_B, caption: 'Second queued post', postFormat: 'text', status: 'queued' }),
      item({ id: ID_C, caption: 'Third queued post', postFormat: 'text', status: 'queued' }),
    ];
    const deferred: Array<() => void> = [];
    apiPost.mockImplementation(async (path: string, body: { itemIds?: unknown }) => {
      if (String(path).includes('/publishing/queue/reorder')) {
        const ids = body.itemIds as string[];
        const byId = new Map(seed.map((row) => [row.id, row]));
        seed = [
          ...ids.map((id) => byId.get(id)!).filter(Boolean),
          ...seed.filter((row) => !ids.includes(row.id)),
        ];
        return new Promise((resolve) => {
          deferred.push(() => resolve({}));
        });
      }
      return {};
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_A}`)).toBeTruthy());
    const panel = screen.getByTestId('queue-panel');
    const positionOf = (id: string) =>
      within(screen.getByTestId(`queue-row-${id}`)).getByTestId('queue-row-position')
        .textContent;
    // First click: A moves down, sync starts and stays in flight.
    await user.click(
      within(screen.getByTestId(`queue-row-${ID_A}`)).getByTestId('queue-row-move-down')
    );
    await waitFor(() => expect(positionOf(ID_A)).toContain('#2'));
    expect(positionOf(ID_B)).toContain('#1');
    // Second click while the first sync is still in flight: A moves
    // down again from the optimistic order, and no second request
    // goes out yet — the newest order is coalesced, not queued.
    await user.click(
      within(screen.getByTestId(`queue-row-${ID_A}`)).getByTestId('queue-row-move-down')
    );
    await waitFor(() => expect(positionOf(ID_A)).toContain('#3'));
    expect(positionOf(ID_C)).toContain('#2');
    const reorderCalls = () =>
      apiPost.mock.calls.filter((args) =>
        String(args[0]).includes('/publishing/queue/reorder')
      );
    expect(reorderCalls()).toHaveLength(1);
    expect(reorderCalls()[0]![1]).toEqual({ pageId: PAGE_ID, itemIds: [ID_B, ID_A, ID_C] });
    // Letting the first sync resolve sends the newest order, never
    // the stale one — and the final order sticks after convergence.
    deferred[0]!();
    await waitFor(() => expect(reorderCalls()).toHaveLength(2));
    expect(reorderCalls()[1]![1]).toEqual({ pageId: PAGE_ID, itemIds: [ID_B, ID_C, ID_A] });
    deferred[1]!();
    await waitFor(() =>
      expect(panel.querySelectorAll('ul > li').item(0).textContent).toContain('Second queued post')
    );
    await waitFor(() => expect(positionOf(ID_A)).toContain('#3'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('rolls back to the server order with an error toast when the sync fails', async () => {
    const user = userEvent.setup();
    // Deferred rejection: the request stays in flight until the test
    // rejects it, so the optimistic state is stable and observable
    // before the rollback (an immediate throw would roll back inside
    // the same flush and the swapped state could never be observed).
    let rejectReorder: (() => void) | null = null;
    apiPost.mockImplementation(async (path: string) => {
      if (String(path).includes('/publishing/queue/reorder')) {
        return new Promise((_, reject) => {
          rejectReorder = () => reject(new Error(''));
        });
      }
      return {};
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_A}`)).toBeTruthy());
    const panel = screen.getByTestId('queue-panel');
    await user.click(
      within(screen.getByTestId(`queue-row-${ID_A}`)).getByTestId('queue-row-move-down')
    );
    await waitFor(() =>
      expect(panel.querySelectorAll('ul > li').item(0).textContent).toContain('Second queued post')
    );
    expect(rejectReorder).not.toBeNull();
    rejectReorder!();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't reorder the queue. Please try again.")
    );
    await waitFor(() =>
      expect(panel.querySelectorAll('ul > li').item(0).textContent).toContain('First queued post')
    );
    expect(
      within(screen.getByTestId(`queue-row-${ID_A}`)).getByTestId('queue-row-position')
        .textContent
    ).toContain('#1');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('filters by status and resets to the first page', async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(screen.getByTestId(`queue-row-${ID_A}`)).toBeTruthy());
    await user.click(screen.getByTestId('queue-filter-failed'));
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          query: expect.objectContaining({ status: 'failed' }),
        })
      )
    );
  });

  it('shows the empty state with a Create button when nothing is queued', async () => {
    seed = [];
    const onCreatePost = vi.fn();
    renderPanel({ onCreatePost });
    await waitFor(() => expect(screen.getByTestId('queue-empty-state')).toBeTruthy());
    expect(screen.getByText('No posts in your queue yet.')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('queue-create-post-btn'));
    expect(onCreatePost).toHaveBeenCalled();
  });
});
