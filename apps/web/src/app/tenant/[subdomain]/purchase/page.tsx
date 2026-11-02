import type { Metadata } from 'next';
import React from 'react';
import { redirect } from 'next/navigation';
import { getServerSessionContext } from '@/lib/auth';
import { PurchaseView } from '@/components/billing/purchase-view';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Purchase' };

interface PurchasePageProps {
  params: Promise<{ subdomain: string }>;
}

/**
 * Purchase builder route (users only). Separate section since the
 * 2026-11-02 billing split. Checkout and confirmation are
 * sub-routes below this one, not view state and not ?view= values.
 */
export default async function TenantPurchasePage({ params }: Readonly<PurchasePageProps>) {
  const { subdomain } = await params;
  const session = await getServerSessionContext();
  if (!session) {
    redirect(`/login?returnUrl=${encodeURIComponent(`/tenant/${subdomain}/purchase`)}`);
  }
  return <PurchaseView subdomain={subdomain} step="builder" />;
}
