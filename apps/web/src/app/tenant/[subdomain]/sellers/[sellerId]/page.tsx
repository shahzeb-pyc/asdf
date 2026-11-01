import React, { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getServerSessionContext } from '@/lib/auth';
import { AdminSellerDetail } from '@/components/sellers/admin-seller-detail';

/** Admin per-seller detail page. Admin role guarded server-side. */
export default async function SellerDetailPage({
  params,
}: {
  params: Promise<{ subdomain: string; sellerId: string }>;
}) {
  const { subdomain, sellerId } = await params;
  const session = await getServerSessionContext();
  if (!session || session.role !== 'admin') {
    redirect(`/tenant/${subdomain}`);
  }

  return (
    <div className="px-3 py-4 sm:px-4">
      <Suspense fallback={<p className="text-body text-ink-dim">Loading…</p>}>
        <AdminSellerDetail subdomain={subdomain} sellerId={sellerId} />
      </Suspense>
    </div>
  );
}
