/**
 * Tenant Home — behavioural tests for the pure derivation rules.
 *
 * These pin the owner-approved Home contract without a database:
 * plan states (admin / paid / expired / free), setup-checklist
 * completion, needs-attention reasons, and — critically — the
 * no-queues-or-posts-data rule: paid quick links must never point
 * at Queue or Calendar, and free links must stay inside the sections
 * the free plan allows.
 */
import { describe, expect, it } from 'vitest';

import {
  attentionReason,
  buildChecklist,
  buildFreeQuickLinks,
  buildPaidQuickLinks,
  daysLeftUntil,
  deriveHomePlanState,
  isChecklistComplete,
} from '../src/components/home/home-helpers';

describe('deriveHomePlanState', () => {
  it('admin wins over any plan', () => {
    expect(
      deriveHomePlanState({ role: 'admin', plan: 'paid', active: true, hasPriorPeriod: true })
    ).toBe('admin');
    expect(
      deriveHomePlanState({ role: 'admin', plan: 'free', active: false, hasPriorPeriod: false })
    ).toBe('admin');
  });

  it('paid and active is paid', () => {
    expect(
      deriveHomePlanState({ role: 'user', plan: 'paid', active: true, hasPriorPeriod: true })
    ).toBe('paid');
  });

  it('a lapsed paid period is expired, not free', () => {
    expect(
      deriveHomePlanState({ role: 'user', plan: 'paid', active: false, hasPriorPeriod: true })
    ).toBe('expired');
  });

  it('no active period with a prior one is expired', () => {
    expect(
      deriveHomePlanState({ role: 'user', plan: 'free', active: false, hasPriorPeriod: true })
    ).toBe('expired');
  });

  it('never paid is free', () => {
    expect(
      deriveHomePlanState({ role: 'user', plan: 'free', active: false, hasPriorPeriod: false })
    ).toBe('free');
  });
});

describe('daysLeftUntil', () => {
  it('counts exact days, ceils partial days, floors at zero', () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    expect(daysLeftUntil(new Date('2026-11-11T12:00:00.000Z'), now)).toBe(10);
    expect(daysLeftUntil(new Date('2026-11-02T00:00:00.000Z'), now)).toBe(1);
    expect(daysLeftUntil(new Date('2026-11-01T12:00:00.000Z'), now)).toBe(0);
    expect(daysLeftUntil(new Date('2026-10-01T00:00:00.000Z'), now)).toBe(0);
  });
});

describe('setup checklist', () => {
  const hrefs = {
    accountsHref: '/tenant/acme/accounts',
    pagesHref: '/tenant/acme/pages',
    postingTimesHref: '/tenant/acme/pages',
  };

  it('is complete only when account, page, and slot all exist', () => {
    const complete = buildChecklist({
      accountsCount: 1,
      totalDestinations: 2,
      hasActiveSlot: true,
      ...hrefs,
    });
    expect(complete.map((step) => step.done)).toEqual([true, true, true]);
    expect(isChecklistComplete(complete)).toBe(true);

    const missingSlot = buildChecklist({
      accountsCount: 1,
      totalDestinations: 2,
      hasActiveSlot: false,
      ...hrefs,
    });
    expect(missingSlot[2]?.done).toBe(false);
    expect(isChecklistComplete(missingSlot)).toBe(false);
  });

  it('an account alone does not complete the page or slot steps', () => {
    const steps = buildChecklist({
      accountsCount: 1,
      totalDestinations: 0,
      hasActiveSlot: false,
      ...hrefs,
    });
    expect(steps.map((step) => step.done)).toEqual([true, false, false]);
  });

  it('steps link to their fix surfaces', () => {
    const steps = buildChecklist({
      accountsCount: 0,
      totalDestinations: 0,
      hasActiveSlot: false,
      ...hrefs,
    });
    expect(steps.map((step) => step.href)).toEqual([
      '/tenant/acme/accounts',
      '/tenant/acme/pages',
      '/tenant/acme/pages',
    ]);
  });
});

describe('needs-attention reasons', () => {
  it('maps every non-active wire status to plain language', () => {
    expect(attentionReason('paused')).toBe('Paused');
    expect(attentionReason('fb_rate_limited')).toBe('Facebook rate limit');
    expect(attentionReason('page_checkpoint')).toBe('Facebook checkpoint — action needed');
    expect(attentionReason('invalid_token')).toBe('Session expired — reconnect the account');
    expect(attentionReason('disconnected')).toBe('Disconnected');
  });
});

describe('quick links and the no-queue-data rule', () => {
  it('paid links cover the six allowed sections and never Queue or Calendar', () => {
    const links = buildPaidQuickLinks({
      pagesHref: '/tenant/acme/pages',
      accountsHref: '/tenant/acme/accounts',
      postingTimesHref: '/tenant/acme/pages/page-1?tab=calendar',
      mediaHref: '/tenant/acme/media',
      promptsHref: '/tenant/acme/prompts',
      billingHref: '/tenant/acme/billing',
    });
    expect(links.map((link) => link.label)).toEqual([
      'Pages',
      'Accounts',
      'Posting Times',
      'Media Library',
      'Prompt Library',
      'Billing',
    ]);
    // The Posting Times href legitimately carries ?tab=calendar (a page
    // tab id), so the ban is on Queue/Calendar sections, not the word.
    expect(links.some((link) => link.label === 'Queue')).toBe(false);
    expect(links.some((link) => link.label === 'Calendar')).toBe(false);
    expect(links.some((link) => link.label === 'Calendar View')).toBe(false);
    expect(links.some((link) => link.href.includes('/queue'))).toBe(false);
  });

  it('free links stay inside Prompt Library and Billing only', () => {
    const links = buildFreeQuickLinks({
      promptsHref: '/tenant/acme/prompts',
      billingHref: '/tenant/acme/billing',
    });
    expect(links.map((link) => link.label)).toEqual(['Prompt Library', 'Billing']);
  });
});
