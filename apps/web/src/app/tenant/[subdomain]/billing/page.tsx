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
}

/**
 * Billing route. Admins do not see the user billing page: when an
 * admin logs in, this same route renders the subscriptions
 * approval view, matching the admin-only sidebar.
 */
export default async function TenantBillingPage({ params }: Readonly<BillingPageProps>) {
  const { subdomain } = await params;
  const session = await getServerSessionContext();
  if (!session) {
    redirect(`/login?returnUrl=${encodeURIComponent(`/tenant/${subdomain}/billing`)}`);
  }
  if (session.role === 'admin') {
    return <AdminApprovalsView subdomain={subdomain} />;
  }
  return <BillingView subdomain={subdomain} />;
}
