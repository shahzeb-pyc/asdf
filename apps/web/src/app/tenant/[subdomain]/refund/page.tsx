import type { Metadata } from 'next';
import React from 'react';
import { redirect } from 'next/navigation';
import { getServerSessionContext } from '@/lib/auth';
import { RefundView } from '@/components/billing/refund-view';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Refund' };

interface RefundPageProps {
  params: Promise<{ subdomain: string }>;
}

/**
 * Refund route (users only). Separate section since the 2026-11-02
 * billing split, mounted regardless of plan state, with its own
 * error state and the ineligibility reason shown unconditionally.
 */
export default async function TenantRefundPage({ params }: Readonly<RefundPageProps>) {
  const { subdomain } = await params;
  const session = await getServerSessionContext();
  if (!session) {
    redirect(`/login?returnUrl=${encodeURIComponent(`/tenant/${subdomain}/refund`)}`);
  }
  return <RefundView subdomain={subdomain} />;
}
