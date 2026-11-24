import type { Metadata } from 'next';
import { AnalyticsPage } from '@/components/analytics/analytics-page';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Analytics' };

/**
 * Analytics — combined Facebook performance for the picked workspace
 * (or all workspaces), from the per-page analytics columns the
 * insights worker fills once a day (spec 241). Combined only: no
 * per-page view. The numbers are for yesterday — the date chip and
 * the period label say which days they cover.
 */
export default async function TenantAnalyticsPage({
  params,
}: Readonly<{
  params: Promise<{ subdomain: string }>;
}>) {
  const { subdomain } = await params;
  return <AnalyticsPage subdomain={subdomain} />;
}
