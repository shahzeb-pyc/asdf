import type { Metadata } from 'next';
import { ThreadsAduDetailPage } from '@/components/threads/auto-download-upload/threads-adu-detail-page';

export const metadata: Metadata = { title: 'Auto Download/Upload' };

export default async function TenantThreadsAduDetailPage({
  params,
}: Readonly<{ params: Promise<{ subdomain: string; id: string }> }>) {
  const { subdomain, id } = await params;
  return <ThreadsAduDetailPage subdomain={subdomain} configId={id} />;
}
