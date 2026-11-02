'use client';

import React from 'react';
import Link from 'next/link';
import { useSharedEntitlement } from '@/components/billing/entitlement-provider';
import { planWordFromEntitlement } from '@/components/workspace/plan-word';
import { buildTenantHref } from '@/lib/tenant-href';

export interface TopbarPlanPillProps {
  subdomain: string;
  useCleanPaths?: boolean | undefined;
}

const MS_PER_DAY = 86_400_000;

/**
 * Calendar-day difference, in the client local timezone, between
 * today's calendar date and the period end's calendar date. A
 * wall-clock difference would round a final partial day up to
 * "1 day left"; the owner-approved final-day wording is
 * "Expires today", so only whole calendar dates are compared.
 * Returns null for an unparseable end date.
 */
export function calendarDaysLeft(periodEndsAt: string, today: Date = new Date()): number | null {
  const ends = new Date(periodEndsAt);
  if (Number.isNaN(ends.getTime())) return null;
  const startOfDay = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((startOfDay(ends) - startOfDay(today)) / MS_PER_DAY);
}

/**
 * Topbar plan pill — mounted in UserShell immediately left of the
 * ⌘K search button. It reads ONLY the EntitlementProvider's shared
 * entitlement state and derives the plan word with the SAME
 * planWordFromEntitlement function the sidebar header word
 * (UserHeaderWord) uses, so the pill and the sidebar can never
 * disagree, and no second fetch is made.
 *
 * Paid: "Paid · N days left", final calendar day "Paid · Expires
 * today", phone short form "Nd left" for numeric counts only.
 * Expired: "Expired". Free: "Upgrade". Null entitlement (loading
 * or a failed check that cleared the proven value): nothing — a
 * stale or placeholder count must never flash. Admin: nothing;
 * admins never render UserShell.
 */
export function TopbarPlanPill({
  subdomain,
  useCleanPaths = false,
}: Readonly<TopbarPlanPillProps>) {
  const { entitlement } = useSharedEntitlement();
  if (entitlement === null) return null;

  const planWord = planWordFromEntitlement(entitlement, false);
  if (planWord === null || planWord === 'Admin') return null;

  if (planWord === 'Expired') {
    return (
      <Link
        href={buildTenantHref(subdomain, '/my-plan', useCleanPaths)}
        aria-label="Plan expired, open My Plan"
        data-testid="topbar-plan-pill"
        className="flex h-control shrink-0 items-center rounded-sm border border-line bg-panel px-3 text-body font-medium text-signal-critical outline-none transition-colors duration-base ease-standard hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
      >
        Expired
      </Link>
    );
  }

  if (planWord === 'Free') {
    return (
      <Link
        href={buildTenantHref(subdomain, '/purchase', useCleanPaths)}
        aria-label="Upgrade your plan, open Purchase"
        data-testid="topbar-plan-pill"
        className="flex h-control shrink-0 items-center rounded-sm border border-line bg-panel px-3 text-body font-medium text-brand-gold outline-none transition-colors duration-base ease-standard hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
      >
        Upgrade
      </Link>
    );
  }

  // Paid. An active period without an end date is defensive-only:
  // show the word with no count rather than inventing a date.
  const href = buildTenantHref(subdomain, '/my-plan', useCleanPaths);
  const baseClassName =
    'flex h-control shrink-0 items-center gap-2 rounded-sm border border-line bg-panel px-3 text-body font-medium text-ink outline-none transition-colors duration-base ease-standard hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link';
  if (entitlement.periodEndsAt === null) {
    return (
      <Link href={href} aria-label="Paid plan, open My Plan" data-testid="topbar-plan-pill" className={baseClassName}>
        Paid
      </Link>
    );
  }
  const days = calendarDaysLeft(entitlement.periodEndsAt);
  if (days === null || days < 0) {
    return (
      <Link href={href} aria-label="Paid plan, open My Plan" data-testid="topbar-plan-pill" className={baseClassName}>
        Paid
      </Link>
    );
  }
  if (days === 0) {
    return (
      <Link
        href={href}
        aria-label="Paid plan, expires today, open My Plan"
        data-testid="topbar-plan-pill"
        className={baseClassName}
      >
        <span>Paid ·</span>
        <span className="text-brand-gold">Expires today</span>
      </Link>
    );
  }
  return (
    <Link
      href={href}
      aria-label={`Paid plan, ${days} days left, open My Plan`}
      data-testid="topbar-plan-pill"
      className={baseClassName}
    >
      {/* Desktop: full wording. Phone (below sm, the search button's
          own breakpoint): numeric counts only shorten to "Nd left";
          the "Paid ·" word drops with the full wording. */}
      <span className="hidden sm:inline">Paid ·</span>
      <span className="hidden text-brand-gold sm:inline">{days} days left</span>
      <span className="text-brand-gold sm:hidden">{days}d left</span>
    </Link>
  );
}
