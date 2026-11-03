import type { Metadata } from 'next';
import React from 'react';

import { MusePage } from '@/components/muse/muse-page';

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template. */
export const metadata: Metadata = { title: 'Muse Assistant' };

/**
 * Muse — the page where a user connects Muse with a Media
 * Library key, and sees what Muse has uploaded to their Media
 * Library today and on earlier days.
 */
export default async function TenantMusePage({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  return <MusePage subdomain={subdomain} />;
}
