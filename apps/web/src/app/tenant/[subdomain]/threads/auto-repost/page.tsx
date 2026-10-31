import * as React from 'react';

import { ThreadsAutoRepostShell } from '@/components/threads-auto-repost/threads-auto-repost-shell';

interface ThreadsAutoRepostPageProps {
  params: Promise<{ subdomain: string }>;
}

export default async function ThreadsAutoRepostPage({ params }: Readonly<ThreadsAutoRepostPageProps>) {
  const { subdomain } = await params;
  // The shell reads ?page= via useSearchParams, which needs a Suspense
  // boundary above it (same pattern as the Facebook mirrors page).
  return (
    <React.Suspense>
      <ThreadsAutoRepostShell subdomain={subdomain} />
    </React.Suspense>
  );
}
