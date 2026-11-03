import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { ZERO_PLATFORM_COUNTS, type EntitlementResponse } from '@fbuploadpro/contracts';
import { TopbarPlanPill, calendarDaysLeft } from './topbar-plan-pill';

const entitlementState = vi.hoisted(() => ({
  value: null as EntitlementResponse | null,
}));

vi.mock('@/components/billing/entitlement-provider', () => ({
  useSharedEntitlement: () => ({ entitlement: entitlementState.value }),
}));

function entitlement(partial: Partial<EntitlementResponse>): EntitlementResponse {
  return {
    plan: 'paid',
    active: true,
    counts: ZERO_PLATFORM_COUNTS,
    usage: ZERO_PLATFORM_COUNTS,
    periodEndsAt: null,
    periodStartsAt: null,
    canPost: true,
    readOnly: false,
    reason: null,
    hasPriorPeriod: true,
    ...partial,
  };
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function renderPill() {
  render(<TopbarPlanPill subdomain="creatorstack" useCleanPaths={false} />);
}

describe('TopbarPlanPill', () => {
  beforeEach(() => {
    entitlementState.value = null;
  });

  it('shows Paid with 12 days left and links to My Plan', () => {
    entitlementState.value = entitlement({
      active: true,
      periodEndsAt: addDays(new Date(), 12).toISOString(),
    });
    renderPill();
    const pill = screen.getByTestId('topbar-plan-pill');
    expect(pill).toHaveTextContent('12 days left');
    expect(pill).toHaveAttribute('href', '/tenant/creatorstack/my-plan');
  });

  // Regression (supersedes the old ml-auto tests): the pill itself must
  // NOT carry ml-auto. Two auto margins in one flex row split the free
  // space equally between them — that is what floated the merged pill
  // into the middle of the header in the owner's screenshot. Placement
  // is now owned by the pill+search cluster wrapper in user-shell.tsx,
  // which carries the row's single ml-auto; the pill sits immediately
  // left of the search with gap-2 only. jsdom does no layout, so this
  // class-absence check is the test-level guard for the pill side.
  it('does not carry ml-auto on the Paid pill (cluster wrapper owns placement)', () => {
    entitlementState.value = entitlement({
      active: true,
      periodEndsAt: addDays(new Date(), 12).toISOString(),
    });
    renderPill();
    expect(screen.getByTestId('topbar-plan-pill').className).not.toContain('ml-auto');
  });

  it('does not carry ml-auto on the Expired pill', () => {
    entitlementState.value = entitlement({ active: false, hasPriorPeriod: true, periodEndsAt: null });
    renderPill();
    expect(screen.getByTestId('topbar-plan-pill').className).not.toContain('ml-auto');
  });

  it('does not carry ml-auto on the Free pill', () => {
    entitlementState.value = entitlement({ active: false, hasPriorPeriod: false, periodEndsAt: null });
    renderPill();
    expect(screen.getByTestId('topbar-plan-pill').className).not.toContain('ml-auto');
  });

  it('is green with 29 days left (whole pill text, not just the number)', () => {
    entitlementState.value = entitlement({
      active: true,
      periodEndsAt: addDays(new Date(), 29).toISOString(),
    });
    renderPill();
    const pill = screen.getByTestId('topbar-plan-pill');
    expect(pill).toHaveTextContent('29 days left');
    expect(pill.className).toContain('text-brand-emerald');
    expect(pill.className).not.toContain('text-signal-critical');
    expect(pill.className).not.toContain('text-brand-gold');
  });

  it('is green at exactly 7 days left (the rule is less than 7, not <= 7)', () => {
    entitlementState.value = entitlement({
      active: true,
      periodEndsAt: addDays(new Date(), 7).toISOString(),
    });
    renderPill();
    const pill = screen.getByTestId('topbar-plan-pill');
    expect(pill).toHaveTextContent('7 days left');
    expect(pill.className).toContain('text-brand-emerald');
    expect(pill.className).not.toContain('text-signal-critical');
  });

  it('is red with 6 days left', () => {
    entitlementState.value = entitlement({
      active: true,
      periodEndsAt: addDays(new Date(), 6).toISOString(),
    });
    renderPill();
    const pill = screen.getByTestId('topbar-plan-pill');
    expect(pill).toHaveTextContent('6 days left');
    expect(pill.className).toContain('text-signal-critical');
    expect(pill.className).not.toContain('text-brand-emerald');
  });

  it('is red on the final day (Expires today is under 7 days)', () => {
    const today = new Date();
    const endsToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59);
    entitlementState.value = entitlement({ active: true, periodEndsAt: endsToday.toISOString() });
    renderPill();
    const pill = screen.getByTestId('topbar-plan-pill');
    expect(pill).toHaveTextContent('Expires today');
    expect(pill.className).toContain('text-signal-critical');
    expect(pill.className).not.toContain('text-brand-emerald');
  });

  it('is red in the phone short form with 5 days left', () => {
    entitlementState.value = entitlement({
      active: true,
      periodEndsAt: addDays(new Date(), 5).toISOString(),
    });
    renderPill();
    const pill = screen.getByTestId('topbar-plan-pill');
    expect(pill).toHaveTextContent('5d left');
    expect(pill.className).toContain('text-signal-critical');
    expect(pill.className).not.toContain('text-brand-emerald');
  });

  it('keeps Expired red', () => {
    entitlementState.value = entitlement({ active: false, hasPriorPeriod: true, periodEndsAt: null });
    renderPill();
    expect(screen.getByTestId('topbar-plan-pill').className).toContain('text-signal-critical');
  });

  it('keeps Upgrade gold', () => {
    entitlementState.value = entitlement({ active: false, hasPriorPeriod: false, periodEndsAt: null });
    renderPill();
    expect(screen.getByTestId('topbar-plan-pill').className).toContain('text-brand-gold');
  });

  it('shows Expires today on the final calendar day, not 1 day left', () => {
    const today = new Date();
    const endsToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59);
    entitlementState.value = entitlement({ active: true, periodEndsAt: endsToday.toISOString() });
    renderPill();
    expect(screen.getByTestId('topbar-plan-pill')).toHaveTextContent('Expires today');
    expect(screen.getByTestId('topbar-plan-pill')).not.toHaveTextContent('1 day left');
  });

  it('shows Expired and links to My Plan', () => {
    entitlementState.value = entitlement({ active: false, hasPriorPeriod: true, periodEndsAt: null });
    renderPill();
    const pill = screen.getByTestId('topbar-plan-pill');
    expect(pill).toHaveTextContent('Expired');
    expect(pill).toHaveAttribute('href', '/tenant/creatorstack/my-plan');
  });

  it('shows Upgrade for Free and links to Purchase', () => {
    entitlementState.value = entitlement({ active: false, hasPriorPeriod: false, periodEndsAt: null });
    renderPill();
    const pill = screen.getByTestId('topbar-plan-pill');
    expect(pill).toHaveTextContent('Upgrade');
    expect(pill).toHaveAttribute('href', '/tenant/creatorstack/purchase');
  });

  it('renders nothing when the entitlement is null (loading or failed check)', () => {
    entitlementState.value = null;
    const { container } = render(<TopbarPlanPill subdomain="creatorstack" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the phone short form for numeric counts', () => {
    entitlementState.value = entitlement({
      active: true,
      periodEndsAt: addDays(new Date(), 12).toISOString(),
    });
    renderPill();
    const short = screen.getByText('12d left');
    expect(short.className).toContain('sm:hidden');
    const full = screen.getByText('12 days left');
    expect(full.className).toContain('sm:inline');
  });

  it('shows Paid with no count when an active period has no end date', () => {
    entitlementState.value = entitlement({ active: true, periodEndsAt: null });
    renderPill();
    expect(screen.getByTestId('topbar-plan-pill')).toHaveTextContent('Paid');
    expect(screen.getByTestId('topbar-plan-pill')).not.toHaveTextContent('days left');
  });
});

describe('calendarDaysLeft', () => {
  it('counts whole calendar dates, so a same-day end is 0', () => {
    const today = new Date(2026, 10, 2, 9, 0);
    expect(calendarDaysLeft(new Date(2026, 10, 2, 23, 59).toISOString(), today)).toBe(0);
    expect(calendarDaysLeft(new Date(2026, 10, 14, 0, 5).toISOString(), today)).toBe(12);
    expect(calendarDaysLeft(new Date(2026, 10, 1, 23, 59).toISOString(), today)).toBe(-1);
  });
});
