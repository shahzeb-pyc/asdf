/**
 * Tenant Home — behavioural tests for the redesigned Home helpers.
 * Pure functions only, no database, no rendering.
 */
import { describe, expect, it } from 'vitest';

import {
  buildFreeQuickLinks,
  buildPaidPlanPlatformRows,
  buildPaidQuickLinks,
  daysLeftUntil,
  formatExpiryDateLong,
  formatHeaderDate,
  paidPlanPlatformTotal,
} from './home-helpers';

const EXAMPLE_COUNTS = {
  facebook: 12,
  instagram: 4,
  threads: 3,
  x: 0,
  tiktok: 1,
  youtube: 1,
};

describe('daysLeftUntil', () => {
  it('counts calendar days, never rounds up, and is 0 on the final day', () => {
    // 2 November -> 2 December 2026 is 30 calendar days (the mockup example).
    expect(daysLeftUntil(new Date(2026, 11, 2, 9, 0, 0), new Date(2026, 10, 2, 12, 0, 0))).toBe(30);
    // Final calendar day — any time on 2 December against an end on 2 December is 0,
    // not 1 — the old ceil-based count would have shown "1 day left" here.
    expect(daysLeftUntil(new Date(2026, 11, 2, 23, 59, 0), new Date(2026, 11, 2, 12, 0, 0))).toBe(0);
    expect(daysLeftUntil(new Date(2026, 10, 3, 0, 0, 0), new Date(2026, 10, 2, 12, 0, 0))).toBe(1);
    expect(daysLeftUntil(new Date(2026, 10, 1, 0, 0, 0), new Date(2026, 10, 2, 12, 0, 0))).toBe(0);
  });
});

describe('header and expiry date formats', () => {
  it('formats the header eyebrow as weekday, day month year', () => {
    expect(formatHeaderDate(new Date(2026, 10, 2, 12, 0, 0))).toBe('Monday, 2 November 2026');
  });

  it('formats the period end as weekday, day month year', () => {
    expect(formatExpiryDateLong(new Date(2026, 11, 2, 12, 0, 0))).toBe(
      'Wednesday, 2 December 2026'
    );
  });
});

describe('paid plan platform rows', () => {
  it('lists platforms in mockup order with the right unit labels, including zeros', () => {
    const rows = buildPaidPlanPlatformRows(EXAMPLE_COUNTS);
    expect(rows.map((row) => row.label)).toEqual([
      'Facebook',
      'Instagram',
      'Threads',
      'TikTok',
      'YouTube',
      'X',
    ]);
    expect(rows.map((row) => row.unitLabel)).toEqual([
      'pages',
      'accounts',
      'accounts',
      'accounts',
      'accounts',
      'accounts',
    ]);
    expect(rows.map((row) => row.count)).toEqual([12, 4, 3, 1, 1, 0]);
  });

  it('sums to the headline total, so the split can never disagree with it', () => {
    expect(paidPlanPlatformTotal(buildPaidPlanPlatformRows(EXAMPLE_COUNTS))).toBe(21);
  });
});

describe('quick links and the no-queue-data rule', () => {
  it('paid links are exactly the five approved sections, in order', () => {
    const links = buildPaidQuickLinks({
      mediaHref: '/tenant/acme/media',
      creatorFinderHref: '/tenant/acme/creator-finder',
      accountsHref: '/tenant/acme/accounts',
      inAppScheduleHref: '/tenant/acme/inapp-schedule',
      billingHref: '/tenant/acme/my-plan',
    });
    expect(links.map((link) => link.label)).toEqual([
      'Media Library',
      'Creator Finder',
      'Facebook Accounts',
      'Facebook In-App Schedule',
      'Billing',
    ]);
    expect(links.map((link) => link.href)).toEqual([
      '/tenant/acme/media',
      '/tenant/acme/creator-finder',
      '/tenant/acme/accounts',
      '/tenant/acme/inapp-schedule',
      '/tenant/acme/my-plan',
    ]);
    expect(links.some((link) => link.label === 'Queue')).toBe(false);
    expect(links.some((link) => link.label === 'Calendar')).toBe(false);
    expect(links.some((link) => link.href.includes('/queue'))).toBe(false);
    expect(links.some((link) => link.label === 'Posting Times')).toBe(false);
  });

  it('free links stay inside Prompt Library and Billing only', () => {
    const links = buildFreeQuickLinks({
      promptsHref: '/tenant/acme/prompts',
      billingHref: '/tenant/acme/my-plan',
    });
    expect(links.map((link) => link.label)).toEqual(['Prompt Library', 'Billing']);
  });
});
