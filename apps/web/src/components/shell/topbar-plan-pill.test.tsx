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
