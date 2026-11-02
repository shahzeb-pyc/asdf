import type { Metadata } from 'next';
import React from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSessionContext } from '@/lib/auth';

import { loadHomeData } from '@/components/home/home-data';
import {
  buildFreeQuickLinks,
  buildPaidQuickLinks,
} from '@/components/home/home-helpers';
import {
  AdminPanelCard,
  ExpiredBanner,
  FreePlanCard,
  HomeErrorCard,
  HomeHeader,
  HomeOldUsersBanner,
  MuseAssistantCard,
  PaidPlanCard,
  QuickLinks,
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
 * Workspace home — the redesigned overview dashboard.
 *
 * HARD CONSTRAINT (owner): no queues or posts data anywhere on Home.
 * Nothing here reads queue items, counts scheduled/published/failed
 * posts, or links to Queue or Calendar.
 *
 * Sections by plan (Home stays exempt from the free-plan dialog):
 * - Paid: header, old-users banner, paid plan card, quick links
 *   (Media Library, Creator Finder, Facebook Accounts, Facebook
 *   Pages, Billing), Muse Assistant rail card.
 * - Free: header, old-users banner, free plan card, upgrade card,
 *   Prompt Library + Billing links only, Muse Assistant rail card.
 * - Expired: header, old-users banner, expired banner and renew only.
 * - Admin: redirected to the admin section (/admin/subscriptions)
 *   before render, so the admin branch below is only a fallback and
 *   never the landing an admin sees.
 *
 * The old dashboard's Connected Pages / Followers Gained summary
 * cards, setup checklist, needs-attention list and add-first-page
 * empty state are not in the approved redesign and are not rendered.
 *
 * Server-first: all data loads in `loadHomeData` (one server module,
 * session + service-role client). Any load failure renders a visible
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

  // Admins never land on Home: a direct load that reaches this page
  // (notably the app-host /tenant/<subdomain> form, which middleware
  // passes through) goes to the admin section instead. Middleware
  // already redirects the tenant-host and apex Home forms, so this
  // only ever fires for the app-host form — and never loops, since
  // /admin/subscriptions is outside the tenant routes.
  const session = await getServerSessionContext();
  if (session?.role === 'admin') {
    redirect('/admin/subscriptions');
  }

  const pagesHref = href('/pages');
  const accountsHref = href('/accounts');
  const mediaHref = href('/media');
  const creatorFinderHref = href('/creator-finder');
  const promptsHref = href('/prompts');
  const billingHref = href('/my-plan');
  const billingPurchaseHref = href('/purchase');
  const paymentsHref = href('/payments');

  const data = await loadHomeData(subdomain);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <HomeHeader
        workspaceName={workspaceName}
        subheading={
          data.kind === 'paid'
            ? 'Your paid workspace is active and ready to post.'
            : data.kind === 'free'
              ? 'You are on the Free plan — Prompt Library only.'
              : 'Your workspace at a glance.'
        }
        promptsHref={promptsHref}
      />
      <HomeOldUsersBanner />

      {data.kind === 'error' ? <HomeErrorCard message={data.message} /> : null}

      {data.kind === 'admin' ? <AdminPanelCard billingHref={billingHref} /> : null}

      {data.kind === 'expired' ? (
        <ExpiredBanner billingPurchaseHref={billingPurchaseHref} />
      ) : null}

      {data.kind === 'free' ? (
        <div className="grid items-start gap-6 lg:grid-cols-3">
          <main className="space-y-6 lg:col-span-2">
            <FreePlanCard />
            <UpgradeCard billingPurchaseHref={billingPurchaseHref} billingHref={billingHref} />
            <QuickLinks links={buildFreeQuickLinks({ promptsHref, billingHref })} />
          </main>
          <aside>
            <MuseAssistantCard />
          </aside>
        </div>
      ) : null}

      {data.kind === 'paid' ? (
        <div className="grid items-start gap-6 lg:grid-cols-3">
          <main className="space-y-6 lg:col-span-2">
            <PaidPlanCard
              data={data}
              billingHref={billingHref}
              billingPurchaseHref={billingPurchaseHref}
              paymentsHref={paymentsHref}
            />
            <QuickLinks
              links={buildPaidQuickLinks({
                mediaHref,
                creatorFinderHref,
                accountsHref,
                pagesHref,
                billingHref,
              })}
            />
          </main>
          <aside>
            <MuseAssistantCard />
          </aside>
        </div>
      ) : null}
    </div>
  );
}
