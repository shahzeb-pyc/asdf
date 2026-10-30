import type { Metadata } from 'next';
import { AduHubPage } from '@/components/auto-download-upload/adu-hub-page';

export const metadata: Metadata = { title: 'Auto Download/Upload' };

export default async function TenantAutoDownloadUploadPage({
  params,
}: Readonly<{ params: Promise<{ subdomain: string }> }>) {
  const { subdomain } = await params;
  return <AduHubPage subdomain={subdomain} />;
}
