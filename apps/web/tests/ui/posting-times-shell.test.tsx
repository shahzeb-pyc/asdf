/**
 * Posting-times shell wiring tests: the production edit path must use
 * the single-slot PATCH route (preserving the slot id), the timezone
 * review counts active slots and all queued posts (publisher-driven
 * scheduling has no slot links and nothing to realign), and a failed
 * toggle must leave the switch in its server state.
 *
 * These tests fail on the old shell: it never passed onUpdateSlot
 * (edits fell back to delete + re-add), and the pre-publisher-driven
 * shell counted slot-linked queued posts only.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import TenantDedicatedPageView from '@/app/tenant/[subdomain]/pages/[pageId]/page-section-shell';
import type { FacebookPageItem } from '@/components/pages/page-card';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn() }),
  useParams: () => ({ subdomain: 'cyberdyne', pageId: 'page-101' }),
  useSearchParams: () => ({
    get: (key: string) => (key === 'tab' ? 'calendar' : null),
    toString: () => 'tab=calendar',
  }),
}));

const apiGet = vi.fn();
const apiPatch = vi.fn();
const apiPost = vi.fn();
const apiDelete = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock('@/components/shared/ui/toast', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
  Toast: () => null,
  Toaster: () => null,
}));

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    patch: (...args: unknown[]) => apiPatch(...args),
    post: (...args: unknown[]) => apiPost(...args),
    delete: (...args: unknown[]) => apiDelete(...args),
  },
  buildTenantApiPath: (subdomain: string, path: string) =>
    `/api/tenant/${encodeURIComponent(subdomain)}${path.startsWith('/') ? path : `/${path}`}`,
  isApiError: () => false,
}));

const SAMPLE_PAGE = {
  id: 'page-101',
  facebookAccountId: 'acc-99',
  accountDisplayName: 'John Connor',
  fbPageId: 'fb_101',
  pageName: 'Skynet Automation Central',
  category: 'Robotics & AI',
  startingFollowers: 0,
  currentFollowers: 0,
  followersGained: 0,
  status: 'active',
  timezone: 'UTC',
  createdAt: '2026-10-01T00:00:00.000Z',
} as FacebookPageItem;

const SLOTS = [
  { id: 'slot-1', slotTime: '09:00', timezone: 'UTC', isActive: true, allowedFormats: null },
  { id: 'slot-2', slotTime: '15:00', timezone: 'UTC', isActive: false, allowedFormats: ['image'] },
];

// q1, q2, q3: queued (slot links are vestigial under
// publisher-driven scheduling). q4: published (not queued).
const QUEUE_ITEMS = [
  { id: 'q1', status: 'queued', slotId: 'slot-1', scheduledTime: '2026-10-02T09:00:00.000Z', mediaId: null, postFormat: 'text', linkUrl: null, caption: null, firstComment: null, media: null },
  { id: 'q2', status: 'queued', slotId: 'slot-1', scheduledTime: '2026-10-03T09:00:00.000Z', mediaId: null, postFormat: 'text', linkUrl: null, caption: null, firstComment: null, media: null },
  { id: 'q3', status: 'queued', slotId: null, scheduledTime: '2026-10-02T12:00:00.000Z', mediaId: null, postFormat: 'text', linkUrl: null, caption: null, firstComment: null, media: null },
  { id: 'q4', status: 'published', slotId: 'slot-1', scheduledTime: '2026-10-01T09:00:00.000Z', mediaId: null, postFormat: 'text', linkUrl: null, caption: null, firstComment: null, media: null },
];

function renderShell() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TenantDedicatedPageView
        subdomainProp="cyberdyne"
        pageIdProp="page-101"
        initialPage={SAMPLE_PAGE}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockImplementation((url: string) => {
    if (url.includes('/slots')) return Promise.resolve({ slots: SLOTS });
    if (url.includes('/publishing/queue')) return Promise.resolve({ items: QUEUE_ITEMS });
    return Promise.resolve({});
  });
  apiPatch.mockImplementation(() => Promise.resolve({ id: 'slot-1' }));
  apiPost.mockImplementation(() => Promise.resolve({}));
  apiDelete.mockImplementation(() => Promise.resolve({}));
});

describe('Posting-times shell wiring', () => {
  it('edits a slot through PATCH with the same id — never delete + re-add', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByTestId('posting-time-row-slot-1');
    await user.click(screen.getByTestId('edit-slot-btn-slot-1'));
    const modal = await screen.findByTestId('add-posting-time-modal');
    expect(modal).toHaveTextContent('Edit Posting Time');
    fireEvent.change(screen.getByTestId('posting-time-input'), { target: { value: '10:00' } });
    await user.click(screen.getByTestId('save-slot-btn'));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(
        expect.stringContaining('/slots/slot-1'),
        expect.objectContaining({ slotTime: '10:00' }),
        expect.anything()
      )
    );
    expect(apiDelete).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('leaves the original slot untouched when an edit conflicts (409)', async () => {
    const user = userEvent.setup();
    apiPatch.mockRejectedValueOnce(
      new Error('A publishing slot at this time already exists for this page')
    );
    renderShell();
    await screen.findByTestId('posting-time-row-slot-1');
    await user.click(screen.getByTestId('edit-slot-btn-slot-1'));
    await screen.findByTestId('add-posting-time-modal');
    await user.click(screen.getByTestId('save-slot-btn'));
    // The form stays open on failure, and no delete ever ran, so the
    // original slot is still there — the old delete-first fallback
    // would already have destroyed it by this point.
    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    expect(await screen.findByTestId('add-posting-time-modal')).toBeInTheDocument();
    expect(apiDelete).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
    expect(screen.getByTestId('posting-time-row-slot-1')).toBeInTheDocument();
  });

  it('counts active slots and all queued posts in the timezone review (nothing is realigned)', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByTestId('posting-time-row-slot-1');
    await user.click(screen.getByTestId('schedule-timezone-trigger'));
    expect(await screen.findByTestId('schedule-timezone-modal')).toBeInTheDocument();
    await user.click(screen.getByTestId('timezone-option-Asia/Karachi'));
    await user.click(screen.getByTestId('proceed-to-step2-button'));
    const metrics = await screen.findByTestId('timezone-impact-metrics');
    // 1 active slot (slot-2 is paused), 3 queued posts (q1, q2, q3;
    // q4 is published). No realignment copy anywhere.
    expect(screen.getByTestId('timezone-metric-slots')).toHaveTextContent('1');
    expect(screen.getByTestId('timezone-metric-queued')).toHaveTextContent('3');
    expect(metrics).toHaveTextContent('Estimates update with the new timezone');
    expect(metrics).not.toHaveTextContent('realigned');
  });

  it('keeps the switch in its server state when toggling fails', async () => {
    const user = userEvent.setup();
    apiPatch.mockRejectedValueOnce(new Error('boom'));
    renderShell();
    const toggle = await screen.findByTestId('toggle-slot-btn-slot-1');
    expect(toggle).toHaveAttribute('data-state', 'checked');
    await user.click(toggle);
    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    expect(screen.getByTestId('toggle-slot-btn-slot-1')).toHaveAttribute(
      'data-state',
      'checked'
    );
  });

  it('flips the switch instantly on toggle, before the mutation resolves', async () => {
    const user = userEvent.setup();
    const patch = deferred<unknown>();
    apiPatch.mockImplementationOnce(() => patch.promise);
    renderShell();
    const toggle = await screen.findByTestId('toggle-slot-btn-slot-1');
    expect(toggle).toHaveAttribute('data-state', 'checked');
    const queueGetsBefore = apiGet.mock.calls.filter(([url]) =>
      String(url).includes('/publishing/queue')
    ).length;
    await user.click(toggle);
    // Instant: the switch flips from the optimistic cache write while
    // the PATCH is still in flight — the old code showed nothing
    // until the round trip plus refetch finished.
    await waitFor(() =>
      expect(screen.getByTestId('toggle-slot-btn-slot-1')).toHaveAttribute(
        'data-state',
        'unchecked'
      )
    );
    expect(apiPatch).toHaveBeenCalledWith(
      expect.stringContaining('/slots/slot-1'),
      expect.objectContaining({ isActive: false }),
      expect.anything()
    );
    // The server now agrees with the optimistic state before the
    // settled refetch runs, so the flip survives reconciliation.
    apiGet.mockImplementation((url: string) => {
      if (url.includes('/slots')) return Promise.resolve({ slots: TOGGLED_SLOTS });
      if (url.includes('/publishing/queue')) return Promise.resolve({ items: QUEUE_ITEMS });
      return Promise.resolve({});
    });
    patch.resolve({ id: 'slot-1' });
    await waitFor(() =>
      expect(screen.getByTestId('toggle-slot-btn-slot-1')).toHaveAttribute(
        'data-state',
        'unchecked'
      )
    );
    // The toggle reconciles slots (and the page) only — the queue is
    // never refetched: its estimates derive from the slots cache.
    const queueGetsAfter = apiGet.mock.calls.filter(([url]) =>
      String(url).includes('/publishing/queue')
    ).length;
    expect(queueGetsAfter).toBe(queueGetsBefore);
  });

  it('reverts the switch and shows an error when toggling fails', async () => {
    const user = userEvent.setup();
    apiPatch.mockRejectedValueOnce('network down');
    renderShell();
    const toggle = await screen.findByTestId('toggle-slot-btn-slot-1');
    await user.click(toggle);
    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    // Optimistic flip first, then rollback to the server state.
    await waitFor(() =>
      expect(screen.getByTestId('toggle-slot-btn-slot-1')).toHaveAttribute(
        'data-state',
        'checked'
      )
    );
    expect(toastError).toHaveBeenCalledWith(
      "Couldn't update the posting time. Please try again."
    );
  });

  it('removes the row instantly on delete confirm, before the mutation resolves', async () => {
    const user = userEvent.setup();
    const deletion = deferred<unknown>();
    apiDelete.mockImplementationOnce(() => deletion.promise);
    renderShell();
    await screen.findByTestId('posting-time-row-slot-1');
    await user.click(screen.getByTestId('delete-slot-btn-slot-1'));
    await screen.findByTestId('delete-posting-time-modal');
    await user.click(screen.getByTestId('confirm-delete-slot-btn'));
    // Instant: the row leaves the list from the optimistic cache
    // write while the DELETE is still in flight — the old code kept
    // it until the round trip plus refetch finished.
    await waitFor(() =>
      expect(screen.queryByTestId('posting-time-row-slot-1')).not.toBeInTheDocument()
    );
    // The success toast fires only after the server confirms.
    expect(toastSuccess).not.toHaveBeenCalled();
    apiGet.mockImplementation((url: string) => {
      if (url.includes('/slots')) return Promise.resolve({ slots: SLOTS_WITHOUT_SLOT_1 });
      if (url.includes('/publishing/queue')) return Promise.resolve({ items: QUEUE_ITEMS });
      return Promise.resolve({});
    });
    deletion.resolve({ success: true });
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Posting time removed.')
    );
    expect(screen.queryByTestId('posting-time-row-slot-1')).not.toBeInTheDocument();
  });

  it('shows a success toast when a posting time is added', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByTestId('posting-time-row-slot-1');
    await user.click(screen.getByTestId('add-slot-button'));
    await screen.findByTestId('add-posting-time-modal');
    fireEvent.change(screen.getByTestId('posting-time-input'), { target: { value: '10:00' } });
    // Add starts with zero formats picked; at least one is required.
    await user.click(screen.getByTestId('modal-format-toggle-text'));
    await user.click(screen.getByTestId('save-slot-btn'));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Posting time added.')
    );
  });

  it('shows a success toast when the timezone is updated', async () => {
    const user = userEvent.setup();
    renderShell();
    await screen.findByTestId('posting-time-row-slot-1');
    await user.click(screen.getByTestId('schedule-timezone-trigger'));
    expect(await screen.findByTestId('schedule-timezone-modal')).toBeInTheDocument();
    await user.click(screen.getByTestId('timezone-option-Asia/Karachi'));
    await user.click(screen.getByTestId('proceed-to-step2-button'));
    await user.click(screen.getByTestId('confirm-timezone-update-button'));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(
        expect.stringContaining('/slots'),
        expect.objectContaining({ timezone: 'Asia/Karachi' }),
        expect.anything()
      )
    );
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Timezone updated to Asia/Karachi.')
    );
  });

  it('restores the row and shows an error when deleting fails', async () => {
    const user = userEvent.setup();
    apiDelete.mockRejectedValueOnce('network down');
    renderShell();
    await screen.findByTestId('posting-time-row-slot-1');
    await user.click(screen.getByTestId('delete-slot-btn-slot-1'));
    await screen.findByTestId('delete-posting-time-modal');
    await user.click(screen.getByTestId('confirm-delete-slot-btn'));
    await waitFor(() => expect(apiDelete).toHaveBeenCalled());
    // Rollback restores the row and the failure is surfaced — never
    // silent, never lost. The dialog closes here because the shell
    // converts the failure to a resolved mutation (its catch pattern)
    // and the tab then clears the pending delete; the user retries
    // with Remove again.
    await waitFor(() =>
      expect(screen.getByTestId('posting-time-row-slot-1')).toBeInTheDocument()
    );
    expect(toastError).toHaveBeenCalledWith(
      "Couldn't remove the posting time. Please try again."
    );
    expect(screen.queryByTestId('delete-posting-time-modal')).not.toBeInTheDocument();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const TOGGLED_SLOTS = [
  { id: 'slot-1', slotTime: '09:00', timezone: 'UTC', isActive: false, allowedFormats: null },
  { id: 'slot-2', slotTime: '15:00', timezone: 'UTC', isActive: false, allowedFormats: ['image'] },
];

const SLOTS_WITHOUT_SLOT_1 = [SLOTS[1]];
