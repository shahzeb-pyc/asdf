import * as React from 'react';

import { TikTokShell } from '@/components/tiktok/tiktok-shell';

interface TikTokMirrorsPageProps {
  params: Promise<{ subdomain: string }>;
}

export default async function TikTokMirrorsPage({ params }: Readonly<TikTokMirrorsPageProps>) {
  const { subdomain } = await params;
  // The shell reads ?page= via useSearchParams, which needs a Suspense
  // boundary above it (same pattern as the Pages page).
  return (
    <React.Suspense>
      <TikTokShell subdomain={subdomain} />
    </React.Suspense>
  );
}
