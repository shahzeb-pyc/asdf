import { describe, expect, it } from 'vitest';
import {
  AduAccountBulkCreateSchema,
  AduAccountCreateConfigSchema,
  AduBulkCreateSchema,
  AduBulkItemScheduleSchema,
  AduCreateConfigSchema,
  AduTimezoneSchema,
  AduUpdateConfigSchema,
  aduDisplayStatus,
  generateDailyRandomTimes,
  isValidTimezone,
  parseAduBulkPaste,
  parseAduCsv,
  resolveAduBulkItemSchedule,
  sanitizeSourceIdentity,
  validateAduBulkFixedTimes,
} from '../src/domain/adu.js';

describe('ADU contracts', () => {
  it('sync state overrides page status until synced', () => {
    expect(aduDisplayStatus('active', 'processing')).toBe('Scraping reels');
    expect(aduDisplayStatus('active', 'error')).toBe('Source not found');
    expect(aduDisplayStatus('active', 'synced')).toBe('Active posting');
    expect(aduDisplayStatus('fb_rate_limited', 'synced')).toBe('Rate limited');
  });

  it('sanitises source identities like the old app', () => {
    expect(sanitizeSourceIdentity('instagram', '@creator')).toBe('creator');
    expect(sanitizeSourceIdentity('instagram', 'https://www.instagram.com/creator/')).toBe('creator');
    expect(sanitizeSourceIdentity('facebook', 'https://www.facebook.com/profile.php?id=123')).toBe('123');
    expect(sanitizeSourceIdentity('youtube', 'https://www.youtube.com/channel/UCabc')).toBe('UCabc');
  });

  it('bulk paste rejects >1000 lines wholesale and warns on duplicates', () => {
    const huge = Array.from({ length: 1001 }, (_, i) => `instagram|user${i}`).join('\n');
    const rejected = parseAduBulkPaste(huge, 'instagram');
    expect(rejected.sources).toHaveLength(0);
    expect(rejected.errors.length).toBeGreaterThan(0);

    const parsed = parseAduBulkPaste('instagram|ronaldo\ninstagram|ronaldo\nbad|nope\n# comment\n\n', 'instagram');
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]?.username).toBe('ronaldo');
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it('CSV matches by normalised page name and warns on bad rows', () => {
    const parsed = parseAduCsv('page_name,source_platform,source_username\nMy  Page,instagram,creator\nOther,unknown, x');
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.pageName).toBe('My Page');
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('daily random times are sorted, unique and in range', () => {
    const times = generateDailyRandomTimes(3);
    expect(times).toHaveLength(3);
    expect([...times].sort()).toEqual(times);
    for (const time of times) {
      expect(time).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    }
  });

  it('bulk per-item schedule takes precedence over the shared schedule', () => {
    const parsed = AduBulkCreateSchema.safeParse({
      items: [
        {
          destinationId: '11111111-1111-4111-a111-111111111111',
          sourcePlatform: 'instagram',
          sourceUsername: 'creator',
          schedule: { timezone: 'Europe/London', postsPerDay: 2, postingTimes: ['08:00', '20:00'] },
        },
        {
          destinationId: '22222222-2222-4222-a222-222222222222',
          sourcePlatform: 'tiktok',
          sourceUsername: 'dancer',
        },
      ],
      timezone: 'Asia/Karachi',
      postsPerDay: 1,
      scheduleType: 'fixed',
      postingTimes: ['09:00'],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(
      resolveAduBulkItemSchedule(parsed.data.items[0]!, parsed.data),
    ).toEqual({ timezone: 'Europe/London', postsPerDay: 2, postingTimes: ['08:00', '20:00'] });
    expect(
      resolveAduBulkItemSchedule(parsed.data.items[1]!, parsed.data),
    ).toEqual({ timezone: 'Asia/Karachi', postsPerDay: 1, postingTimes: ['09:00'] });
  });

  it('bulk fixed-times validation uses the old wording for shared and per-item schedules', () => {
    const base = {
      items: [
        {
          destinationId: '11111111-1111-4111-a111-111111111111',
          sourcePlatform: 'instagram',
          sourceUsername: 'creator',
        },
      ],
      timezone: 'Asia/Karachi',
      postsPerDay: 2,
      scheduleType: 'fixed' as const,
      postingTimes: ['09:00'],
    };
    expect(validateAduBulkFixedTimes(base)).toBe('Fixed posting requires 2 posting times.');
    const perItem = {
      ...base,
      postingTimes: ['09:00', '20:00'],
      items: [
        {
          destinationId: '11111111-1111-4111-a111-111111111111',
          sourcePlatform: 'instagram',
          sourceUsername: 'creator',
          schedule: { timezone: 'Asia/Karachi', postsPerDay: 3, postingTimes: ['09:00', ''] },
        },
      ],
    };
    expect(validateAduBulkFixedTimes(perItem)).toBe('Fixed posting requires 3 posting times.');
    const valid = {
      ...base,
      postingTimes: ['09:00', '20:00'],
      items: [
        {
          destinationId: '11111111-1111-4111-a111-111111111111',
          sourcePlatform: 'instagram',
          sourceUsername: 'creator',
          schedule: { timezone: 'Asia/Karachi', postsPerDay: 1, postingTimes: ['08:00'] },
        },
      ],
    };
    expect(validateAduBulkFixedTimes(valid)).toBeNull();
  });

  describe('AduTimezoneSchema (timezone guard)', () => {
    const DEST_ID = '11111111-1111-4111-a111-111111111111';
    const ACCT_ID = '22222222-2222-4222-a222-222222222222';

    it('isValidTimezone accepts real IANA names and rejects display names', () => {
      for (const tz of ['Asia/Karachi', 'America/New_York', 'Asia/Kolkata', 'Asia/Tokyo', 'UTC']) {
        expect(isValidTimezone(tz)).toBe(true);
      }
      // The exact strings that silently broke intake for days: Intl
      // throws RangeError for them, and localTimeInTimezone used to
      // swallow that as '00:00'.
      for (const tz of ['new york', 'New York', 'New york', 'india', 'not-a-zone', '']) {
        expect(isValidTimezone(tz)).toBe(false);
      }
    });

    it('AduTimezoneSchema rejects display names with a clear IANA error', () => {
      for (const tz of ['new york', 'india']) {
        const parsed = AduTimezoneSchema.safeParse(tz);
        expect(parsed.success).toBe(false);
        if (!parsed.success) {
          expect(parsed.error.issues[0]?.message).toContain('IANA timezone');
        }
      }
      expect(AduTimezoneSchema.safeParse('Asia/Karachi').success).toBe(true);
    });

    it('create schema rejects a display-name timezone and keeps the default', () => {
      const base = {
        destinationId: DEST_ID,
        sourcePlatform: 'tiktok' as const,
        sourceUsername: 'creator',
        postsPerDay: 1,
      };
      expect(AduCreateConfigSchema.safeParse({ ...base, timezone: 'new york' }).success).toBe(false);
      expect(AduCreateConfigSchema.safeParse({ ...base, timezone: 'india' }).success).toBe(false);
      const valid = AduCreateConfigSchema.safeParse({ ...base, timezone: 'Asia/Kolkata' });
      expect(valid.success).toBe(true);
      const defaulted = AduCreateConfigSchema.safeParse(base);
      expect(defaulted.success).toBe(true);
      if (defaulted.success) expect(defaulted.data.timezone).toBe('Asia/Karachi');
    });

    it('update schema rejects a display-name timezone and allows omitting it', () => {
      expect(AduUpdateConfigSchema.safeParse({ timezone: 'new york' }).success).toBe(false);
      expect(AduUpdateConfigSchema.safeParse({ timezone: 'Asia/Tokyo' }).success).toBe(true);
      expect(AduUpdateConfigSchema.safeParse({}).success).toBe(true);
    });

    it('bulk schemas reject a bad timezone in the shared and per-item schedules', () => {
      const item = {
        destinationId: DEST_ID,
        sourcePlatform: 'instagram' as const,
        sourceUsername: 'creator',
      };
      const shared = { items: [item], postsPerDay: 1 };
      expect(AduBulkCreateSchema.safeParse({ ...shared, timezone: 'new york' }).success).toBe(false);
      expect(
        AduBulkCreateSchema.safeParse({
          ...shared,
          timezone: 'Asia/Karachi',
          items: [{ ...item, schedule: { timezone: 'india', postsPerDay: 1 } }],
        }).success,
      ).toBe(false);
      expect(
        AduBulkItemScheduleSchema.safeParse({ timezone: 'New York', postsPerDay: 1 }).success,
      ).toBe(false);
      expect(
        AduBulkCreateSchema.safeParse({
          ...shared,
          timezone: 'America/New_York',
          items: [{ ...item, schedule: { timezone: 'Asia/Kolkata', postsPerDay: 1 } }],
        }).success,
      ).toBe(true);
    });

    it('account variants reject a display-name timezone too', () => {
      const base = {
        accountId: ACCT_ID,
        sourcePlatform: 'instagram' as const,
        sourceUsername: 'creator',
        postsPerDay: 1,
      };
      expect(AduAccountCreateConfigSchema.safeParse({ ...base, timezone: 'new york' }).success).toBe(
        false,
      );
      expect(
        AduAccountCreateConfigSchema.safeParse({ ...base, timezone: 'Asia/Karachi' }).success,
      ).toBe(true);
      expect(
        AduAccountBulkCreateSchema.safeParse({
          items: [{ accountId: ACCT_ID, sourcePlatform: 'instagram', sourceUsername: 'creator' }],
          timezone: 'india',
          postsPerDay: 1,
        }).success,
      ).toBe(false);
    });
  });
});
