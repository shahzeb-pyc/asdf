import * as React from 'react';

import { IgAutoRepostDetailShell } from '@/components/instagram/auto-repost/ig-auto-repost-detail-shell';

interface IgAutoRepostDetailPageProps {
  params: Promise<{ subdomain: string; mirrorId: string }>;
}

export default async function IgAutoRepostDetailPage({ params }: Readonly<IgAutoRepostDetailPageProps>) {
  const { subdomain, mirrorId } = await params;
  return (
    <React.Suspense>
      <IgAutoRepostDetailShell subdomain={subdomain} mirrorId={mirrorId} />
    </React.Suspense>
  );
}
