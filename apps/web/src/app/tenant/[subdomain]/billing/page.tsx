import type { Metadata } from 'next';
import React from 'react';
import { redirect } from 'next/navigation';
import { getServerSessionContext } from '@/lib/auth';
import { AdminApprovalsView } from '@/components/billing/admin-approvals-view';
import { BillingView } from '@/components/billing/billing-view';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Billing' };

interface BillingPageProps {
  params: Promise<{ subdomain: string }>;
  searchParams?: Promise<{ view?: string }>;
}

type BillingViewName = 'plans' | 'build' | 'checkout' | 'confirmation' | 'payments';

const BILLING_VIEWS: BillingViewName[] = ['plans', 'build', 'checkout', 'confirmation', 'payments'];

/**
 * Billing route. Admins do not see the user billing page: when an
 * admin logs in, this same route renders the subscriptions
 * approval view, matching the admin-only sidebar.
 *
 * For users, Billing is five pages behind one route, selected by
 * ?view= (plans | build | checkout | confirmation | payments) so the
 * sidebar group leaves are plain first-click Links and the browser
 * back button moves between pages. Checkout and Confirmation are
 * flow-only: they are reached from Build plan, never from the sidebar.
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
  if (session.role === 'admin') {
    return <AdminApprovalsView subdomain={subdomain} />;
  }
  const rawView = (await searchParams)?.view;
  const initialStep: BillingViewName =
    rawView !== undefined && (BILLING_VIEWS as string[]).includes(rawView)
      ? (rawView as BillingViewName)
      : 'plans';
  return <BillingView subdomain={subdomain} initialStep={initialStep} />;
}
