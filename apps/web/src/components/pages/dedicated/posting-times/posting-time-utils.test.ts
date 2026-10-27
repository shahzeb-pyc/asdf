import { describe, it, expect } from 'vitest';
import type { PageSlotSummary } from '../tab-dashboard';
import { formatSlotDisplay, getPostingTimeFormInitialState } from './posting-time-utils';

function makeSlot(overrides: Partial<PageSlotSummary> = {}): PageSlotSummary {
  return {
    id: 'slot-1',
    slotTime: '09:00',
    timezone: 'UTC',
    isActive: true,
    allowedFormats: null,
    ...overrides,
  };
}

describe('formatSlotDisplay (shared 12h formatter)', () => {
  it('formats a slot time with seconds, as stored, in 12h form', () => {
    const formatted = formatSlotDisplay('09:00:00');
    expect(formatted.time12).toBe('09:00');
    expect(formatted.ampm).toBe('AM');
  });

  it('formats an afternoon slot time in 12h form', () => {
    const formatted = formatSlotDisplay('15:00:00');
    expect(formatted.time12).toBe('03:00');
    expect(formatted.ampm).toBe('PM');
  });

  it('formats midnight and noon correctly', () => {
    expect(formatSlotDisplay('00:30')).toEqual(
      expect.objectContaining({ time12: '12:30', ampm: 'AM' })
    );
    expect(formatSlotDisplay('12:30')).toEqual(
      expect.objectContaining({ time12: '12:30', ampm: 'PM' })
    );
  });
});

describe('getPostingTimeFormInitialState', () => {
  it('defaults the Add dialog to 09:00 with no post type selected', () => {
    const state = getPostingTimeFormInitialState(null);
    expect(state.timeInput).toBe('09:00');
    expect(state.selectedFormats).toEqual([]);
  });

  it('normalises a legacy null format list on Edit to every post type', () => {
    const state = getPostingTimeFormInitialState(
      makeSlot({ slotTime: '09:00', allowedFormats: null })
    );
    expect(state.selectedFormats).toEqual(['reel', 'image', 'video', 'story', 'text']);
  });

  it('initializes Edit from the slot being edited', () => {
    const state = getPostingTimeFormInitialState(
      makeSlot({ slotTime: '09:00', allowedFormats: ['image'] })
    );
    expect(state.timeInput).toBe('09:00');
    expect(state.selectedFormats).toEqual(['image']);
  });

  it('never leaks a previous Add value into an Edit (QA #19 regression)', () => {
    // Simulate the reported flow: Add is used first with a 10:00 value,
    // then Edit is opened on the 09:00 slot. The dialog derives its initial
    // state fresh from the target slot on every open.
    const addState = getPostingTimeFormInitialState(null);
    addState.timeInput = '10:00';

    const editState = getPostingTimeFormInitialState(makeSlot({ slotTime: '09:00' }));
    expect(editState.timeInput).toBe('09:00');
  });

  it('trims stored seconds from the slot time for the time input', () => {
    expect(getPostingTimeFormInitialState(makeSlot({ slotTime: '09:00:00' })).timeInput).toBe(
      '09:00'
    );
  });

  it('returns fresh format arrays so one dialog cannot mutate the next', () => {
    const slot = makeSlot({ allowedFormats: ['image'] });
    const first = getPostingTimeFormInitialState(slot);
    first.selectedFormats.push('reel');
    expect(getPostingTimeFormInitialState(slot).selectedFormats).toEqual(['image']);
    expect(slot.allowedFormats).toEqual(['image']);
  });
});
