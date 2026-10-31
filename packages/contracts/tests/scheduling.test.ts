import { describe, it, expect } from 'vitest';
import {
  assignQueueEstimates,
  computeUnmatchedFormats,
  findDueSlots,
  getZonedDateParts,
  itemSlotFormat,
  makeZonedDate,
  parseTimeOfDay,
  resolveValidTimezone,
  slotMatchesFormat,
  zonedDateString,
  type PostingSlotInput,
  type QueuedPostInput,
} from '../src/scheduling';

const slot = (
  overrides: Partial<PostingSlotInput> & { id: string },
): PostingSlotInput => ({
  timeOfDay: '12:00',
  isActive: true,
  allowedFormats: null,
  ...overrides,
});

const post = (id: string, format: string): QueuedPostInput => ({ id, format });

describe('itemSlotFormat', () => {
  it('passes reel/text/story platform formats through', () => {
    expect(itemSlotFormat('video', 'reel')).toBe('reel');
    expect(itemSlotFormat(null, 'text')).toBe('text');
    expect(itemSlotFormat('image', 'story')).toBe('story');
  });

  it('falls back to kind for image/video', () => {
    expect(itemSlotFormat('image', null)).toBe('image');
    expect(itemSlotFormat('video', undefined)).toBe('video');
  });

  it('passes other non-empty kinds through and defaults empty kinds to text', () => {
    expect(itemSlotFormat('carousel', null)).toBe('carousel');
    expect(itemSlotFormat('', null)).toBe('text');
    expect(itemSlotFormat(null, null)).toBe('text');
    expect(itemSlotFormat(undefined, undefined)).toBe('text');
  });
});

describe('slotMatchesFormat', () => {
  it('matches everything for legacy null/undefined format lists', () => {
    expect(slotMatchesFormat('reel', null)).toBe(true);
    expect(slotMatchesFormat('reel', undefined)).toBe(true);
  });

  it('matches nothing for an empty format list', () => {
    expect(slotMatchesFormat('reel', [])).toBe(false);
  });

  it('checks membership for a non-empty list', () => {
    expect(slotMatchesFormat('reel', ['reel', 'text'])).toBe(true);
    expect(slotMatchesFormat('video', ['reel', 'text'])).toBe(false);
  });
});

describe('parseTimeOfDay', () => {
  it('parses HH:MM and HH:MM:SS', () => {
    expect(parseTimeOfDay('09:30')).toEqual({ hour: 9, minute: 30, second: 0 });
    expect(parseTimeOfDay('23:59:45')).toEqual({ hour: 23, minute: 59, second: 45 });
  });

  it('rejects malformed and out-of-range values', () => {
    expect(parseTimeOfDay('')).toBeNull();
    expect(parseTimeOfDay('9')).toBeNull();
    expect(parseTimeOfDay('1:2:3:4')).toBeNull();
    expect(parseTimeOfDay('ab:cd')).toBeNull();
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('12:60')).toBeNull();
    expect(parseTimeOfDay('12:00:60')).toBeNull();
    expect(parseTimeOfDay(' 12:30 ')).toEqual({ hour: 12, minute: 30, second: 0 });
  });
});

describe('resolveValidTimezone', () => {
  it('keeps valid zones and falls back to UTC otherwise', () => {
    expect(resolveValidTimezone('America/Chicago')).toBe('America/Chicago');
    expect(resolveValidTimezone(null)).toBe('UTC');
    expect(resolveValidTimezone(undefined)).toBe('UTC');
    expect(resolveValidTimezone('')).toBe('UTC');
    expect(resolveValidTimezone('Not/AZone')).toBe('UTC');
  });
});

describe('zoned date helpers', () => {
  it('round-trips a wall-clock time through makeZonedDate', () => {
    const d = makeZonedDate(2026, 3, 14, 9, 30, 0, 'UTC');
    expect(getZonedDateParts(d, 'UTC')).toMatchObject({
      year: 2026,
      month: 3,
      day: 14,
      hour: 9,
      minute: 30,
      second: 0,
    });
  });

  it('reports the zoned calendar date, not the UTC date', () => {
    // 02:00 UTC is 20:00 the previous day in Chicago.
    expect(zonedDateString(new Date('2026-01-15T02:00:00Z'), 'America/Chicago')).toBe(
      '2026-01-14',
    );
    expect(zonedDateString(new Date('2026-01-15T12:00:00Z'), 'UTC')).toBe('2026-01-15');
  });

  it('pads single- and double-digit months and days', () => {
    expect(zonedDateString(new Date('2026-12-25T12:00:00Z'), 'UTC')).toBe('2026-12-25');
    expect(zonedDateString(new Date('2026-01-05T12:00:00Z'), 'UTC')).toBe('2026-01-05');
  });
});

describe('assignQueueEstimates', () => {
  const now = new Date('2026-01-15T10:00:00Z');

  it('spreads posts over following days in queue order', () => {
    const result = assignQueueEstimates({
      slots: [slot({ id: 's1', timeOfDay: '12:00' })],
      timezone: 'UTC',
      posts: [post('p1', 'text'), post('p2', 'text'), post('p3', 'text')],
      now,
    });
    expect(result.get('p1')).toEqual(new Date('2026-01-15T12:00:00Z'));
    expect(result.get('p2')).toEqual(new Date('2026-01-16T12:00:00Z'));
    expect(result.get('p3')).toEqual(new Date('2026-01-17T12:00:00Z'));
  });

  it('skips occurrences already past today', () => {
    const result = assignQueueEstimates({
      slots: [
        slot({ id: 's1', timeOfDay: '09:00' }),
        slot({ id: 's2', timeOfDay: '12:00' }),
      ],
      timezone: 'UTC',
      posts: [post('p1', 'text'), post('p2', 'text')],
      now,
    });
    expect(result.get('p1')).toEqual(new Date('2026-01-15T12:00:00Z'));
    expect(result.get('p2')).toEqual(new Date('2026-01-16T09:00:00Z'));
  });

  it('rolls estimates into the next month when every slot today has passed on the last day', () => {
    // The calendar E2E month-end case (Oct 31 after 10:00 UTC): both
    // daily slots have passed, so both estimates land on Nov 1. The
    // October grid ends Sat Oct 31 and holds no November cells, so
    // the calendar must show these on the November grid — the
    // estimates themselves are correct, not lost.
    const result = assignQueueEstimates({
      slots: [
        slot({ id: 's1', timeOfDay: '09:00' }),
        slot({ id: 's2', timeOfDay: '10:00' }),
      ],
      timezone: 'UTC',
      posts: [post('p1', 'text'), post('p2', 'text')],
      now: new Date('2026-10-31T10:30:00Z'),
    });
    expect(result.get('p1')).toEqual(new Date('2026-11-01T09:00:00Z'));
    expect(result.get('p2')).toEqual(new Date('2026-11-01T10:00:00Z'));
  });

  it('sorts slots that differ only in seconds by their second value', () => {
    const result = assignQueueEstimates({
      slots: [
        slot({ id: 's1', timeOfDay: '12:00:30' }),
        slot({ id: 's2', timeOfDay: '12:00:00' }),
      ],
      timezone: 'UTC',
      posts: [post('p1', 'text')],
      now,
    });
    expect(result.get('p1')).toEqual(new Date('2026-01-15T12:00:00Z'));
  });

  it('sorts slots by time of day regardless of input order', () => {
    const result = assignQueueEstimates({
      slots: [
        slot({ id: 's1', timeOfDay: '18:00' }),
        slot({ id: 's2', timeOfDay: '12:00' }),
        slot({ id: 's3', timeOfDay: '12:30' }),
      ],
      timezone: 'UTC',
      posts: [post('p1', 'text')],
      now,
    });
    expect(result.get('p1')).toEqual(new Date('2026-01-15T12:00:00Z'));
  });

  it('skips ahead past posts that do not fit a time', () => {
    const result = assignQueueEstimates({
      slots: [slot({ id: 's1', timeOfDay: '12:00', allowedFormats: ['reel'] })],
      timezone: 'UTC',
      posts: [post('p1', 'text'), post('p2', 'reel')],
      now,
    });
    expect(result.get('p2')).toEqual(new Date('2026-01-15T12:00:00Z'));
    expect(result.get('p1')).toBeNull();
  });

  it('maps posts with no matching time to null', () => {
    const result = assignQueueEstimates({
      slots: [slot({ id: 's1', timeOfDay: '12:00', allowedFormats: ['text'] })],
      timezone: 'UTC',
      posts: [post('p1', 'video')],
      now,
    });
    expect(result.get('p1')).toBeNull();
  });

  it('returns nulls when there are no active slots or no posts', () => {
    expect(
      assignQueueEstimates({
        slots: [slot({ id: 's1', isActive: false })],
        timezone: 'UTC',
        posts: [post('p1', 'text')],
        now,
      }).get('p1'),
    ).toBeNull();
    expect(
      assignQueueEstimates({
        slots: [slot({ id: 's1', timeOfDay: 'not-a-time' })],
        timezone: 'UTC',
        posts: [post('p1', 'text')],
        now,
      }).get('p1'),
    ).toBeNull();
    expect(
      assignQueueEstimates({ slots: [slot({ id: 's1' })], timezone: 'UTC', posts: [], now })
        .size,
    ).toBe(0);
  });

  it('treats a null format list as matching everything and an empty list as nothing', () => {
    const any = assignQueueEstimates({
      slots: [slot({ id: 's1', timeOfDay: '12:00', allowedFormats: null })],
      timezone: 'UTC',
      posts: [post('p1', 'video')],
      now,
    });
    expect(any.get('p1')).toEqual(new Date('2026-01-15T12:00:00Z'));
    const none = assignQueueEstimates({
      slots: [slot({ id: 's1', timeOfDay: '12:00', allowedFormats: [] })],
      timezone: 'UTC',
      posts: [post('p1', 'video')],
      now,
    });
    expect(none.get('p1')).toBeNull();
  });

  it('falls back to the current time for an invalid now', () => {
    const result = assignQueueEstimates({
      slots: [slot({ id: 's1', timeOfDay: '12:00' })],
      timezone: 'UTC',
      posts: [post('p1', 'text')],
      now: 'not a date' as unknown as Date,
    });
    expect(result.has('p1')).toBe(true);
  });

  it('fires times in the page timezone, not UTC', () => {
    const result = assignQueueEstimates({
      slots: [slot({ id: 's1', timeOfDay: '12:00' })],
      timezone: 'America/Chicago',
      posts: [post('p1', 'text')],
      now: new Date('2026-01-15T10:00:00Z'),
    });
    // Noon Chicago in January is 18:00 UTC.
    expect(result.get('p1')).toEqual(new Date('2026-01-15T18:00:00Z'));
  });
});

describe('findDueSlots', () => {
  const now = new Date('2026-01-15T12:03:00Z');

  it('reports slots whose occurrence is inside the claim window', () => {
    const due = findDueSlots({
      slots: [slot({ id: 's1', timeOfDay: '12:00' })],
      timezone: 'UTC',
      now,
    });
    expect(due).toHaveLength(1);
    expect(due[0]!.slot.id).toBe('s1');
    expect(due[0]!.claimDate).toBe('2026-01-15');
    expect(due[0]!.occurrence).toEqual(new Date('2026-01-15T12:00:00Z'));
  });

  it('drops missed times, future times, inactive slots, and bad times', () => {
    const due = findDueSlots({
      slots: [
        slot({ id: 'missed', timeOfDay: '11:00' }),
        slot({ id: 'future', timeOfDay: '12:30' }),
        slot({ id: 'paused', timeOfDay: '12:00', isActive: false }),
        slot({ id: 'bad', timeOfDay: 'xx:yy' }),
      ],
      timezone: 'UTC',
      now,
    });
    expect(due).toEqual([]);
  });

  it('honours a custom window', () => {
    expect(
      findDueSlots({
        slots: [slot({ id: 's1', timeOfDay: '12:00' })],
        timezone: 'UTC',
        now,
        windowMinutes: 1,
      }),
    ).toEqual([]);
    expect(
      findDueSlots({
        slots: [slot({ id: 's1', timeOfDay: '12:00' })],
        timezone: 'UTC',
        now,
        windowMinutes: 5,
      }),
    ).toHaveLength(1);
  });

  it('uses the page timezone for the occurrence and claim date', () => {
    const due = findDueSlots({
      slots: [slot({ id: 's1', timeOfDay: '06:00' })],
      timezone: 'America/Chicago',
      now: new Date('2026-01-15T12:03:00Z'),
    });
    expect(due).toHaveLength(1);
    expect(due[0]!.claimDate).toBe('2026-01-15');
    expect(due[0]!.occurrence).toEqual(new Date('2026-01-15T12:00:00Z'));
  });

  it('falls back to the current time for an invalid now', () => {
    const due = findDueSlots({
      slots: [slot({ id: 's1', timeOfDay: '12:00' })],
      timezone: 'UTC',
      now: 'not a date' as unknown as Date,
    });
    expect(Array.isArray(due)).toBe(true);
  });
});

describe('computeUnmatchedFormats', () => {
  it('lists formats no active slot allows, in first-seen order, deduplicated', () => {
    expect(
      computeUnmatchedFormats({
        posts: [post('p1', 'video'), post('p2', 'text'), post('p3', 'video')],
        slots: [slot({ id: 's1', timeOfDay: '12:00', allowedFormats: ['text'] })],
      }),
    ).toEqual(['video']);
  });

  it('returns empty when everything is covered or there are no posts', () => {
    expect(
      computeUnmatchedFormats({
        posts: [post('p1', 'text')],
        slots: [slot({ id: 's1', allowedFormats: null })],
      }),
    ).toEqual([]);
    expect(computeUnmatchedFormats({ posts: [], slots: [slot({ id: 's1' })] })).toEqual([]);
  });

  it('reports every format when no slot is active', () => {
    expect(
      computeUnmatchedFormats({
        posts: [post('p1', 'text'), post('p2', 'reel')],
        slots: [slot({ id: 's1', isActive: false })],
      }),
    ).toEqual(['text', 'reel']);
  });
});
