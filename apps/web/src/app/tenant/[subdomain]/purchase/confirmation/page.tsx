import type { Metadata } from 'next';
import React from 'react';
import { redirect } from 'next/navigation';
import { getServerSessionContext } from '@/lib/auth';
import { PurchaseView } from '@/components/billing/purchase-view';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Purchase confirmation' };

interface ConfirmationPageProps {
  params: Promise<{ subdomain: string }>;
  searchParams?: Promise<{ payment?: string }>;
}

/**
 * Purchase confirmation sub-route, keyed by payment id. The view
 * re-reads the payment from the server, so refreshing — or closing
 * the tab and reopening this link — recovers the crypto pay
 * address, exact USDT amount and network. A zero-due activation
 * has no payment row and goes straight to My Plan instead.
 */
export default async function TenantPurchaseConfirmationPage({
  params,
  searchParams,
}: Readonly<ConfirmationPageProps>) {
  const { subdomain } = await params;
  const session = await getServerSessionContext();
  if (!session) {
    const payment = (await searchParams)?.payment;
    const returnUrl = `/tenant/${subdomain}/purchase/confirmation${payment ? `?payment=${encodeURIComponent(payment)}` : ''}`;
    redirect(`/login?returnUrl=${encodeURIComponent(returnUrl)}`);
  }
  const paymentId = (await searchParams)?.payment ?? null;
  return <PurchaseView subdomain={subdomain} step="confirmation" confirmationPaymentId={paymentId} />;
}
