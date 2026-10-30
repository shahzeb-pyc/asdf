import type { Metadata } from 'next';
import { ThreadsAduHubPage } from '@/components/threads/auto-download-upload/threads-adu-hub-page';

export const metadata: Metadata = { title: 'Auto Download/Upload' };

export default async function TenantThreadsAutoDownloadUploadPage({
  params,
}: Readonly<{ params: Promise<{ subdomain: string }> }>) {
  const { subdomain } = await params;
  return <ThreadsAduHubPage subdomain={subdomain} />;
}
