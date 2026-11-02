import type { Metadata } from 'next';
import React from 'react';
import { redirect } from 'next/navigation';
import { getServerSessionContext } from '@/lib/auth';
import { PurchaseView } from '@/components/billing/purchase-view';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Checkout' };

interface CheckoutPageProps {
  params: Promise<{ subdomain: string }>;
}

/**
 * Purchase checkout sub-route. The builder draft rides in this
 * tab's session storage; arriving here without a draft sends the
 * user back to the builder (see PurchaseView).
 */
export default async function TenantPurchaseCheckoutPage({ params }: Readonly<CheckoutPageProps>) {
  const { subdomain } = await params;
  const session = await getServerSessionContext();
  if (!session) {
    redirect(`/login?returnUrl=${encodeURIComponent(`/tenant/${subdomain}/purchase/checkout`)}`);
  }
  return <PurchaseView subdomain={subdomain} step="checkout" />;
}
