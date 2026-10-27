/**
 * Posting-times tab — behavioural tests (spec 134 PR-134-2, §7.5):
 * rows render time/status/formats with the timezone label, the Switch
 * toggles through the route callback, the empty state offers its one
 * primary action, Add/Edit open the form dialog, delete goes through
 * the AlertDialog confirm, and the timezone flow opens from the header.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { FacebookPageItem } from '../../page-card';
import type { PageSlotSummary } from '../tab-dashboard';
import { PageTabPostingTimes } from './tab-posting-times';

const PAGE: FacebookPageItem = {
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

const SLOTS: PageSlotSummary[] = [
  { id: 'slot-1', slotTime: '09:00', timezone: 'UTC', isActive: true, allowedFormats: null },
  { id: 'slot-2', slotTime: '15:00', timezone: 'UTC', isActive: false, allowedFormats: ['image'] },
];

function renderTab(overrides: Partial<React.ComponentProps<typeof PageTabPostingTimes>> = {}) {
  const props: React.ComponentProps<typeof PageTabPostingTimes> = {
    page: PAGE,
    slots: SLOTS,
    pendingQueueCount: 2,
    onAddSlot: vi.fn().mockResolvedValue(undefined),
    onUpdateSlot: vi.fn().mockResolvedValue(undefined),
    onUpdateTimezone: vi.fn().mockResolvedValue(undefined),
    onToggleSlot: vi.fn().mockResolvedValue(undefined),
    onDeleteSlot: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const utils = render(<PageTabPostingTimes {...props} />);
  return { props, ...utils };
}

describe('PageTabPostingTimes (rebuilt, spec 134)', () => {
  it('renders slots with 12-hour times, status text, formats, and timezone labels', () => {
    renderTab();
    expect(screen.getByTestId('page-tab-calendar')).toBeInTheDocument();
    expect(screen.getByText('Posting Times')).toBeInTheDocument();
    expect(screen.getByText('09:00')).toBeInTheDocument();
    expect(screen.getByText('03:00')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    // Inactive means future scheduling only — already-queued posts
    // still go out, so the label says so (no dot, shared header mark).
    expect(screen.getByText('Paused for new posts')).toBeInTheDocument();
    expect(screen.getByTestId('slot-format-badge-all-slot-1')).toHaveTextContent('All post types');
    expect(screen.getByTestId('slot-format-badge-slot-2-image')).toHaveTextContent('Photos');
    expect(screen.getAllByText('UTC').length).toBeGreaterThan(0);
  });

  it('toggles a slot through onToggleSlot when its Switch changes', async () => {
    const user = userEvent.setup();
    const { props } = renderTab();
    await user.click(screen.getByTestId('toggle-slot-btn-slot-1'));
    await waitFor(() => expect(props.onToggleSlot).toHaveBeenCalledWith('slot-1', false));
  });

  it('shows the typed empty state and opens the Add form from it', async () => {
    const user = userEvent.setup();
    renderTab({ slots: [] });
    expect(screen.getByTestId('calendar-empty-state')).toBeInTheDocument();
    expect(screen.getByText('No daily posting times set yet')).toBeInTheDocument();
    await user.click(screen.getByTestId('empty-add-slot-button'));
    expect(await screen.findByTestId('add-posting-time-modal')).toBeInTheDocument();
  });

  it('opens Edit keyed to the row slot and saves through onUpdateSlot', async () => {
    const user = userEvent.setup();
    const { props } = renderTab();
    await user.click(screen.getByTestId('edit-slot-btn-slot-2'));
    const modal = await screen.findByTestId('add-posting-time-modal');
    expect(modal).toHaveTextContent('Edit Posting Time');
    expect((screen.getByTestId('posting-time-input') as HTMLInputElement).value).toBe('15:00');
    await user.click(screen.getByTestId('save-slot-btn'));
    await waitFor(() =>
      expect(props.onUpdateSlot).toHaveBeenCalledWith(
        'slot-2',
        expect.objectContaining({ slotTime: '15:00', timezone: 'UTC' })
      )
    );
  });

  it('deletes through the AlertDialog confirm with the verb-named action', async () => {
    const user = userEvent.setup();
    const { props } = renderTab();
    await user.click(screen.getByTestId('delete-slot-btn-slot-1'));
    const dialog = await screen.findByTestId('delete-posting-time-modal');
    expect(dialog).toHaveTextContent('Remove Posting Time?');
    expect(dialog).toHaveTextContent('09:00 AM');
    // NOTE: dialog copy is HELD — the product owner is changing
    // deletion to actually redistribute queued posts, and the copy
    // will be rewritten to describe that behaviour once confirmed.
    await user.click(screen.getByTestId('confirm-delete-slot-btn'));
    await waitFor(() => expect(props.onDeleteSlot).toHaveBeenCalledWith('slot-1'));
  });

  it('shows only active slots in the timezone review metrics', async () => {
    const user = userEvent.setup();
    // Fixture: slot-1 active, slot-2 inactive; pendingQueueCount 2.
    renderTab();
    await user.click(screen.getByTestId('schedule-timezone-trigger'));
    expect(await screen.findByTestId('schedule-timezone-modal')).toBeInTheDocument();
    await user.click(screen.getByTestId('timezone-option-Asia/Karachi'));
    await user.click(screen.getByTestId('proceed-to-step2-button'));
    const metrics = await screen.findByTestId('timezone-impact-metrics');
    expect(screen.getByTestId('timezone-metric-slots')).toHaveTextContent('1');
    expect(screen.getByTestId('timezone-metric-queued')).toHaveTextContent('2');
    expect(metrics).toBeInTheDocument();
  });

  it('keeps the switch state when toggling fails', async () => {
    const user = userEvent.setup();
    const { props } = renderTab({
      onToggleSlot: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const toggle = screen.getByTestId('toggle-slot-btn-slot-1');
    expect(toggle).toHaveAttribute('data-state', 'checked');
    // The switch is controlled by server data, so a failed toggle
    // reverts on its own instead of flipping optimistically.
    await user.click(toggle);
    await waitFor(() => expect(props.onToggleSlot).toHaveBeenCalledWith('slot-1', false));
    expect(screen.getByTestId('toggle-slot-btn-slot-1')).toHaveAttribute(
      'data-state',
      'checked'
    );
  });

  it('opens the timezone flow from the header trigger', async () => {
    const user = userEvent.setup();
    const { props } = renderTab();
    await user.click(screen.getByTestId('schedule-timezone-trigger'));
    expect(await screen.findByTestId('schedule-timezone-modal')).toBeInTheDocument();
    await user.click(screen.getByTestId('timezone-option-Asia/Karachi'));
    await user.click(screen.getByTestId('proceed-to-step2-button'));
    await user.click(screen.getByTestId('confirm-timezone-update-button'));
    await waitFor(() => expect(props.onUpdateTimezone).toHaveBeenCalledWith('Asia/Karachi'));
  });

  it('renders loading skeletons while slots load', () => {
    renderTab({ isLoading: true });
    expect(screen.getByTestId('calendar-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('slots-grid')).not.toBeInTheDocument();
  });
});
