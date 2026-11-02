import type { Metadata } from 'next';
import React from 'react';
import { redirect } from 'next/navigation';
import { getServerSessionContext } from '@/lib/auth';
import { PaymentsView } from '@/components/billing/payments-view';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Payments' };

interface PaymentsPageProps {
  params: Promise<{ subdomain: string }>;
}

/**
 * Payments route (users only). Separate section since the 2026-11-02
 * billing split: no ?view= dropdown, no Billing route.
 */
export default async function TenantPaymentsPage({ params }: Readonly<PaymentsPageProps>) {
  const { subdomain } = await params;
  const session = await getServerSessionContext();
  if (!session) {
    redirect(`/login?returnUrl=${encodeURIComponent(`/tenant/${subdomain}/payments`)}`);
  }
  return <PaymentsView subdomain={subdomain} />;
}
