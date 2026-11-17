/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { HomePaidData } from './home-data';
import {
  ExpiredBanner,
  FreePlanCard,
  HomeHeader,
  MuseAssistantCard,
  PaidPlanCard,
  QuickLinks,
  UpgradeCard,
} from './home-sections';

const GB = 1073741824;

const PAID_DATA: HomePaidData = {
  kind: 'paid',
  periodStartsAt: new Date(2026, 10, 2, 12, 0, 0),
  periodEndsAt: new Date(2026, 11, 2, 12, 0, 0),
  units: 21,
  platformCounts: {
    facebook: 12,
    instagram: 4,
    threads: 3,
    x: 0,
    tiktok: 1,
    youtube: 1,
  },
  storageUsedBytes: 0,
  storageQuotaBytes: 105 * GB,
};

function renderPaidPlanCard(data: HomePaidData = PAID_DATA) {
  return render(
    <PaidPlanCard
      data={data}
      billingHref="/tenant/acme/my-plan"
      billingPurchaseHref="/tenant/acme/purchase"
      paymentsHref="/tenant/acme/payments"
    />
  );
}

describe('PaidPlanCard', () => {
  it('shows the headline total, price from the same counts, and the per-platform split', () => {
    renderPaidPlanCard();
    expect(screen.getByText('21 pages or accounts')).toBeTruthy();
    expect(screen.getByText(/1,470 PKR \/ month/)).toBeTruthy();
    expect(screen.getByText(/70 PKR per page or account/)).toBeTruthy();
    expect(screen.getByText('Monthly plan · Unlimited posts')).toBeTruthy();
    expect(screen.getByText(/30-day period/)).toBeTruthy();
    expect(screen.getByText('12 pages')).toBeTruthy();
    expect(screen.getByText('4 accounts')).toBeTruthy();
    expect(screen.getByText('0 accounts')).toBeTruthy();
    expect(screen.getByText(/Ends Wednesday, 2 December 2026/)).toBeTruthy();
  });

  it('shows storage used of allowed with a 0% bar at zero usage', () => {
    renderPaidPlanCard();
    expect(screen.getByText(/0 GB of 105 GB/)).toBeTruthy();
    expect(screen.getByText(/105 GB remaining/)).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });

  it('shows a half-full bar at half usage', () => {
    renderPaidPlanCard({ ...PAID_DATA, storageUsedBytes: 52.5 * GB });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
  });

  it('shows unlimited rows and included features, and never the removed summary cards', () => {
    renderPaidPlanCard();
    expect(screen.getByText('Prompt Library')).toBeTruthy();
    expect(screen.getByText('Creator Finder')).toBeTruthy();
    // 3, not 2: the "Unlimited use" section title itself matches, plus the
    // two feature rows. A row added or removed changes this count.
    expect(screen.getAllByText('Unlimited use')).toHaveLength(3);
    expect(screen.getByText('Auto Download/Upload')).toBeTruthy();
    expect(screen.getByText('TikTok Repost')).toBeTruthy();
    expect(screen.getAllByText('Included')).toHaveLength(2);
    expect(screen.queryByText('Connected pages')).toBeNull();
    expect(screen.queryByText('Followers gained')).toBeNull();
  });

  it('links Renew, View My Plan and View Payments to their sections', () => {
    renderPaidPlanCard();
    expect(screen.getByRole('link', { name: 'Renew' }).getAttribute('href')).toBe(
      '/tenant/acme/purchase'
    );
    expect(screen.getByRole('link', { name: 'View My Plan' }).getAttribute('href')).toBe(
      '/tenant/acme/my-plan'
    );
    expect(screen.getByRole('link', { name: 'View Payments' }).getAttribute('href')).toBe(
      '/tenant/acme/payments'
    );
  });

  it('on the white-label brand the billing buttons become one Contact support link', () => {
    // Spec 191 Home buttons fix: there is no billing section on the
    // NextRise brand, so Renew / View My Plan / View Payments would
    // all be dead ends. The actions change to the brand's WhatsApp
    // support link, and the price / plan-length lines are hidden too
    // (they state our price and period, not theirs).
    const supportHref =
      'https://wa.me/923081311411?text=Hi!%20I%20need%20assistance%20with%20my%20NextRise%20account.';
    render(
      <PaidPlanCard
        data={PAID_DATA}
        billingHref="/tenant/acme/my-plan"
        billingPurchaseHref="/tenant/acme/purchase"
        paymentsHref="/tenant/acme/payments"
        supportHref={supportHref}
      />
    );
    expect(screen.queryByRole('link', { name: 'Renew' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'View My Plan' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'View Payments' })).toBeNull();
    const support = screen.getByRole('link', { name: 'Contact support' });
    expect(support.getAttribute('href')).toBe(supportHref);
    expect(support.getAttribute('target')).toBe('_blank');
    // Spec 191 Home buttons fix, round 2: the price and plan-length
    // lines state OUR price (70 PKR per unit) and OUR 30-day period.
    // NextRise students pay the friend a flat fee on 1/3/6-month
    // periods, so those lines must not render on their brand at all.
    // The true facts stay: the unit count and the real end date.
    expect(screen.getByText('21 pages or accounts')).toBeTruthy();
    expect(screen.queryByText(/1,470 PKR \/ month/)).toBeNull();
    expect(screen.queryByText(/70 PKR per page or account/)).toBeNull();
    expect(screen.queryByText('Monthly plan · Unlimited posts')).toBeNull();
    expect(screen.queryByText(/30-day period/)).toBeNull();
    expect(screen.getByText(/Ends Wednesday, 2 December 2026/)).toBeTruthy();
  });
});

describe('ExpiredBanner', () => {
  it('links Renew to Purchase on our brand', () => {
    render(<ExpiredBanner billingPurchaseHref="/tenant/acme/purchase" />);
    expect(screen.getByText('Your plan has expired')).toBeTruthy();
    expect(screen.getByText('Renew to post and schedule again.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Renew' }).getAttribute('href')).toBe(
      '/tenant/acme/purchase'
    );
    expect(screen.queryByRole('link', { name: 'Contact support' })).toBeNull();
  });

  it('on the white-label brand Renew becomes a WhatsApp Contact support link', () => {
    // Spec 191 Home buttons fix: the Purchase page does not exist on
    // the NextRise brand, so Renew would be a dead end. Renewals go
    // through the brand's WhatsApp support instead.
    const supportHref =
      'https://wa.me/923081311411?text=Hi!%20I%20need%20assistance%20with%20my%20NextRise%20account.';
    render(
      <ExpiredBanner billingPurchaseHref="/tenant/acme/purchase" supportHref={supportHref} />
    );
    expect(screen.getByText('Your plan has expired')).toBeTruthy();
    expect(screen.getByText('Contact support to renew your plan.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Renew' })).toBeNull();
    const support = screen.getByRole('link', { name: 'Contact support' });
    expect(support.getAttribute('href')).toBe(supportHref);
    expect(support.getAttribute('target')).toBe('_blank');
  });
});

describe('FreePlanCard and UpgradeCard', () => {
  it('free shows 0 PKR, Prompt Library included, and posting crossed out', () => {
    render(<FreePlanCard />);
    expect(screen.getByText('Free plan')).toBeTruthy();
    expect(screen.getByText('0 PKR')).toBeTruthy();
    expect(screen.getByText('Prompt Library')).toBeTruthy();
    expect(screen.getByText('Posting and scheduling')).toBeTruthy();
    // 6, not 3: each crossed row renders "Not included" twice — once
    // visibly as the row value, once as the sr-only mark label.
    // A row added or removed changes this count.
    expect(screen.getAllByText('Not included')).toHaveLength(6);
    expect(screen.queryByText('Facebook')).toBeNull();
  });

  it('upgrade shows Media Library as 5 GB per unit, never as unlimited', () => {
    render(<UpgradeCard billingPurchaseHref="/tenant/acme/purchase" billingHref="/tenant/acme/my-plan" />);
    expect(screen.getByText('Upgrade to Paid')).toBeTruthy();
    expect(screen.getByText('Media Library')).toBeTruthy();
    expect(screen.getByText('5 GB per page or account')).toBeTruthy();
    // Only Prompt Library and Creator Finder are unlimited; Media Library is capped.
    expect(screen.getAllByText('Unlimited use')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Upgrade' }).getAttribute('href')).toBe(
      '/tenant/acme/purchase'
    );
  });
});

describe('QuickLinks', () => {
  it('renders the given links in order', () => {
    render(
      <QuickLinks
        links={[
          { label: 'Media Library', href: '/tenant/acme/media' },
          { label: 'Creator Finder', href: '/tenant/acme/creator-finder' },
          { label: 'Facebook Accounts', href: '/tenant/acme/accounts' },
          { label: 'Facebook In-App Schedule', href: '/tenant/acme/inapp-schedule' },
          { label: 'Billing', href: '/tenant/acme/my-plan' },
        ]}
      />
    );
    // The chevron is a lucide SVG icon, not text, so link text is the
    // label alone — asserting "›" here was a matcher mistake, not a
    // rendering difference.
    expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
      'Media Library',
      'Creator Finder',
      'Facebook Accounts',
      'Facebook In-App Schedule',
      'Billing',
    ]);
  });
});

describe('HomeHeader and MuseAssistantCard', () => {
  it('header greets the workspace and links only to Prompt Library', () => {
    render(
      <HomeHeader
        workspaceName="Acme Corp"
        subheading="Your paid workspace is active and ready to post."
        promptsHref="/tenant/acme/prompts"
      />
    );
    expect(screen.getByText('Welcome, Acme Corp')).toBeTruthy();
    expect(screen.getByText('Your paid workspace is active and ready to post.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Prompt Library' }).getAttribute('href')).toBe(
      '/tenant/acme/prompts'
    );
  });

  it('Muse card links Ask Muse to the Muse section', () => {
    render(<MuseAssistantCard museHref="/tenant/acme/muse" />);
    expect(screen.getByText('Muse Assistant')).toBeTruthy();
    expect(
      screen.getByText('Ask Muse to schedule, publish, or check your pages — while you sleep.')
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: /Ask Muse/ }).getAttribute('href')).toBe(
      '/tenant/acme/muse'
    );
    expect(screen.queryByRole('button', { name: /Ask Muse/ })).toBeNull();
  });
});
