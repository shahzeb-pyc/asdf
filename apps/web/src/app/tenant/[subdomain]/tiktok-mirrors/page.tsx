import * as React from 'react';

import { TikTokShell } from '@/components/tiktok/tiktok-shell';

interface TikTokMirrorsPageProps {
  params: Promise<{ subdomain: string }>;
}

export default async function TikTokMirrorsPage({ params }: Readonly<TikTokMirrorsPageProps>) {
  const { subdomain } = await params;
  return <TikTokShell subdomain={subdomain} />;
}
