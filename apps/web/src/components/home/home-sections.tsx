/**
 * Tenant Home — presentational sections (server-component safe).
 *
 * These components render already-loaded data only; they never fetch
 * and never read queues or posts. Links deliberately exclude Queue
 * and Calendar: Home carries no queues or posts data at all.
 *
 * Status marks follow the standing rule: no dots. A finished setup
 * step shows a tick in a green-circle medallion (the connect-status
 * pattern); pending steps carry no mark. Needs-attention reasons are
 * plain text, not marks.
 */
import * as React from 'react';
import Link from 'next/link';
import { CheckIcon, ChevronRightIcon } from 'lucide-react';

import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import { Card } from '@/components/shared/ui/card';
import { cn } from '@/lib/utils';
import {
  deriveMediaStorageState,
  formatStorageGbOneDecimal,
} from '@/lib/billing/storage-display';

import type { HomeAttentionItem, HomePaidData } from './home-data';
import type { HomeChecklistStep, HomeQuickLink } from './home-helpers';
import { daysLeftUntil, EXPIRING_SOON_DAYS, formatExpiryDate } from './home-helpers';

const PLATFORM_LABELS: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
  x: 'X',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

export function HomeHero({ workspaceName }: { workspaceName: string }) {
  return (
    <Card data-testid="home-hero" className="gap-1 px-6">
      <h1 className="text-xl leading-heading font-bold tracking-h1 text-ink">
        Welcome, {workspaceName}
      </h1>
      <p className="text-body leading-body text-ink-sub">Your workspace at a glance.</p>
    </Card>
  );
}

export function PaidPlanBanner({
  data,
  billingPurchaseHref,
}: {
  data: HomePaidData;
  billingPurchaseHref: string;
}) {
  const daysLeft = daysLeftUntil(data.periodEndsAt, new Date());
  const expiringSoon = daysLeft <= EXPIRING_SOON_DAYS;
  const expiry = formatExpiryDate(data.periodEndsAt);
  const summary = `${data.units.toLocaleString()} pages or accounts · Expires ${expiry} · ${daysLeft === 0 ? 'Expires today' : `${daysLeft.toLocaleString()} days left`}`;

  if (expiringSoon) {
    return (
      <Banner
        data-testid="plan-banner"
        variant="warning"
        title={
          daysLeft === 0 ? 'Your plan expires today' : `Your plan expires in ${daysLeft} days`
        }
        description={summary}
        action={
          <Button asChild variant="outline">
            <Link href={billingPurchaseHref}>Renew</Link>
          </Button>
        }
      />
    );
  }

  return (
    <Card data-testid="plan-banner" className="gap-1 px-6">
      <h2 className="text-body leading-heading font-bold text-ink">Paid plan</h2>
      <p className="text-body leading-body text-ink-sub">{summary}</p>
      <div>
        <Button asChild variant="outline">
          <Link href={billingPurchaseHref}>Renew</Link>
        </Button>
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

export function FreePlanCard() {
  return (
    <Card data-testid="free-plan-card" className="gap-1 px-6">
      <h2 className="text-body leading-heading font-bold text-ink">Free plan</h2>
      <p className="text-body leading-body text-ink-sub">
        Your plan covers the Prompt Library only.
      </p>
    </Card>
  );
}

export function UpgradeCard({ billingPurchaseHref }: { billingPurchaseHref: string }) {
  return (
    <Card data-testid="upgrade-card" className="gap-1 px-6">
      <h2 className="text-body leading-heading font-bold text-ink">Upgrade to Paid</h2>
      <p className="text-body leading-body text-ink-sub">
        Posting to Facebook pages, Instagram, and Threads — 70 PKR per page or account per
        month, unlimited posts, and 5 GB of Media Library storage per page or account.
      </p>
      <div>
        <Button asChild>
          <Link href={billingPurchaseHref}>Upgrade</Link>
        </Button>
      </div>
    </Card>
  );
}

export function SetupChecklist({ steps }: { steps: HomeChecklistStep[] }) {
  return (
    <Card data-testid="setup-checklist" className="gap-3 px-6">
      <h2 className="text-body leading-heading font-bold text-ink">Get set up</h2>
      <ul className="space-y-2">
        {steps.map((step) => (
          <li key={step.id} className="flex items-center gap-2">
            {step.done ? (
              <span
                className={cn(
                  'flex size-5 shrink-0 items-center justify-center rounded-full border',
                  'border-brand-emerald bg-brand-emerald/15 text-brand-emerald'
                )}
              >
                <CheckIcon className="size-3" strokeWidth={3} aria-hidden />
                <span className="sr-only">Done</span>
              </span>
            ) : null}
            {step.done ? (
              <span className="text-body text-ink-sub">{step.label}</span>
            ) : (
              <Link href={step.href} className="text-body text-link hover:underline">
                {step.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function SummaryCards({
  data,
  pagesHref,
  aduHref,
  mediaHref,
}: {
  data: HomePaidData;
  pagesHref: string;
  aduHref: string;
  mediaHref: string;
}) {
  const storageState =
    data.storageQuotaBytes > 0
      ? deriveMediaStorageState(data.storageUsedBytes, data.storageQuotaBytes)
      : null;
  const storageSub =
    storageState === null
      ? null
      : storageState === 'near'
        ? 'Reaching storage limit'
        : storageState === 'full'
          ? 'Media Library full'
          : storageState === 'over'
            ? 'Over limit — library read-only'
            : `${formatStorageGbOneDecimal(data.storageQuotaBytes - data.storageUsedBytes)} remaining`;

  return (
    <div data-testid="summary-cards" className="grid gap-4 sm:grid-cols-3">
      <Link
        href={pagesHref}
        className="block rounded-xl border border-line bg-panel p-4 shadow-card hover:bg-hover"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-sub">
          Connected pages
        </p>
        <p className="mt-1 text-2xl font-bold tracking-tight text-ink">
          {data.totalDestinations.toLocaleString()}
        </p>
        <p className="mt-1 text-xs text-ink-sub">
          {data.activeDestinations.toLocaleString()} active ·{' '}
          {data.facebookAccounts.toLocaleString()} FB accounts
        </p>
      </Link>
      <Link
        href={aduHref}
        className="block rounded-xl border border-line bg-panel p-4 shadow-card hover:bg-hover"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-sub">
          Followers gained
        </p>
        <p className="mt-1 text-2xl font-bold tracking-tight text-ink">
          {data.followersGained.toLocaleString()}
        </p>
        <p className="mt-1 text-xs text-ink-sub">Across ADU pages</p>
      </Link>
      {storageState !== null && storageSub !== null ? (
        <Link
          href={mediaHref}
          className="block rounded-xl border border-line bg-panel p-4 shadow-card hover:bg-hover"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-sub">
            Media storage
          </p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-ink">
            {formatStorageGbOneDecimal(data.storageUsedBytes)} of{' '}
            {formatStorageGbOneDecimal(data.storageQuotaBytes)}
          </p>
          <p className="mt-1 text-xs text-ink-sub">{storageSub}</p>
        </Link>
      ) : null}
    </div>
  );
}

export function NeedsAttention({
  items,
  totalCount,
  pagesHref,
}: {
  items: HomeAttentionItem[];
  totalCount: number;
  pagesHref: string;
}) {
  if (items.length === 0) return null;
  const hidden = Math.max(0, totalCount - items.length);
  return (
    <Card data-testid="needs-attention" className="gap-3 px-6">
      <h2 className="text-body leading-heading font-bold text-ink">
        Needs attention · {totalCount.toLocaleString()}
      </h2>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-body font-medium text-ink">{item.name}</span>
            <span className="text-xs text-ink-sub">{platformLabel(item.platform)}</span>
            <span className="text-body text-ink-sub">{item.reason}</span>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="text-body text-ink-sub">
          And {hidden.toLocaleString()} more pages need attention.
        </p>
      ) : null}
      <div>
        <Button asChild variant="outline">
          <Link href={pagesHref}>View pages</Link>
        </Button>
      </div>
    </Card>
  );
}

export function QuickLinks({ links }: { links: HomeQuickLink[] }) {
  return (
    <section data-testid="quick-links" aria-label="Quick links" className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-sub">
        Quick links
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="flex items-center justify-between rounded-xl border border-line bg-panel px-4 py-3 text-body text-ink hover:bg-hover"
            >
              {link.label}
              <ChevronRightIcon className="size-4 text-ink-sub" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PagesEmptyState({ pagesHref }: { pagesHref: string }) {
  return (
    <Card data-testid="pages-empty-state" className="gap-1 px-6">
      <h2 className="text-body leading-heading font-bold text-ink">Add your first page</h2>
      <p className="text-body leading-body text-ink-sub">
        You have no pages yet. Add your first page to start posting.
      </p>
      <div>
        <Button asChild>
          <Link href={pagesHref}>Add a page</Link>
        </Button>
      </div>
    </Card>
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
