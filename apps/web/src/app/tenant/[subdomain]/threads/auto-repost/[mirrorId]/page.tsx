import * as React from 'react';

import { ThreadsAutoRepostDetailShell } from '@/components/threads-auto-repost/threads-auto-repost-detail-shell';

interface ThreadsAutoRepostDetailPageProps {
  params: Promise<{ subdomain: string; mirrorId: string }>;
}

export default async function ThreadsAutoRepostDetailPage({ params }: Readonly<ThreadsAutoRepostDetailPageProps>) {
  const { subdomain, mirrorId } = await params;
  return (
    <React.Suspense>
      <ThreadsAutoRepostDetailShell subdomain={subdomain} mirrorId={mirrorId} />
    </React.Suspense>
  );
}
