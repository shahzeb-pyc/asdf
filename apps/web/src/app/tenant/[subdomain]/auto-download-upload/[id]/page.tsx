import type { Metadata } from 'next';
import { AduDetailPage } from '@/components/auto-download-upload/adu-detail-page';

export const metadata: Metadata = { title: 'Auto Download/Upload' };

export default async function TenantAduDetailPage({
  params,
}: Readonly<{ params: Promise<{ subdomain: string; id: string }> }>) {
  const { subdomain, id } = await params;
  return <AduDetailPage subdomain={subdomain} configId={id} />;
}
