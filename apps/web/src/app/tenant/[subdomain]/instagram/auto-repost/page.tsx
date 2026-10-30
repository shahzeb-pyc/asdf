import * as React from 'react';

import { IgAutoRepostShell } from '@/components/instagram/auto-repost/ig-auto-repost-shell';

interface IgAutoRepostPageProps {
  params: Promise<{ subdomain: string }>;
}

export default async function IgAutoRepostPage({ params }: Readonly<IgAutoRepostPageProps>) {
  const { subdomain } = await params;
  // The shell reads ?page= via useSearchParams, which needs a Suspense
  // boundary above it (same pattern as the TikTok mirrors page).
  return (
    <React.Suspense>
      <IgAutoRepostShell subdomain={subdomain} />
    </React.Suspense>
  );
}
