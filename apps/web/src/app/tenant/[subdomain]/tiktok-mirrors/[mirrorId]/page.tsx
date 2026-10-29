import * as React from 'react';

import { TikTokDetailShell } from '@/components/tiktok/tiktok-detail-shell';

interface TikTokMirrorDetailPageProps {
  params: Promise<{ subdomain: string; mirrorId: string }>;
}

export default async function TikTokMirrorDetailPage({
  params,
}: Readonly<TikTokMirrorDetailPageProps>) {
  const { subdomain, mirrorId } = await params;
  return (
    <React.Suspense>
      <TikTokDetailShell subdomain={subdomain} mirrorId={mirrorId} />
    </React.Suspense>
  );
}
