import type { Metadata } from 'next';
import { CreatorFinderPage } from '@/components/creator-finder/creator-finder-page';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Creator Finder' };

/**
 * Creator Finder — find TikTok creators only. Four tabs in, one
 * result shape out: trending creators by country, creators by
 * niche/words, similar creators expanded from a known creator,
 * and saved creators. Every search result is saved automatically
 * to the Saved tab (and exportable as CSV); nothing here contacts,
 * publishes, or mirrors a creator.
 */
export default async function TenantCreatorFinderPage({
  params,
}: Readonly<{
  params: Promise<{ subdomain: string }>;
}>) {
  const { subdomain } = await params;
  return <CreatorFinderPage subdomain={subdomain} />;
}
