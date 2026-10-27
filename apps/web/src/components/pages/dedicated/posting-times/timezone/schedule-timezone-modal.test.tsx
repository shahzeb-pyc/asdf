/**
 * Schedule-timezone flow — behavioural tests (spec 134 PR-134-2, §7.5)
 * for the rebuilt flow under posting-times/timezone/. The legacy
 * suite (tests/unit/schedule-timezone-modal.test.tsx) keeps covering
 * the legacy file for its remaining posting-times tab consumer.
 *
 * Behaviour preserved from spec 106/062: two steps (select → review
 * impact), proceed disabled while the selection equals the active
 * zone, impact counts from props, and a failed update surfaces its
 * message in step 2 without closing.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ScheduleTimezoneModal } from './schedule-timezone-modal';

function renderModal(overrides: Partial<React.ComponentProps<typeof ScheduleTimezoneModal>> = {}) {
  const props: React.ComponentProps<typeof ScheduleTimezoneModal> = {
    isOpen: true,
    activeTimezone: 'UTC',
    slotsCount: 3,
    queuedCount: 2,
    onClose: vi.fn(),
    onConfirmTimezone: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const utils = render(<ScheduleTimezoneModal {...props} />);
  return { props, ...utils };
}

describe('ScheduleTimezoneModal (rebuilt, spec 134)', () => {
  it('renders nothing while closed', () => {
    renderModal({ isOpen: false });
    expect(screen.queryByTestId('schedule-timezone-modal')).not.toBeInTheDocument();
  });

  it('opens on step 1 with the current banner, search, and a disabled Review change', () => {
    renderModal();
    expect(screen.getByTestId('schedule-timezone-modal')).toBeInTheDocument();
    expect(screen.getByTestId('current-timezone-banner')).toBeInTheDocument();
    expect(screen.getByTestId('timezone-search-input')).toBeInTheDocument();
    expect(screen.getByText('Change timezone')).toBeInTheDocument();
    expect(screen.getByTestId('proceed-to-step2-button')).toBeDisabled();
    expect(screen.getByTestId('timezone-option-America/New_York')).toBeInTheDocument();
  });

  it('filters the directory by search and reports no matches', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getByTestId('timezone-search-input'), 'Karachi');
    expect(screen.getByTestId('timezone-option-Asia/Karachi')).toBeInTheDocument();
    expect(screen.queryByTestId('timezone-option-America/New_York')).not.toBeInTheDocument();

    await user.clear(screen.getByTestId('timezone-search-input'));
    await user.type(screen.getByTestId('timezone-search-input'), 'zzzz-not-a-place');
    expect(screen.getByTestId('timezone-no-matches')).toBeInTheDocument();
  });

  it('walks select → review → confirm with the chosen zone', async () => {
    const user = userEvent.setup();
    const { props } = renderModal();
    await user.click(screen.getByTestId('timezone-option-Asia/Karachi'));
    expect(screen.getByTestId('proceed-to-step2-button')).toBeEnabled();
    await user.click(screen.getByTestId('proceed-to-step2-button'));

    expect(screen.getByTestId('timezone-transition-card')).toBeInTheDocument();
    expect(screen.getByTestId('timezone-impact-metrics')).toHaveTextContent('3');
    expect(screen.getByTestId('timezone-impact-metrics')).toHaveTextContent('2');
    expect(screen.getByText('Review timezone change')).toBeInTheDocument();

    await user.click(screen.getByTestId('confirm-timezone-update-button'));
    await waitFor(() => expect(props.onConfirmTimezone).toHaveBeenCalledWith('Asia/Karachi'));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('returns to step 1 from the review step', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByTestId('timezone-option-Asia/Karachi'));
    await user.click(screen.getByTestId('proceed-to-step2-button'));
    await user.click(screen.getByTestId('back-to-step1-button'));
    expect(screen.getByTestId('timezone-search-input')).toBeInTheDocument();
  });

  it('surfaces a failed update in step 2 and stays open', async () => {
    const user = userEvent.setup();
    const { props } = renderModal({
      onConfirmTimezone: vi.fn().mockRejectedValue(new Error('Network error updating schedule timezone')),
    });
    await user.click(screen.getByTestId('timezone-option-Asia/Karachi'));
    await user.click(screen.getByTestId('proceed-to-step2-button'));
    await user.click(screen.getByTestId('confirm-timezone-update-button'));

    expect(await screen.findByTestId('timezone-update-error')).toHaveTextContent(
      'Network error updating schedule timezone'
    );
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
