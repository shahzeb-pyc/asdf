/**
 * @file instagram-schedule-helpers.test.ts
 * @description Behavioural unit tests for the Instagram Schedule server
 * helpers (lib/server/instagram-schedule.ts): the membership flag,
 * status priority, addability, timezone validation, slot-format
 * normalisation, posting-times validation, cap hook, wire mapping,
 * and metadata parsing. These helpers are the Schedule section's
 * server-side contract — a regression here misroutes posts or hides
 * accounts — so each rule is pinned by a case, including the
 * malformed-metadata path, which must surface server-side (not
 * swallow) while still yielding null to callers.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

import { logServerError } from '@/lib/server-analytics';
import {
  checkScheduleCap,
  isAddableInstagramAccount,
  isPausedDestination,
  isScheduledDestination,
  isValidTimezone,
  mapDestinationToScheduleItem,
  normalizeScheduleSlotFormats,
  parseDestinationMetadata,
  scheduleStatusFor,
  validateSchedulePostingTimes,
} from '@/lib/server/instagram-schedule';

const mockedLog = vi.mocked(logServerError);

beforeEach(() => {
  mockedLog.mockClear();
});

describe('isScheduledDestination / isPausedDestination', () => {
  it('reads the scheduled flag only when it is exactly true', () => {
    expect(isScheduledDestination({ scheduled: true })).toBe(true);
    expect(isScheduledDestination({ scheduled: false })).toBe(false);
    expect(isScheduledDestination({ scheduled: 'yes' })).toBe(false);
    expect(isScheduledDestination({})).toBe(false);
    expect(isScheduledDestination(null)).toBe(false);
    expect(isScheduledDestination(undefined)).toBe(false);
  });

  it('reads the paused flag only when it is exactly "paused"', () => {
    expect(isPausedDestination({ schedule_paused: 'paused' })).toBe(true);
    expect(isPausedDestination({ schedule_paused: 'resumed' })).toBe(false);
    expect(isPausedDestination({})).toBe(false);
    expect(isPausedDestination(null)).toBe(false);
  });
});

describe('scheduleStatusFor priority', () => {
  const base = { status: 'active' as const, metadata: {} };

  it('paused wins over every other signal', () => {
    expect(
      scheduleStatusFor(
        { status: 'disconnected', metadata: { schedule_paused: 'paused' } },
        { status: 'expired', token_expires_at: '2020-01-01T00:00:00.000Z' }
      )
    ).toBe('paused');
  });

  it('an expired account status means expired', () => {
    expect(
      scheduleStatusFor(base, {
        status: 'expired',
        token_expires_at: '2999-01-01T00:00:00.000Z',
      })
    ).toBe('expired');
  });

  it('a past token expiry means expired even with an active status', () => {
    expect(
      scheduleStatusFor(base, {
        status: 'active',
        token_expires_at: '2020-01-01T00:00:00.000Z',
      })
    ).toBe('expired');
  });

  it('a future token keeps an active destination active', () => {
    expect(
      scheduleStatusFor(base, {
        status: 'active',
        token_expires_at: '2999-01-01T00:00:00.000Z',
      })
    ).toBe('active');
  });

  it('an unparseable token date is not treated as expired', () => {
    expect(
      scheduleStatusFor(base, { status: 'active', token_expires_at: 'not-a-date' })
    ).toBe('active');
  });

  it('a disconnected destination with no account problem is disconnected', () => {
    expect(
      scheduleStatusFor({ status: 'disconnected', metadata: {} }, null)
    ).toBe('disconnected');
  });

  it('a live destination with no account row is active', () => {
    expect(scheduleStatusFor(base, null)).toBe('active');
  });
});

describe('isAddableInstagramAccount', () => {
  it('accepts an active account with no expiry recorded', () => {
    expect(isAddableInstagramAccount({ status: 'active' })).toBe(true);
  });

  it('accepts an active account with a future token', () => {
    expect(
      isAddableInstagramAccount({
        status: 'active',
        token_expires_at: '2999-01-01T00:00:00.000Z',
      })
    ).toBe(true);
  });

  it('rejects an active account with a past token', () => {
    expect(
      isAddableInstagramAccount({
        status: 'active',
        token_expires_at: '2020-01-01T00:00:00.000Z',
      })
    ).toBe(false);
  });

  it('rejects non-active accounts regardless of token', () => {
    expect(
      isAddableInstagramAccount({
        status: 'expired',
        token_expires_at: '2999-01-01T00:00:00.000Z',
      })
    ).toBe(false);
    expect(
      isAddableInstagramAccount({
        status: 'revoked',
        token_expires_at: '2999-01-01T00:00:00.000Z',
      })
    ).toBe(false);
  });

  it('rejects an unparseable token date', () => {
    expect(
      isAddableInstagramAccount({ status: 'active', token_expires_at: 'junk' })
    ).toBe(false);
  });
});

describe('isValidTimezone', () => {
  it('accepts real IANA names and rejects the rest', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Asia/Karachi')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('x'.repeat(101))).toBe(false);
  });
});

describe('normalizeScheduleSlotFormats', () => {
  it('defaults an omitted list to Photo/Reel/Carousel', () => {
    expect(normalizeScheduleSlotFormats(undefined)).toEqual({
      formats: ['image', 'reel', 'carousel'],
    });
  });

  it('passes Instagram formats through, including video for scheduler matching', () => {
    expect(normalizeScheduleSlotFormats(['image', 'video'])).toEqual({
      formats: ['image', 'video'],
    });
  });

  it('rejects text, story, and unknown formats with a plain message', () => {
    for (const bad of ['text', 'story', 'poll']) {
      const result = normalizeScheduleSlotFormats([bad]);
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain(bad);
    }
  });
});

describe('validateSchedulePostingTimes', () => {
  it('accepts a valid batch and rejects duplicates and bad times', () => {
    expect(validateSchedulePostingTimes([{ time: '09:00' }])).toBeNull();
    expect(validateSchedulePostingTimes([])).toBeNull();
    const duplicate = validateSchedulePostingTimes([
      { time: '09:00' },
      { time: '09:00' },
    ]);
    expect(duplicate).toContain('used more than once');
    expect(validateSchedulePostingTimes([{ time: 'not-a-time' }])).not.toBeNull();
  });
});

describe('checkScheduleCap', () => {
  it('allows any count while no cap is configured', () => {
    expect(checkScheduleCap(0).allowed).toBe(true);
    expect(checkScheduleCap(1000).allowed).toBe(true);
  });
});

describe('mapDestinationToScheduleItem', () => {
  it('maps snake_case rows with account fields and live status', () => {
    const item = mapDestinationToScheduleItem(
      {
        id: 'dest-1',
        account_id: 'acc-1',
        timezone: 'Asia/Karachi',
        status: 'active',
        metadata: { scheduled: true, account_type: 'Creator' },
        name: 'Fallback Name',
        handle: 'shop',
        avatar_url: 'https://example.com/dest.png',
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-02T00:00:00.000Z',
      },
      {
        id: 'acc-1',
        display_name: 'Shop',
        avatar_url: 'https://example.com/acc.png',
        status: 'active',
        token_expires_at: '2999-01-01T00:00:00.000Z',
      },
      3,
      { queued: 5, posted: 2, failed: 1 }
    );
    expect(item.id).toBe('dest-1');
    expect(item.accountId).toBe('acc-1');
    expect(item.accountDisplayName).toBe('Shop');
    expect(item.accountAvatarUrl).toBe('https://example.com/acc.png');
    expect(item.handle).toBe('shop');
    expect(item.accountType).toBe('Creator');
    expect(item.status).toBe('active');
    expect(item.timezone).toBe('Asia/Karachi');
    expect(item.slotCount).toBe(3);
    expect(item.counts).toEqual({ queued: 5, posted: 2, failed: 1 });
    expect(item.createdAt).toBe('2026-10-01T00:00:00.000Z');
    expect(item.updatedAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('falls back without an account row and defaults timezone and name', () => {
    const item = mapDestinationToScheduleItem(
      {
        id: 'dest-2',
        status: 'disconnected',
        metadata: { scheduled: true },
        name: 'Dest Name',
      },
      null,
      0,
      { queued: 0, posted: 0, failed: 0 }
    );
    expect(item.accountId).toBe('');
    expect(item.accountDisplayName).toBe('Dest Name');
    expect(item.accountAvatarUrl).toBeNull();
    expect(item.accountType).toBeNull();
    expect(item.status).toBe('disconnected');
    expect(item.timezone).toBe('UTC');
    expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(item.updatedAt))).toBe(false);
  });

  it('accepts camelCase rows and Date timestamps', () => {
    const item = mapDestinationToScheduleItem(
      {
        id: 'dest-3',
        accountId: 'acc-9',
        timezone: '',
        status: 'active',
        metadata: { scheduled: true, accountType: 'Business' },
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
        updatedAt: new Date('2026-10-04T00:00:00.000Z'),
      },
      { id: 'acc-9', displayName: 'Camel', status: 'active' },
      1,
      { queued: 0, posted: 0, failed: 0 }
    );
    expect(item.accountId).toBe('acc-9');
    expect(item.accountDisplayName).toBe('Camel');
    expect(item.accountType).toBe('Business');
    expect(item.timezone).toBe('UTC');
    expect(item.createdAt).toBe('2026-10-03T00:00:00.000Z');
    expect(item.updatedAt).toBe('2026-10-04T00:00:00.000Z');
  });
});

describe('parseDestinationMetadata', () => {
  it('passes objects through and rejects nullish and scalar input', () => {
    const obj = { scheduled: true };
    expect(parseDestinationMetadata(obj)).toBe(obj);
    expect(parseDestinationMetadata(null)).toBeNull();
    expect(parseDestinationMetadata(undefined)).toBeNull();
    expect(parseDestinationMetadata(42)).toBeNull();
  });

  it('parses a JSON string and rejects a JSON scalar string', () => {
    expect(parseDestinationMetadata('{"scheduled":true}')).toEqual({
      scheduled: true,
    });
    expect(parseDestinationMetadata('"just-a-string"')).toBeNull();
  });

  it('yields null for malformed JSON but surfaces the failure server-side', () => {
    expect(parseDestinationMetadata('{not json')).toBeNull();
    expect(mockedLog).toHaveBeenCalledTimes(1);
    expect(mockedLog.mock.calls[0]?.[0]).toContain('malformed destination metadata');
  });
});
