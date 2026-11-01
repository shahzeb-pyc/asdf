import type { Metadata } from 'next';
import React from 'react';
import { redirect } from 'next/navigation';
import { getServerSessionContext } from '@/lib/auth';
import { BillingView } from '@/components/billing/billing-view';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Billing' };

interface BillingPageProps {
  params: Promise<{ subdomain: string }>;
  searchParams?: Promise<{ view?: string }>;
}

type BillingSectionName = 'my-plan' | 'purchase' | 'payments';

const BILLING_SECTIONS: BillingSectionName[] = ['my-plan', 'purchase', 'payments'];

/**
 * Billing route (users only). Billing is exactly three sections
 * behind one route, selected by ?view= (my-plan | purchase |
 * payments, default my-plan) so the sidebar group leaves are plain
 * first-click Links and the browser back button moves between
 * sections. Purchase's internal steps (builder → checkout →
 * confirmation) are view state inside Purchase, not ?view= values
 * and not sidebar leaves. Old ?view= values (plans, build,
 * checkout, confirmation) are no longer accepted and fall back to
 * My Plan.
 *
 * Admins never reach this page: middleware and the tenant layout
 * redirect them to /admin/subscriptions first, and there is no
 * admin fallback here — a stray admin render would be a routing
 * bug, and failing visibly beats silently rendering approvals in
 * the user shell.
 */
export default async function TenantBillingPage({
  params,
  searchParams,
}: Readonly<BillingPageProps>) {
  const { subdomain } = await params;
  const session = await getServerSessionContext();
  if (!session) {
    redirect(`/login?returnUrl=${encodeURIComponent(`/tenant/${subdomain}/billing`)}`);
  }
  const rawView = (await searchParams)?.view;
  const initialSection: BillingSectionName =
    rawView !== undefined && (BILLING_SECTIONS as string[]).includes(rawView)
      ? (rawView as BillingSectionName)
      : 'my-plan';
  return <BillingView subdomain={subdomain} initialSection={initialSection} />;
}
