/**
 * formatFollowersUpdatedAt — shared "last updated" for stored
 * follower totals (spec 162).
 *
 * Null (never a faked time) when the timestamp is absent or
 * unparseable, or the timezone is not a supported IANA zone.
 */
import { describe, expect, it } from 'vitest';
import { formatFollowersUpdatedAt } from './format-followers-updated-at';

describe('formatFollowersUpdatedAt', () => {
  it('formats a valid timestamp in the given timezone', () => {
    // 22:00 UTC = 03:00 next day in Asia/Karachi (UTC+5).
    expect(formatFollowersUpdatedAt('2026-11-10T22:00:00.000Z', 'Asia/Karachi')).toBe(
      '11 Nov 2026, 03:00'
    );
  });

  it('returns null for a missing or unparseable timestamp', () => {
    expect(formatFollowersUpdatedAt(null, 'Asia/Karachi')).toBeNull();
    expect(formatFollowersUpdatedAt(undefined, 'Asia/Karachi')).toBeNull();
    expect(formatFollowersUpdatedAt('', 'Asia/Karachi')).toBeNull();
    expect(formatFollowersUpdatedAt('not-a-date', 'Asia/Karachi')).toBeNull();
  });

  it('returns null for an unsupported timezone instead of rendering in a wrong zone', () => {
    expect(
      formatFollowersUpdatedAt('2026-11-10T22:00:00.000Z', 'Mars/Olympus')
    ).toBeNull();
  });
});
