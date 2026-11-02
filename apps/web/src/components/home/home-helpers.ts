/**
 * Tenant Home — pure derivation helpers (client-safe, no server imports).
 *
 * Everything here is a pure function over already-fetched data so the
 * rules below are unit-testable without a database:
 *
 * - Plan state: admin first, then paid-active, then expired (a lapsed
 *   period — paid-but-inactive, or no active period with a prior one),
 *   then free (never paid). Mirrors the sidebar plan word.
 * - Days left: a CALENDAR-day difference in local time, never a
 *   round-up. On the final calendar day of a period the answer is 0
 *   ("Expires today"), not 1. (The old ceil-based count would show
 *   "1 day left" on the final day.)
 * - Setup checklist (paid users only, retained for its tests; the
 *   redesigned Home no longer renders it): connect an account, add a
 *   first page, set posting times. Hidden once every step is done.
 * - Needs-attention reasons: the six wire page statuses mapped to
 *   plain-language reasons. Page status only — never queue/post data.
 * - Quick links: the redesigned Home links. Paid: Media Library,
 *   Creator Finder, Facebook Accounts, Facebook Pages, Billing — in
 *   that order. Free: Prompt Library and Billing only. Queue and
 *   Calendar are deliberately absent: Home carries no queue or post
 *   data at all.
 */

import {
  subscriptionUnitLabel,
  type PlatformCounts,
  type SubscriptionPlatform,
} from '@fbuploadpro/contracts';

export type HomePlanState = 'paid' | 'expired' | 'free' | 'admin';

export function deriveHomePlanState(args: {
  role: string;
  plan: 'free' | 'paid';
  active: boolean;
  hasPriorPeriod: boolean;
}): HomePlanState {
  if (args.role === 'admin') return 'admin';
  if (args.plan === 'paid' && args.active) return 'paid';
  if (args.plan === 'paid' || args.hasPriorPeriod) return 'expired';
  return 'free';
}

function localCalendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Calendar days left until expiry, floored at 0 (0 = expires today). */
export function daysLeftUntil(endsAt: Date, now: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((localCalendarDay(endsAt) - localCalendarDay(now)) / msPerDay));
}

/** At or under this many days left, the paid banner prompts renewal. */
export const EXPIRING_SOON_DAYS = 7;

export function formatExpiryDate(endsAt: Date): string {
  return endsAt.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
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

export interface HomeChecklistStep {
  id: 'account' | 'page' | 'posting-times';
  label: string;
  done: boolean;
  href: string;
}

export function buildChecklist(args: {
  accountsCount: number;
  totalDestinations: number;
  hasActiveSlot: boolean;
  accountsHref: string;
  pagesHref: string;
  postingTimesHref: string;
}): HomeChecklistStep[] {
  return [
    {
      id: 'account',
      label: 'Connect an account',
      done: args.accountsCount > 0,
      href: args.accountsHref,
    },
    {
      id: 'page',
      label: 'Add your first page',
      done: args.totalDestinations > 0,
      href: args.pagesHref,
    },
    {
      id: 'posting-times',
      label: 'Set posting times',
      done: args.hasActiveSlot,
      href: args.postingTimesHref,
    },
  ];
}

export function isChecklistComplete(steps: HomeChecklistStep[]): boolean {
  return steps.length > 0 && steps.every((step) => step.done);
}

/** Wire page statuses (see lib/server/facebook-wire.ts). */
export type HomeAttentionStatus =
  | 'paused'
  | 'fb_rate_limited'
  | 'page_checkpoint'
  | 'invalid_token'
  | 'disconnected';

const ATTENTION_REASONS: Record<HomeAttentionStatus, string> = {
  paused: 'Paused',
  fb_rate_limited: 'Facebook rate limit',
  page_checkpoint: 'Facebook checkpoint — action needed',
  invalid_token: 'Session expired — reconnect the account',
  disconnected: 'Disconnected',
};

export function attentionReason(status: HomeAttentionStatus): string {
  return ATTENTION_REASONS[status];
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
    { label: 'Facebook Pages', href: args.pagesHref },
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
