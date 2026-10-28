import type { Metadata } from 'next';
import { PublishNowPage } from '@/components/pages/publish-now/publish-now-page';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Publish Now' };

/**
 * Publish Now — direct multi-page publish. The page auto-opens
 * the account selector dialogue (see PublishNowPage); the flow
 * itself lives in the PublishNowDialog component.
 */
export default async function TenantPublishNowPage({
  params,
}: Readonly<{
  params: Promise<{ subdomain: string }>;
}>) {
  const { subdomain } = await params;
  return <PublishNowPage subdomain={subdomain} />;
}
