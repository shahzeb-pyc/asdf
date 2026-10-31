import type { Metadata } from 'next';
import { IgAduDetailPage } from '@/components/instagram/auto-download-upload/ig-adu-detail-page';

export const metadata: Metadata = { title: 'Auto Download/Upload' };

export default async function TenantInstagramAduDetailPage({
  params,
}: Readonly<{ params: Promise<{ subdomain: string; id: string }> }>) {
  const { subdomain, id } = await params;
  return <IgAduDetailPage subdomain={subdomain} configId={id} />;
}
