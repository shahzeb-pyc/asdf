import type { Metadata } from 'next';
import React from 'react';
import { headers } from 'next/headers';

import { loadHomeData } from '@/components/home/home-data';
import {
  buildChecklist,
  buildFreeQuickLinks,
  buildPaidQuickLinks,
  isChecklistComplete,
} from '@/components/home/home-helpers';
import {
  AdminPanelCard,
  ExpiredBanner,
  FreePlanCard,
  HomeErrorCard,
  HomeHero,
  NeedsAttention,
  PagesEmptyState,
  PaidPlanBanner,
  QuickLinks,
  SetupChecklist,
  SummaryCards,
  UpgradeCard,
} from '@/components/home/home-sections';
import { buildTenantHref, shouldUseCleanTenantPaths } from '@/lib/tenant-href';

import { getWorkspaceDisplayName } from './workspace-display-name';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template (§3.3.4). */
export const metadata: Metadata = { title: 'Home' };

interface TenantIndexPageProps {
  params: Promise<{ subdomain: string }>;
}

/**
 * Workspace home — the overview dashboard, rebuilt from the old agency
 * dashboard's shape (welcome hero, setup checklist, at-a-glance
 * numbers, pages needing attention, quick links) adapted to today's
 * subscription model (plan instead of token balance, storage quota
 * instead of token tiers).
 *
 * HARD CONSTRAINT (owner): no queues or posts data anywhere on Home.
 * Nothing here reads queue items, counts scheduled/published/failed
 * posts, or links to Queue or Calendar. Posting times appear only as
 * a setup-checklist step (a time configured, not a post) and as a
 * quick link to the page tab that manages them.
 *
 * Sections by plan (Home stays exempt from the free-plan dialog):
 * - Paid: hero, plan banner, setup checklist (hidden once complete),
 *   summary cards (or the add-first-page empty state at zero pages),
 *   needs-attention pages, quick links.
 * - Free: hero, free plan card, upgrade card, Prompt Library + Billing
 *   links only (nothing that would throw the upgrade dialog).
 * - Expired: hero plus the expired banner and renew button only.
 * - Admin: hero plus the admin-panel link only.
 *
 * Server-first: all data loads in `loadHomeData` (one server module,
 * session + service-role client, every row scoped to the resolved
 * workspace or the session user). Any load failure renders a visible
 * error card, never invented numbers.
 */
export default async function TenantIndexPage({ params }: Readonly<TenantIndexPageProps>) {
  const { subdomain } = await params;
  // H5: the heading must show the workspace display name, never the internal slug.
  const workspaceName = (await getWorkspaceDisplayName(subdomain)) ?? subdomain;

  let hostHeader: string | null = null;
  try {
    hostHeader = (await headers()).get('host');
  } catch {
    // Outside a request scope (tests, static generation): fall back to prefixed URLs.
    hostHeader = null;
  }
  const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'fbuploadpro.com';
  const useCleanPaths = shouldUseCleanTenantPaths(hostHeader, subdomain, rootDomain);
  const href = (path: string) => buildTenantHref(subdomain, path, useCleanPaths);

  const pagesHref = href('/pages');
  const accountsHref = href('/accounts');
  const mediaHref = href('/media');
  const promptsHref = href('/prompts');
  const billingHref = href('/billing');
  const billingPurchaseHref = href('/billing?view=purchase');
  const aduHref = href('/auto-download-upload');

  const data = await loadHomeData(subdomain);

  // Posting times live on a page's Posting Times tab: link the user's
  // first Facebook page's tab when one exists, else the Pages section
  // where a page is added first.
  const postingTimesHref =
    data.kind === 'paid' && data.firstFacebookPageId
      ? href(`/pages/${data.firstFacebookPageId}?tab=calendar`)
      : pagesHref;

  const checklist =
    data.kind === 'paid'
      ? buildChecklist({
          accountsCount: data.accountsCount,
          totalDestinations: data.totalDestinations,
          hasActiveSlot: data.hasActiveSlot,
          accountsHref,
          pagesHref,
          postingTimesHref,
        })
      : [];

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-6">
      <HomeHero workspaceName={workspaceName} />

      {data.kind === 'error' ? <HomeErrorCard message={data.message} /> : null}

      {data.kind === 'admin' ? <AdminPanelCard billingHref={billingHref} /> : null}

      {data.kind === 'free' ? (
        <>
          <FreePlanCard />
          <UpgradeCard billingPurchaseHref={billingPurchaseHref} />
          <QuickLinks links={buildFreeQuickLinks({ promptsHref, billingHref })} />
        </>
      ) : null}

      {data.kind === 'expired' ? (
        <ExpiredBanner billingPurchaseHref={billingPurchaseHref} />
      ) : null}

      {data.kind === 'paid' ? (
        <>
          <PaidPlanBanner data={data} billingPurchaseHref={billingPurchaseHref} />
          {!isChecklistComplete(checklist) ? <SetupChecklist steps={checklist} /> : null}
          {data.totalDestinations === 0 ? (
            <PagesEmptyState pagesHref={pagesHref} />
          ) : (
            <SummaryCards
              data={data}
              pagesHref={pagesHref}
              aduHref={aduHref}
              mediaHref={mediaHref}
            />
          )}
          {data.attention.length > 0 ? (
            <NeedsAttention
              items={data.attention}
              totalCount={data.attentionTotal}
              pagesHref={pagesHref}
            />
          ) : null}
          <QuickLinks
            links={buildPaidQuickLinks({
              pagesHref,
              accountsHref,
              postingTimesHref,
              mediaHref,
              promptsHref,
              billingHref,
            })}
          />
        </>
      ) : null}
    </div>
  );
}
