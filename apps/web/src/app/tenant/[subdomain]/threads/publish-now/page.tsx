import type { Metadata } from 'next';
import { ThreadsPublishNowPage } from '@/components/pages/threads-publish-now/threads-publish-now-page';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Publish Now' };

/**
 * Threads Publish Now — direct multi-account publish, modelled
 * on the Facebook Publish Now page: account selection, then the
 * active composer beside the results panel (see
 * ThreadsPublishNowPage). Threads accounts are the destinations
 * themselves, so there is no pages step.
 */
export default async function TenantThreadsPublishNowPage({
  params,
}: Readonly<{
  params: Promise<{ subdomain: string }>;
}>) {
  const { subdomain } = await params;
  return <ThreadsPublishNowPage subdomain={subdomain} />;
}
