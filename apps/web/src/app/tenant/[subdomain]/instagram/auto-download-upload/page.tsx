import type { Metadata } from 'next';
import { IgAduHubPage } from '@/components/instagram/auto-download-upload/ig-adu-hub-page';

export const metadata: Metadata = { title: 'Auto Download/Upload' };

export default async function TenantInstagramAutoDownloadUploadPage({
  params,
}: Readonly<{ params: Promise<{ subdomain: string }> }>) {
  const { subdomain } = await params;
  return <IgAduHubPage subdomain={subdomain} />;
}
