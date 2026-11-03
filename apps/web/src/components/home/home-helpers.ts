/**
 * Tenant Home — pure derivation helpers (client-safe, no server imports).
 *
 * Everything here is a pure function over already-fetched data so the
 * rules below are unit-testable without a database:
 *
 * - Days left: a CALENDAR-day difference in local time, never a
 *   round-up. On the final calendar day of a period the answer is 0
 *   ("Expires today"), not 1. (The old ceil-based count would show
 *   "1 day left" on the final day.)
 * - Quick links: the redesigned Home links. Paid: Media Library,
 *   Creator Finder, Facebook Accounts, Facebook Schedule, Billing — in
 *   that order. Free: Prompt Library and Billing only. Queue and
 *   Calendar are deliberately absent: Home carries no queue or post
 *   data at all.
 * - Plan state is derived by the loader from the entitlement, not
 *   here. The old dashboard's plan-state, setup-checklist and
 *   needs-attention helpers were deleted with the sections that
 *   rendered them (2026-11-02 Home redesign) — no dead exports.
 */

import {
  subscriptionUnitLabel,
  type PlatformCounts,
  type SubscriptionPlatform,
} from '@fbuploadpro/contracts';

function localCalendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Calendar days left until expiry, floored at 0 (0 = expires today). */
export function daysLeftUntil(endsAt: Date, now: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((localCalendarDay(endsAt) - localCalendarDay(now)) / msPerDay));
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "Monday, 2 November 2026" — the Home header eyebrow, local calendar. */
export function formatHeaderDate(date: Date): string {
  return `${WEEKDAYS[date.getDay()]}, ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** "Wednesday, 2 December 2026" — the Paid plan card period line. */
export function formatExpiryDateLong(endsAt: Date): string {
  return `${WEEKDAYS[endsAt.getDay()]}, ${endsAt.getDate()} ${MONTHS[endsAt.getMonth()]} ${endsAt.getFullYear()}`;
}

export interface HomeQuickLink {
  label: string;
  href: string;
}

/**
 * Paid quick links, in the approved order. Queue and Calendar are
 * deliberately absent: Home carries no queue or post data at all.
 * Prompt Library is absent too — it is already the header action.
 */
export function buildPaidQuickLinks(args: {
  mediaHref: string;
  creatorFinderHref: string;
  accountsHref: string;
  pagesHref: string;
  billingHref: string;
}): HomeQuickLink[] {
  return [
    { label: 'Media Library', href: args.mediaHref },
    { label: 'Creator Finder', href: args.creatorFinderHref },
    { label: 'Facebook Accounts', href: args.accountsHref },
    { label: 'Facebook Schedule', href: args.pagesHref },
    { label: 'Billing', href: args.billingHref },
  ];
}

/** Free users only ever link to sections the free plan allows. */
export function buildFreeQuickLinks(args: {
  promptsHref: string;
  billingHref: string;
}): HomeQuickLink[] {
  return [
    { label: 'Prompt Library', href: args.promptsHref },
    { label: 'Billing', href: args.billingHref },
  ];
}

export interface HomePlatformRow {
  platform: SubscriptionPlatform;
  label: string;
  unitLabel: 'pages' | 'accounts';
  count: number;
}

/**
 * Per-platform plan rows for the Paid plan card, in the approved
 * mockup order (Facebook, Instagram, Threads, TikTok, YouTube, X).
 * Zero rows are kept: the card shows every platform, including X at 0.
 * The counts always sum to totalUnits(counts) — the loader sets units
 * from the same period counts, so the card can never show a split
 * that disagrees with its headline total.
 */
export const HOME_PLATFORM_ORDER: SubscriptionPlatform[] = [
  'facebook',
  'instagram',
  'threads',
  'tiktok',
  'youtube',
  'x',
];

const PLATFORM_LABELS: Record<SubscriptionPlatform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
  x: 'X',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

export function buildPaidPlanPlatformRows(counts: PlatformCounts): HomePlatformRow[] {
  return HOME_PLATFORM_ORDER.map((platform) => ({
    platform,
    label: PLATFORM_LABELS[platform],
    unitLabel: subscriptionUnitLabel(platform),
    count: counts[platform],
  }));
}

export function paidPlanPlatformTotal(rows: HomePlatformRow[]): number {
  return rows.reduce((sum, row) => sum + row.count, 0);
}
