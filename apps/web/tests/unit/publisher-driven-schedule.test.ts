/**
 * Publisher-driven posting-times scheduling (shared contracts module).
 *
 * These tests fail on any stored-time model: estimates come from
 * queue position + current active times, a missed time is lost, and
 * a post whose format no active time allows waits (null estimate)
 * instead of taking a time it does not fit.
 */
import { describe, expect, it } from 'vitest';
import {
  assignQueueEstimates,
  computeUnmatchedFormats,
  findDueSlots,
  itemSlotFormat,
} from '@fbuploadpro/contracts';

const UTC = 'UTC';
const NOW_BEFORE_8AM = new Date('2026-10-27T00:00:00.000Z');

function slot(id: string, timeOfDay: string, allowedFormats: string[], isActive = true) {
  return { id, timeOfDay, isActive, allowedFormats };
}

function posts(count: number, format = 'text') {
  return Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}`, format }));
}

describe('assignQueueEstimates', () => {
  it('spreads 10 posts over 10 days with one daily time', () => {
    const estimates = assignQueueEstimates({
      slots: [slot('s1', '08:00', ['text'])],
      timezone: UTC,
      posts: posts(10),
      now: NOW_BEFORE_8AM,
    });
    expect(estimates.get('p1')).toEqual(new Date('2026-10-27T08:00:00.000Z'));
    expect(estimates.get('p10')).toEqual(new Date('2026-11-05T08:00:00.000Z'));
  });

  it('spreads 10 posts over 5 days with two daily times', () => {
    const estimates = assignQueueEstimates({
      slots: [slot('s1', '08:00', ['text']), slot('s2', '20:00', ['text'])],
      timezone: UTC,
      posts: posts(10),
      now: NOW_BEFORE_8AM,
    });
    expect(estimates.get('p1')).toEqual(new Date('2026-10-27T08:00:00.000Z'));
    expect(estimates.get('p2')).toEqual(new Date('2026-10-27T20:00:00.000Z'));
    expect(estimates.get('p9')).toEqual(new Date('2026-10-31T08:00:00.000Z'));
    expect(estimates.get('p10')).toEqual(new Date('2026-10-31T20:00:00.000Z'));
  });

  it('applies per-time format rules with skip-ahead, and leaves unmatched posts at null', () => {
    const estimates = assignQueueEstimates({
      slots: [
        slot('reels', '08:00', ['reel']),
        slot('texts', '12:00', ['text']),
        slot('both', '18:00', ['text', 'reel']),
      ],
      timezone: UTC,
      posts: [
        { id: 't1', format: 'text' },
        { id: 'r1', format: 'reel' },
        { id: 'img1', format: 'image' },
        { id: 't2', format: 'text' },
        { id: 'r2', format: 'reel' },
      ],
      now: NOW_BEFORE_8AM,
    });
    // 08:00 reels time skips t1 and takes r1; 12:00 text time takes
    // t1; 18:00 both time takes the first fitting remainder (t2).
    expect(estimates.get('r1')).toEqual(new Date('2026-10-27T08:00:00.000Z'));
    expect(estimates.get('t1')).toEqual(new Date('2026-10-27T12:00:00.000Z'));
    expect(estimates.get('t2')).toEqual(new Date('2026-10-27T18:00:00.000Z'));
    // Next day: r2 at the reels time; img1 never fits any time.
    expect(estimates.get('r2')).toEqual(new Date('2026-10-28T08:00:00.000Z'));
    expect(estimates.get('img1')).toBeNull();
  });

  it('ignores inactive slots', () => {
    const estimates = assignQueueEstimates({
      slots: [
        slot('off', '08:00', ['text'], false),
        slot('on', '20:00', ['text']),
      ],
      timezone: UTC,
      posts: posts(1),
      now: new Date('2026-10-27T09:00:00.000Z'),
    });
    expect(estimates.get('p1')).toEqual(new Date('2026-10-27T20:00:00.000Z'));
  });

  it('treats a slot whose time already passed today as tomorrow (missed is lost)', () => {
    const estimates = assignQueueEstimates({
      slots: [slot('on', '08:00', ['text'])],
      timezone: UTC,
      posts: posts(1),
      now: new Date('2026-10-27T09:00:00.000Z'),
    });
    expect(estimates.get('p1')).toEqual(new Date('2026-10-28T08:00:00.000Z'));
  });

  it('returns null for every post when no active time exists', () => {
    const estimates = assignQueueEstimates({
      slots: [],
      timezone: UTC,
      posts: posts(3),
      now: NOW_BEFORE_8AM,
    });
    expect([...estimates.values()]).toEqual([null, null, null]);
  });

  it('moves estimates when times change (nothing is stored)', () => {
    const before = assignQueueEstimates({
      slots: [slot('s1', '08:00', ['text'])],
      timezone: UTC,
      posts: posts(2),
      now: NOW_BEFORE_8AM,
    });
    const after = assignQueueEstimates({
      slots: [slot('s1', '08:00', ['text']), slot('s2', '20:00', ['text'])],
      timezone: UTC,
      posts: posts(2),
      now: NOW_BEFORE_8AM,
    });
    expect(before.get('p2')).toEqual(new Date('2026-10-28T08:00:00.000Z'));
    expect(after.get('p2')).toEqual(new Date('2026-10-27T20:00:00.000Z'));
  });
});

describe('findDueSlots', () => {
  it('reports a slot inside the claim window with the page-tz claim date', () => {
    const due = findDueSlots({
      slots: [slot('s1', '08:00', ['text'])],
      timezone: UTC,
      now: new Date('2026-10-27T08:03:00.000Z'),
      windowMinutes: 5,
    });
    expect(due).toHaveLength(1);
    expect(due[0]!.slot.id).toBe('s1');
    expect(due[0]!.claimDate).toBe('2026-10-27');
  });

  it('does not report a slot past the window (missed is lost, no catch-up)', () => {
    const due = findDueSlots({
      slots: [slot('s1', '08:00', ['text'])],
      timezone: UTC,
      now: new Date('2026-10-27T08:06:00.000Z'),
      windowMinutes: 5,
    });
    expect(due).toHaveLength(0);
  });

  it('does not report a future slot or an inactive slot', () => {
    const due = findDueSlots({
      slots: [slot('future', '09:00', ['text']), slot('off', '08:00', ['text'], false)],
      timezone: UTC,
      now: new Date('2026-10-27T08:03:00.000Z'),
      windowMinutes: 5,
    });
    expect(due).toHaveLength(0);
  });

  it('uses the page timezone, not UTC, for the occurrence and claim date', () => {
    // 08:02 in Asia/Karachi = 03:02 UTC.
    const due = findDueSlots({
      slots: [slot('s1', '08:00', ['text'])],
      timezone: 'Asia/Karachi',
      now: new Date('2026-10-27T03:02:00.000Z'),
      windowMinutes: 5,
    });
    expect(due).toHaveLength(1);
    expect(due[0]!.claimDate).toBe('2026-10-27');
  });
});

describe('computeUnmatchedFormats', () => {
  it('lists queued formats no active slot allows, in first-seen order', () => {
    expect(
      computeUnmatchedFormats({
        posts: [
          { id: 'a', format: 'text' },
          { id: 'b', format: 'image' },
          { id: 'c', format: 'reel' },
          { id: 'd', format: 'image' },
        ],
        slots: [slot('s1', '08:00', ['text']), slot('s2', '12:00', ['reel'])],
      })
    ).toEqual(['image']);
  });

  it('reports every queued format when no active time exists', () => {
    expect(
      computeUnmatchedFormats({
        posts: [
          { id: 'a', format: 'text' },
          { id: 'b', format: 'image' },
        ],
        slots: [],
      })
    ).toEqual(['text', 'image']);
  });
});

describe('itemSlotFormat', () => {
  it('prefers platform_format when it is a slot format, else kind', () => {
    expect(itemSlotFormat('video', 'reel')).toBe('reel');
    expect(itemSlotFormat('image', null)).toBe('image');
    expect(itemSlotFormat('video', null)).toBe('video');
    expect(itemSlotFormat('text', 'text')).toBe('text');
    expect(itemSlotFormat(null, null)).toBe('text');
  });
});
