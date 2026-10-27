/**
 * Posting-time form — behavioural tests (spec 134 PR-134-2, §7.5).
 *
 * The form pattern (summary + inline, input never cleared), the Add/Edit
 * titles, and the spec 112 #19 first-open regression: an Edit opened
 * after an Add (with a different typed value) shows the edited slot's
 * own time on first render.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { PageSlotSummary } from '../tab-dashboard';
import { PostingTimeForm } from './posting-time-form';

const SLOT_0900: PageSlotSummary = {
  id: 'slot-9',
  slotTime: '09:00',
  timezone: 'UTC',
  isActive: true,
  allowedFormats: ['image'],
};

function renderForm(overrides: Partial<React.ComponentProps<typeof PostingTimeForm>> = {}) {
  const props: React.ComponentProps<typeof PostingTimeForm> = {
    activeTimezone: 'UTC',
    slotToEdit: null,
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const utils = render(<PostingTimeForm {...props} />);
  return { props, ...utils };
}

describe('PostingTimeForm', () => {
  it('defaults Add to 09:00 with no post type selected (the user must pick one)', () => {
    renderForm();
    expect(screen.getByTestId('add-posting-time-modal')).toBeInTheDocument();
    expect(screen.getByText('Add Daily Posting Time')).toBeInTheDocument();
    expect((screen.getByTestId('posting-time-input') as HTMLInputElement).value).toBe('09:00');
    // Publisher-driven rule: a posting time must have at least one
    // format picked by the user — Add pre-selects nothing.
    for (const format of ['reel', 'image', 'video', 'story', 'text']) {
      expect(screen.getByTestId(`modal-format-toggle-${format}`)).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    }
    expect(screen.getByTestId('modal-schedule-timezone-note')).toHaveTextContent('UTC');
  });

  it('initialises Edit from the slot being edited', () => {
    renderForm({ slotToEdit: SLOT_0900 });
    expect(screen.getByText('Edit Posting Time')).toBeInTheDocument();
    expect((screen.getByTestId('posting-time-input') as HTMLInputElement).value).toBe('09:00');
    expect(screen.getByTestId('modal-format-toggle-image')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('modal-format-toggle-reel')).toHaveAttribute('aria-pressed', 'false');
  });

  it('never leaks a previous Add value into an Edit (112 #19 regression)', async () => {
    const user = userEvent.setup();
    // First: an Add dialog where the user types 10:00.
    const add = renderForm();
    const addInput = screen.getByTestId('posting-time-input') as HTMLInputElement;
    fireEvent.change(addInput, { target: { value: '10:00' } });
    expect(addInput.value).toBe('10:00');
    add.unmount();

    // Then: Edit opened on the 09:00 slot — first render shows 09:00.
    renderForm({ slotToEdit: SLOT_0900 });
    expect((screen.getByTestId('posting-time-input') as HTMLInputElement).value).toBe('09:00');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('blocks saving with no post type selected and never clears the time', async () => {
    const user = userEvent.setup();
    const { props } = renderForm({ slotToEdit: SLOT_0900 });
    // Deselect the only selected format.
    await user.click(screen.getByTestId('modal-format-toggle-image'));
    await user.click(screen.getByTestId('save-slot-btn'));

    // The message appears inline under the field AND in the error
    // summary (the form standard: identical wording in both places).
    expect((await screen.findAllByText('Choose at least one post type.')).length).toBe(2);
    expect(props.onSave).not.toHaveBeenCalled();
    expect((screen.getByTestId('posting-time-input') as HTMLInputElement).value).toBe('09:00');
  });

  it('saves the entered time and formats through onSave and closes', async () => {
    const user = userEvent.setup();
    const { props } = renderForm();
    fireEvent.change(screen.getByTestId('posting-time-input'), { target: { value: '17:30' } });
    // Add starts with nothing selected; pick one format to save.
    await user.click(screen.getByTestId('modal-format-toggle-reel'));
    await user.click(screen.getByTestId('save-slot-btn'));

    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith({
        slotTime: '17:30',
        timezone: 'UTC',
        allowedFormats: ['reel'],
      })
    );
    expect(props.onClose).toHaveBeenCalled();
  });

  it('surfaces a save failure in the summary and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const { props } = renderForm({
      onSave: vi.fn().mockRejectedValue(new Error('Slot already exists at this time.')),
    });
    await user.click(screen.getByTestId('modal-format-toggle-reel'));
    await user.click(screen.getByTestId('save-slot-btn'));

    expect(await screen.findByText('Slot already exists at this time.')).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
