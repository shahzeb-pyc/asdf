import type { Metadata } from 'next';
import React from 'react';
import { redirect } from 'next/navigation';
import { getServerSessionContext } from '@/lib/auth';
import { MyPlanView } from '@/components/billing/my-plan-view';

export const metadata: Metadata = { title: 'My Plan' };

interface PageProps {
  params: Promise<{ subdomain: string }>;
}

export default async function TenantMyPlanPage({
  params,
}: Readonly<PageProps>) {
  const { subdomain } = await params;
  const session = await getServerSessionContext();
  if (!session) {
    redirect(`/login?returnUrl=${encodeURIComponent(`/tenant/${subdomain}/my-plan`)}`);
  }
  return <MyPlanView subdomain={subdomain} />;
}
