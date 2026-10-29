/**
 * @file create-posts-dialog.test.tsx
 * @description Behavioural tests for the Create Posts dialogue on a
 * dedicated Page. These exist because the dialogue is the part of
 * the Create Posts work that previously had no component coverage
 * at all (only the header button was tested): a queueing bug, a
 * stuck dialogue, or a draft-loss regression in this file could
 * not have been caught by any test. The tests cover the behaviour
 * a user sees — blocks, queueing, progress, Stop, timeout, draft
 * confirmation, page-status gating — not markup.
 *
 * Seams: the app API (`@/lib/api`) and toast are mocked at the
 * module seam, exactly as in posting-times-shell.test.tsx. The
 * media picker is never opened here (its own handlers are covered
 * by picker tests / the API tests); Bulk Text is exercised for
 * real because it is part of this dialogue. Fake timers are used
 * only for the timeout test.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { CreatePostsDialog } from '@/components/pages/dedicated/create-posts/create-posts-dialog';
import type { FacebookPageItem } from '@/components/pages/page-card';

const apiGet = vi.fn();
const apiPost = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const toastInfo = vi.fn();
const mockPush = vi.fn();

vi.mock('@/components/shared/ui/toast', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
  Toast: () => null,
  Toaster: () => null,
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
  },
  buildTenantApiPath: (subdomain: string, path: string) =>
    `/api/tenant/${encodeURIComponent(subdomain)}${path.startsWith('/') ? path : `/${path}`}`,
  isApiError: (err: unknown) =>
    Boolean(err && typeof err === 'object' && 'code' in (err as Record<string, unknown>)),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  useSearchParams: () => ({ get: () => null, toString: () => '' }),
}));

const PAGE_ID = '66666666-6666-4666-a666-666666666666';

function makePage(overrides: Partial<FacebookPageItem> = {}): FacebookPageItem {
  return {
    id: PAGE_ID,
    facebookAccountId: '11111111-1111-4111-a111-111111111111',
    fbPageId: '123456',
    pageName: 'Happycatclub',
    profilePictureUrl: null,
    startingFollowers: 0,
    currentFollowers: 10,
    followersGained: 10,
    status: 'active',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderDialog(page: FacebookPageItem = makePage(), onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <CreatePostsDialog open subdomain="acme" page={page} onOpenChange={onOpenChange} />
    </QueryClientProvider>
  );
  return { ...utils, onOpenChange, queryClient };
}

function textareas() {
  return screen.getAllByTestId('create-posts-block-text') as HTMLTextAreaElement[];
}

function queueButton() {
  return screen.getByTestId('create-posts-queue-btn') as HTMLButtonElement;
}

function typePost(text: string, index = 0) {
  fireEvent.change(textareas()[index], { target: { value: text } });
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue({ slots: [{ id: 'slot-1', isActive: true }] });
  apiPost.mockResolvedValue({ id: 'queued-1' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CreatePostsDialog rendering and blocks', () => {
  it('renders the identity, bulk actions, trailing New post, and a disabled queue button when empty', () => {
    renderDialog();
    expect(screen.getByText('Happycatclub')).not.toBeNull();
    expect(screen.getByText('Posting as this Page')).not.toBeNull();
    expect(screen.getByTestId('create-posts-bulk-post-btn')).not.toBeNull();
    expect(screen.getByTestId('create-posts-bulk-text-btn')).not.toBeNull();
    expect(screen.getByText('New post')).not.toBeNull();
    expect(queueButton().disabled).toBe(true);
    expect(queueButton().textContent).toBe('Add all to Queue');
  });

  it('typing in the trailing block turns it into Post 1 and appends a fresh New post block', () => {
    renderDialog();
    typePost('hello world');
    expect(screen.getByText('Post 1')).not.toBeNull();
    expect(screen.getByText('New post')).not.toBeNull();
    expect(textareas()).toHaveLength(2);
    expect(queueButton().disabled).toBe(false);
    expect(queueButton().textContent).toBe('Add all to Queue (1 post)');
    expect(screen.getAllByTestId('create-posts-block-char-count')[0].textContent).toContain(
      '11 / 63,206'
    );
  });

  it('removing a real block drops it and leaves the trailing draft', () => {
    renderDialog();
    typePost('first post');
    typePost('second post', 1);
    expect(screen.getByText('Post 2')).not.toBeNull();
    const removeButtons = screen.getAllByLabelText(/Remove Post/);
    fireEvent.click(removeButtons[0]);
    expect(screen.queryByText('Post 2')).toBeNull();
    expect(screen.getByText('New post')).not.toBeNull();
  });

  it('bulk text adds one block per line', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('create-posts-bulk-text-btn'));
    const input = screen.getByTestId('bulk-text-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'one\ntwo\n\nthree' } });
    fireEvent.click(screen.getByTestId('bulk-text-add-btn'));
    await waitFor(() => {
      expect(screen.getByText('Post 3')).not.toBeNull();
    });
    expect(queueButton().textContent).toBe('Add all to Queue (3 posts)');
  });

  it('shows the paused warning but still allows queueing', () => {
    renderDialog(makePage({ status: 'paused' }));
    expect(screen.getByText(/posts you add will wait until the Page is reactivated/)).not.toBeNull();
    typePost('hello');
    expect(queueButton().disabled).toBe(false);
  });

  it('blocks queueing on a disconnected page', () => {
    renderDialog(makePage({ status: 'disconnected' }));
    expect(screen.getByText(/queueing is turned off for this Page/)).not.toBeNull();
    typePost('hello');
    expect(queueButton().disabled).toBe(true);
  });
});

describe('CreatePostsDialog queueing', () => {
  it('queues posts, shows success, and closes on full success', async () => {
    const { onOpenChange } = renderDialog();
    typePost('first');
    typePost('second', 1);
    fireEvent.click(queueButton());
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith('2 posts added to queue.');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('refuses over-limit blocks without calling the API', async () => {
    renderDialog();
    typePost('a'.repeat(63207));
    fireEvent.click(queueButton());
    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
    expect(apiPost).not.toHaveBeenCalled();
    expect(toastError.mock.calls[0][0]).toContain('over the 63,206-character');
  });

  it('sends nothing and shows the posting-times message when no active times exist', async () => {
    renderDialog();
    apiGet.mockResolvedValue({ slots: [{ id: 'slot-1', isActive: false }] });
    typePost('hello');
    fireEvent.click(queueButton());
    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
    expect(apiPost).not.toHaveBeenCalled();
    expect(toastError.mock.calls[0][0]).toContain('No posting times set yet');
  });

  it('falls through to the queue attempt when the slots check fails', async () => {
    const { onOpenChange } = renderDialog();
    apiGet.mockRejectedValue(new Error('slots down'));
    typePost('hello');
    fireEvent.click(queueButton());
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('on partial failure drops queued blocks, keeps the failed one, and re-enables the button', async () => {
    renderDialog();
    apiPost.mockResolvedValueOnce({ id: 'queued-1' }).mockRejectedValueOnce(new Error('boom'));
    typePost('first');
    typePost('second', 1);
    fireEvent.click(queueButton());
    await waitFor(() => {
      expect(toastError).toHaveBeenCalled();
    });
    expect(toastError.mock.calls[0][0]).toContain('1 of 2 posts queued');
    expect(screen.getByDisplayValue('second')).not.toBeNull();
    expect(screen.queryByDisplayValue('first')).toBeNull();
    expect(queueButton().disabled).toBe(false);
    expect(queueButton().textContent).toBe('Add all to Queue (1 post)');
  });

  it('reuses the same key for a pure retry and rotates it after an edit', async () => {
    renderDialog();
    apiPost.mockRejectedValueOnce(new Error('boom'));
    typePost('hello');
    fireEvent.click(queueButton());
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledTimes(1);
    });
    const firstKey = (apiPost.mock.calls[0][2] as { headers: Record<string, string> }).headers[
      'Idempotency-Key'
    ];
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/);
    // Pure retry: same key.
    apiPost.mockResolvedValueOnce({ id: 'queued-1' });
    fireEvent.click(queueButton());
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledTimes(2);
    });
    const secondKey = (apiPost.mock.calls[1][2] as { headers: Record<string, string> }).headers[
      'Idempotency-Key'
    ];
    expect(secondKey).toBe(firstKey);
    // Edit after a failed attempt, then retry: key must rotate.
    // (The previous run closed the dialog on success, so re-render
    // a fresh dialogue for the edit case.)
  });

  it('rotates the key when a block is edited after a failed attempt', async () => {
    renderDialog();
    apiPost.mockRejectedValueOnce(new Error('boom'));
    typePost('hello');
    fireEvent.click(queueButton());
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledTimes(1);
    });
    const firstKey = (apiPost.mock.calls[0][2] as { headers: Record<string, string> }).headers[
      'Idempotency-Key'
    ];
    fireEvent.change(textareas()[0], { target: { value: 'hello edited' } });
    apiPost.mockResolvedValueOnce({ id: 'queued-1' });
    fireEvent.click(queueButton());
    await waitFor(() => {
      expect(apiPost).toHaveBeenCalledTimes(2);
    });
    const secondKey = (apiPost.mock.calls[1][2] as { headers: Record<string, string> }).headers[
      'Idempotency-Key'
    ];
    expect(secondKey).not.toBe(firstKey);
  });

  it('Stop ends a run after the current post, keeps queued posts queued, and leaves the rest', async () => {
    renderDialog();
    let call = 0;
    apiPost.mockImplementation((_path: unknown, _body: unknown, opts: { signal?: AbortSignal }) => {
      call += 1;
      if (call === 1) return Promise.resolve({ id: 'queued-1' });
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        );
      });
    });
    typePost('first');
    typePost('second', 1);
    fireEvent.click(queueButton());
    await waitFor(() => {
      expect(screen.getByTestId('create-posts-stop-queue-btn')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('create-posts-stop-queue-btn'));
    await waitFor(() => {
      expect(toastInfo).toHaveBeenCalled();
    });
    expect(toastInfo.mock.calls[0][0]).toContain('Stopped — 1 post added to queue');
    expect(screen.getByDisplayValue('second')).not.toBeNull();
    expect(queueButton().disabled).toBe(false);
  });

  it('a hung request times out after 30 seconds and the timed-out post can be retried', async () => {
    vi.useFakeTimers();
    renderDialog();
    apiPost.mockImplementation((_path: unknown, _body: unknown, opts: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError'))
        );
      });
    });
    typePost('hello');
    fireEvent.click(queueButton());
    // Poll synchronously: waitFor's own polling timers are fake
    // here, so it cannot be used inside this test.
    for (let i = 0; i < 20 && !queueButton().textContent?.includes('Adding 1 of 1'); i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }
    expect(queueButton().textContent).toContain('Adding 1 of 1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(toastError).toHaveBeenCalled();
    expect(toastError.mock.calls[0][0]).toContain('timed out after 30 seconds');
    expect(queueButton().disabled).toBe(false);
  });
});

describe('CreatePostsDialog draft confirmation', () => {
  it('asks before discarding drafts, and discarding closes the dialogue', async () => {
    const { onOpenChange } = renderDialog();
    typePost('unsaved draft');
    fireEvent.click(screen.getByTestId('create-posts-cancel-btn'));
    expect(screen.getByText('Discard these posts?')).not.toBeNull();
    fireEvent.click(screen.getByText('Discard posts'));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('keeping editing leaves the dialogue open', () => {
    const { onOpenChange } = renderDialog();
    typePost('unsaved draft');
    fireEvent.click(screen.getByTestId('create-posts-cancel-btn'));
    fireEvent.click(screen.getByText('Keep editing'));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByDisplayValue('unsaved draft')).not.toBeNull();
  });
});
