import type { Metadata } from 'next';
import { BulkDeletePage } from '@/components/pages/bulk-delete/bulk-delete-page';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Bulk Delete Posts' };

/**
 * Bulk Delete Posts — delete live published Facebook posts in bulk.
 * Full page, modelled on Publish Now: selection wizard (accounts,
 * then pages discovered live), then Smart Filter / Manual Curation
 * over the pages' live content, then a client-driven delete run.
 */
export default async function TenantBulkDeletePostsPage({
  params,
}: Readonly<{
  params: Promise<{ subdomain: string }>;
}>) {
  const { subdomain } = await params;
  return <BulkDeletePage subdomain={subdomain} />;
}
