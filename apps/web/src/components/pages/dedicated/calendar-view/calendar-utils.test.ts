/**
 * Calendar View pure helpers: month grids, timezone day keys, and
 * per-status placement. All cases use fixed instants — no clock.
 */
import { describe, it, expect } from 'vitest';

import {
  currentYearMonth,
  formatDayKey,
  formatDayTime,
  formatMonthLabel,
  getItemDayKey,
  getItemSortInstant,
  getMonthGridKeys,
  nextMonth,
  prevMonth,
  todayKey,
} from './calendar-utils';

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  status: 'queued',
  publishedAt: null as string | null,
  updatedAt: '2026-10-28T07:00:00.000Z',
  ...overrides,
});

describe('getMonthGridKeys', () => {
  it('starts on the Sunday before the 1st and covers the whole month', () => {
    // 1 Oct 2026 is a Thursday.
    const weeks = getMonthGridKeys(2026, 9, 'UTC');
    expect(weeks[0]?.[0]).toBe('2026-09-27');
    expect(weeks).toHaveLength(5);
    const flat = weeks.flat();
    expect(flat).toContain('2026-10-01');
    expect(flat).toContain('2026-10-31');
    expect(flat[flat.length - 1]).toBe('2026-10-31');
    for (const week of weeks) expect(week).toHaveLength(7);
  });

  it('handles a month starting on Sunday with four full weeks', () => {
    // 1 Feb 2026 is a Sunday; Feb 2026 has 28 days.
    const weeks = getMonthGridKeys(2026, 1, 'UTC');
    expect(weeks[0]?.[0]).toBe('2026-02-01');
    expect(weeks).toHaveLength(4);
    expect(weeks.flat()[weeks.flat().length - 1]).toBe('2026-02-28');
  });

  it('keeps day keys in the page timezone, not the browser zone', () => {
    // 01:00 UTC is still the previous evening in Chicago.
    expect(formatDayKey(new Date('2026-10-29T01:00:00.000Z'), 'America/Chicago')).toBe(
      '2026-10-28'
    );
    expect(formatDayKey(new Date('2026-10-29T01:00:00.000Z'), 'UTC')).toBe('2026-10-29');
  });
});

describe('formatDayTime', () => {
  it('formats a time like the queue pills', () => {
    expect(formatDayTime(new Date('2026-10-29T09:00:00.000Z'), 'UTC')).toBe('9:00 am');
    expect(formatDayTime(new Date('2026-10-29T21:30:00.000Z'), 'UTC')).toBe('9:30 pm');
  });
});

describe('month helpers', () => {
  it('labels months and steps across year boundaries', () => {
    expect(formatMonthLabel(2026, 9)).toBe('October 2026');
    expect(prevMonth(2026, 0)).toEqual({ year: 2025, month: 11 });
    expect(nextMonth(2026, 11)).toEqual({ year: 2027, month: 0 });
    expect(prevMonth(2026, 9)).toEqual({ year: 2026, month: 8 });
    expect(nextMonth(2026, 9)).toEqual({ year: 2026, month: 10 });
  });

  it('currentYearMonth agrees with todayKey', () => {
    const key = todayKey('UTC');
    expect(currentYearMonth('UTC')).toEqual({
      year: Number(key.slice(0, 4)),
      month: Number(key.slice(5, 7)) - 1,
    });
  });
});

describe('getItemDayKey', () => {
  const estimate = new Date('2026-10-30T09:00:00.000Z');

  it('places queued posts on their estimate day, or nowhere without one', () => {
    expect(getItemDayKey(item({ status: 'queued' }), estimate, 'UTC')).toBe('2026-10-30');
    expect(getItemDayKey(item({ status: 'queued' }), null, 'UTC')).toBeNull();
  });

  it('places published posts on the published day, falling back to updatedAt', () => {
    expect(
      getItemDayKey(
        item({ status: 'published', publishedAt: '2026-10-27T09:00:00.000Z' }),
        null,
        'UTC'
      )
    ).toBe('2026-10-27');
    expect(
      getItemDayKey(item({ status: 'published', publishedAt: null }), null, 'UTC')
    ).toBe('2026-10-28');
  });

  it('places failed and other statuses on their last-update day', () => {
    expect(getItemDayKey(item({ status: 'failed' }), null, 'UTC')).toBe('2026-10-28');
    expect(getItemDayKey(item({ status: 'cancelled' }), null, 'UTC')).toBe('2026-10-28');
  });
});

describe('getItemSortInstant', () => {
  it('sorts by estimate for queued, publishedAt for published, updatedAt otherwise', () => {
    const estimate = new Date('2026-10-30T09:00:00.000Z');
    expect(getItemSortInstant(item({ status: 'queued' }), estimate)).toEqual(estimate);
    expect(getItemSortInstant(item({ status: 'queued' }), null)).toBeNull();
    expect(
      getItemSortInstant(
        item({ status: 'published', publishedAt: '2026-10-27T09:00:00.000Z' }),
        null
      )?.toISOString()
    ).toBe('2026-10-27T09:00:00.000Z');
    expect(
      getItemSortInstant(item({ status: 'failed' }), null)?.toISOString()
    ).toBe('2026-10-28T07:00:00.000Z');
  });
});
