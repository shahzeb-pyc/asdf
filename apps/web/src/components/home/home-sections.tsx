/**
 * Tenant Home — presentational sections (server-component safe).
 *
 * These components render already-loaded data only; they never fetch
 * and never read queues or posts. Links deliberately exclude Queue
 * and Calendar: Home carries no queues or posts data at all.
 *
 * Status marks follow the standing rule: no dots. A tick in a
 * green-circle medallion means included/connected; a cross in a
 * red-circle medallion means not included. Needs-attention reasons
 * were plain text in the old dashboard; the redesigned Home has no
 * needs-attention section at all.
 *
 * Design system only: tokens + shared/ui primitives (Card, Button,
 * Banner, Progress), compact density, no literal colours, no inline
 * styles, no surface-local one-off components. The mockups' light
 * standalone styling is mapped onto the app's token palette, not
 * copied hex-for-hex — notably the Muse orb, which renders as a
 * token gold disc rather than a copied gradient.
 *
 * Ask Muse: there is no in-app Muse chat in the code (only the ⌘K
 * command palette), so the Ask Muse button has no destination yet.
 * It is rendered as an inert button — visual-only for now — and
 * must be wired to a real destination, or removed, before merge.
 * No fake route or fake chat is invented here.
 *
 * Creator Finder "Unlimited use": the wording is as approved in the
 * mockup. It sits alongside a live 100 TikWM API calls/day/user cap
 * (PR #103) that this change does not touch — the wording-vs-cap
 * discrepancy is flagged for the merge gate, not resolved here.
 */
import * as React from 'react';
import Link from 'next/link';
import { ArrowUpRightIcon, CheckIcon, ChevronRightIcon, XIcon } from 'lucide-react';
import { SUBSCRIPTION_PERIOD_DAYS, SUBSCRIPTION_PRICE_PKR_PER_UNIT, totalPricePkr, ZERO_PLATFORM_COUNTS } from '@fbuploadpro/contracts';

import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import { Card } from '@/components/shared/ui/card';
import { Progress } from '@/components/shared/ui/progress';
import { cn } from '@/lib/utils';
import {
  formatStorageGb,
  formatStorageGbOneDecimal,
  STORAGE_BYTES_PER_UNIT,
} from '@/lib/billing/storage-display';
import { OLD_USERS_NOTICE_TEXT } from '@/components/shared/old-users-notice-banner';

import type { HomePaidData } from './home-data';
import type { HomeQuickLink } from './home-helpers';
import {
  buildPaidPlanPlatformRows,
  daysLeftUntil,
  formatExpiryDateLong,
  formatHeaderDate,
} from './home-helpers';

function PlanRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <span className="text-body text-ink-sub">{label}</span>
      <span className="text-right text-body font-semibold text-ink">{children}</span>
    </div>
  );
}

function PlanSectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-sub">{children}</h3>
  );
}

function FeatureMark({ included }: { included: boolean }) {
  return included ? (
    <span
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full border',
        'border-brand-emerald bg-brand-emerald/15 text-brand-emerald'
      )}
    >
      <CheckIcon className="size-3" strokeWidth={3} aria-hidden />
      <span className="sr-only">Included</span>
    </span>
  ) : (
    <span
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full border',
        'border-signal-critical bg-signal-critical/15 text-signal-critical-on-tint'
      )}
    >
      <XIcon className="size-3" strokeWidth={3} aria-hidden />
      <span className="sr-only">Not included</span>
    </span>
  );
}

function FeatureRow({
  label,
  included,
  value,
}: {
  label: string;
  included: boolean;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="flex items-center gap-2 text-body text-ink">
        <FeatureMark included={included} />
        {label}
      </span>
      <span className="text-body font-semibold text-ink">{value}</span>
    </div>
  );
}

export function HomeHeader({
  workspaceName,
  subheading,
  promptsHref,
}: {
  workspaceName: string;
  subheading: string;
  promptsHref: string;
}) {
  return (
    <header data-testid="home-header" className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-sub">
          {formatHeaderDate(new Date())}
        </p>
        <h1 className="text-xl leading-heading font-bold tracking-h1 text-ink">
          Welcome, {workspaceName}
        </h1>
        <p className="text-body leading-body text-ink-sub">{subheading}</p>
      </div>
      <Button asChild variant="outline" className="max-sm:w-full">
        <Link href={promptsHref}>Go to Prompt Library</Link>
      </Button>
    </header>
  );
}

/**
 * Old-users notice as approved for the redesigned Home: a heading
 * plus the verbatim notice body. The text comes from the shared
 * constant — this does not edit the shared banner component, which
 * the login page still uses unchanged. Text only: no number, no
 * link, no button.
 */
export function HomeOldUsersBanner() {
  return (
    <Banner
      data-testid="old-users-notice-banner"
      variant="warning"
      title="For old FBUploadPro users"
      description={OLD_USERS_NOTICE_TEXT}
    />
  );
}

export function PaidPlanCard({
  data,
  billingHref,
  billingPurchaseHref,
  paymentsHref,
}: {
  data: HomePaidData;
  billingHref: string;
  billingPurchaseHref: string;
  paymentsHref: string;
}) {
  const daysLeft = daysLeftUntil(data.periodEndsAt, new Date());
  const platformCounts = data.platformCounts ?? ZERO_PLATFORM_COUNTS;
  const platformRows = buildPaidPlanPlatformRows(platformCounts);
  const pricePkr = totalPricePkr(platformCounts);
  const hasStorage = data.storageQuotaBytes > 0;
  const storagePercent = hasStorage
    ? Math.min(100, Math.max(0, (data.storageUsedBytes / data.storageQuotaBytes) * 100))
    : 0;
  const storageRemaining = hasStorage
    ? formatStorageGbOneDecimal(Math.max(0, data.storageQuotaBytes - data.storageUsedBytes))
    : null;

  return (
    <Card data-testid="plan-card" className="gap-4 px-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-body leading-heading font-bold text-ink">Paid plan</h2>
          <p className="text-body leading-body text-ink-sub">Monthly plan · Unlimited posts</p>
        </div>
        <span className="flex shrink-0 items-center gap-2 text-body font-semibold text-ink">
          <span
            className={cn(
              'flex size-5 items-center justify-center rounded-full border',
              'border-brand-emerald bg-brand-emerald/15 text-brand-emerald'
            )}
          >
            <CheckIcon className="size-3" strokeWidth={3} aria-hidden />
          </span>
          Active
        </span>
      </div>

      <div>
        <p className="text-2xl font-bold tracking-tight text-ink">
          {data.units.toLocaleString()} pages or accounts
        </p>
        <p className="text-body text-ink-sub">
          {pricePkr.toLocaleString()} PKR / month · {SUBSCRIPTION_PRICE_PKR_PER_UNIT} PKR per
          page or account
        </p>
      </div>

      <div className="divide-y divide-line border-y border-line">
        <PlanRow label="Period">
          {SUBSCRIPTION_PERIOD_DAYS}-day period
          <span className="block text-body font-normal text-ink-sub">
            Ends {formatExpiryDateLong(data.periodEndsAt)} ·{' '}
            {daysLeft === 0 ? 'Expires today' : `${daysLeft.toLocaleString()} days left`}
          </span>
        </PlanRow>
        <PlanRow label="Posting">You can post and schedule</PlanRow>
        {hasStorage ? (
          <PlanRow label="Media storage">
            {formatStorageGbOneDecimal(data.storageUsedBytes)} of{' '}
            {formatStorageGbOneDecimal(data.storageQuotaBytes)}
            <span className="block text-body font-normal text-ink-sub">
              {formatStorageGb(STORAGE_BYTES_PER_UNIT)} per page or account ·{' '}
              {storageRemaining} remaining
            </span>
          </PlanRow>
        ) : null}
      </div>
      {hasStorage ? (
        <Progress
          value={storagePercent}
          aria-label="Media storage used"
          data-testid="storage-progress"
        />
      ) : null}

      <div className="space-y-3">
        <PlanSectionTitle>Included in your plan</PlanSectionTitle>
        <div className="divide-y divide-line border-y border-line">
          {platformRows.map((row) => (
            <PlanRow key={row.platform} label={row.label}>
              {row.count.toLocaleString()} {row.unitLabel}
            </PlanRow>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <PlanSectionTitle>Unlimited use</PlanSectionTitle>
        <div className="divide-y divide-line border-y border-line">
          <PlanRow label="Prompt Library">Unlimited use</PlanRow>
          <PlanRow label="Creator Finder">Unlimited use</PlanRow>
        </div>
      </div>

      <div className="space-y-3">
        <PlanSectionTitle>Included features</PlanSectionTitle>
        <div className="divide-y divide-line border-y border-line">
          <PlanRow label="Auto Download/Upload">Included</PlanRow>
          <PlanRow label="TikTok Repost">Included</PlanRow>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button asChild className="max-sm:w-full">
          <Link href={billingPurchaseHref}>Renew</Link>
        </Button>
        <Button asChild variant="outline" className="max-sm:w-full">
          <Link href={billingHref}>View My Plan</Link>
        </Button>
        <Button asChild variant="outline" className="max-sm:w-full">
          <Link href={paymentsHref}>View Payments</Link>
        </Button>
      </div>
    </Card>
  );
}

export function FreePlanCard() {
  return (
    <Card data-testid="free-plan-card" className="gap-4 px-6">
      <div>
        <h2 className="text-body leading-heading font-bold text-ink">Free plan</h2>
        <p className="text-body leading-body text-ink-sub">
          Your plan covers the Prompt Library only.
        </p>
      </div>
      <div>
        <p className="text-2xl font-bold tracking-tight text-ink">0 PKR</p>
        <p className="text-body text-ink-sub">Free — no pages or accounts included.</p>
      </div>
      <div className="divide-y divide-line border-y border-line">
        <FeatureRow label="Prompt Library" included value="Included" />
        <FeatureRow label="Posting and scheduling" included={false} value="Not included" />
        <FeatureRow label="Auto Download/Upload" included={false} value="Not included" />
        <FeatureRow label="Auto Repost" included={false} value="Not included" />
      </div>
    </Card>
  );
}

export function UpgradeCard({
  billingPurchaseHref,
  billingHref,
}: {
  billingPurchaseHref: string;
  billingHref: string;
}) {
  return (
    <Card data-testid="upgrade-card" className="gap-4 px-6">
      <div>
        <h2 className="text-body leading-heading font-bold text-ink">Upgrade to Paid</h2>
        <p className="text-body leading-body text-ink-sub">
          Posting to Facebook pages, Instagram, and Threads — 70 PKR per page or account per
          month, unlimited posts, and 5 GB of Media Library storage per page or account.
        </p>
      </div>
      <div className="divide-y divide-line border-y border-line">
        <FeatureRow label="Prompt Library" included value="Unlimited use" />
        <FeatureRow label="Creator Finder" included value="Unlimited use" />
        <FeatureRow
          label="Media Library"
          included
          value={`${formatStorageGb(STORAGE_BYTES_PER_UNIT)} per page or account`}
        />
        <FeatureRow label="Unlimited posts" included value="Included" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild className="max-sm:w-full">
          <Link href={billingPurchaseHref}>Upgrade</Link>
        </Button>
        <Button asChild variant="outline" className="max-sm:w-full">
          <Link href={billingHref}>View Billing</Link>
        </Button>
      </div>
    </Card>
  );
}

export function QuickLinks({ links }: { links: HomeQuickLink[] }) {
  return (
    <section data-testid="quick-links" aria-label="Quick links" className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-sub">Quick links</h2>
      <Card className="gap-0 py-0">
        <ul className="divide-y divide-line">
          {links.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="flex items-center justify-between px-6 py-3 text-body text-ink hover:bg-hover"
              >
                {link.label}
                <ChevronRightIcon className="size-4 text-ink-sub" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

export function MuseAssistantCard() {
  return (
    <Card data-testid="muse-assistant-card" className="gap-4 px-6 text-center">
      <h2 className="flex items-center justify-between text-left text-body leading-heading font-bold text-ink">
        Muse Assistant
        <ArrowUpRightIcon className="size-4 text-ink-sub" aria-hidden />
      </h2>
      <div
        aria-hidden
        className="mx-auto size-20 rounded-full bg-primary ring-8 ring-primary/10"
      />
      <p className="mx-auto max-w-70 text-body leading-body text-ink-sub">
        Ask Muse to schedule, publish, or check your pages — while you sleep.
      </p>
      <div>
        {/* Destination undecided: no in-app Muse chat exists yet, so this
            button is visual-only for now. It must be wired to a real
            destination, or removed, before merge. */}
        <Button data-testid="ask-muse-button">Ask Muse →</Button>
      </div>
    </Card>
  );
}

export function ExpiredBanner({ billingPurchaseHref }: { billingPurchaseHref: string }) {
  return (
    <Banner
      data-testid="plan-banner"
      variant="critical"
      title="Your plan has expired"
      description="Renew to post and schedule again."
      action={
        <Button asChild variant="outline">
          <Link href={billingPurchaseHref}>Renew</Link>
        </Button>
      }
    />
  );
}

export function AdminPanelCard({ billingHref }: { billingHref: string }) {
  return (
    <Card data-testid="admin-panel-card" className="gap-1 px-6">
      <h2 className="text-body leading-heading font-bold text-ink">Admin panel</h2>
      <p className="text-body leading-body text-ink-sub">
        You manage subscriptions and approvals from the admin panel.
      </p>
      <div>
        <Button asChild>
          <Link href={billingHref}>Open admin panel</Link>
        </Button>
      </div>
    </Card>
  );
}

export function HomeErrorCard({ message }: { message: string }) {
  return (
    <Banner
      data-testid="home-error"
      variant="critical"
      title="Home data could not be loaded"
      description={message}
    />
  );
}
