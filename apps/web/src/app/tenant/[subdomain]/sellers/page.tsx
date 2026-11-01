import React, { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getServerSessionContext } from '@/lib/auth';
import { AdminSellersList } from '@/components/sellers/admin-sellers-list';

/**
 * Admin sellers page — list, create, and the payout queue. The
 * admin role is guarded server-side here (the sidebar leaf only
 * renders for admins, but the route itself must not rely on that).
 */
export default async function SellersPage({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  const session = await getServerSessionContext();
  if (!session || session.role !== 'admin') {
    redirect(`/tenant/${subdomain}`);
  }

  return (
    <div className="px-3 py-4 sm:px-4">
      <Suspense fallback={<p className="text-body text-ink-dim">Loading…</p>}>
        <AdminSellersList subdomain={subdomain} />
      </Suspense>
    </div>
  );
}
