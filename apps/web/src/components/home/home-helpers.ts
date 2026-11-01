/**
 * Tenant Home — pure derivation helpers (client-safe, no server imports).
 *
 * Everything here is a pure function over already-fetched data so the
 * rules below are unit-testable without a database:
 *
 * - Plan state: admin first, then paid-active, then expired (a lapsed
 *   period — paid-but-inactive, or no active period with a prior one),
 *   then free (never paid). Mirrors the sidebar plan word.
 * - Setup checklist (paid users only): connect an account, add a first
 *   page, set posting times. Hidden once every step is done.
 * - Needs-attention reasons: the six wire page statuses mapped to
 *   plain-language reasons. Page status only — never queue/post data.
 * - Quick links: paid links deliberately exclude Queue and Calendar
 *   (owner constraint: no queues or posts data anywhere on Home).
 */

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

/** Whole days left until expiry, floored at 0 (0 = expires today). */
export function daysLeftUntil(endsAt: Date, now: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / msPerDay));
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
 * Paid quick links. Queue and Calendar are deliberately absent:
 * posting times live on a page's Posting Times tab, and Home carries
 * no queue or post data at all.
 */
export function buildPaidQuickLinks(args: {
  pagesHref: string;
  accountsHref: string;
  postingTimesHref: string;
  mediaHref: string;
  promptsHref: string;
  billingHref: string;
}): HomeQuickLink[] {
  return [
    { label: 'Pages', href: args.pagesHref },
    { label: 'Accounts', href: args.accountsHref },
    { label: 'Posting Times', href: args.postingTimesHref },
    { label: 'Media Library', href: args.mediaHref },
    { label: 'Prompt Library', href: args.promptsHref },
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
