import type { Metadata } from 'next';
import { InstagramPublishNowPage } from '@/components/instagram/publish-now/instagram-publish-now-page';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Publish Now' };

/**
 * Instagram Publish Now — direct multi-account publish, the
 * Instagram equivalent of Facebook Publish Now: account selector,
 * then the composer beside the results panel (see
 * InstagramPublishNowPage).
 */
export default async function TenantInstagramPublishNowPage({
  params,
}: Readonly<{
  params: Promise<{ subdomain: string }>;
}>) {
  const { subdomain } = await params;
  return <InstagramPublishNowPage subdomain={subdomain} />;
}
