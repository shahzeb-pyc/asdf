import type { Metadata } from 'next';
import { CreatorFinderPage } from '@/components/creator-finder/creator-finder-page';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Creator Finder' };

/**
 * Creator Finder — find TikTok creators only. Three ways in, one
 * result shape out: trending creators by country, creators by
 * niche/words, and similar creators expanded from a known creator.
 * Nothing here contacts, publishes, mirrors, or saves a creator.
 */
export default async function TenantCreatorFinderPage({
  params,
}: Readonly<{
  params: Promise<{ subdomain: string }>;
}>) {
  const { subdomain } = await params;
  return <CreatorFinderPage subdomain={subdomain} />;
}
