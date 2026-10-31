import React, { Suspense } from 'react';
import { SellerDashboard } from '@/components/sellers/seller-dashboard';

/** Seller dashboard page — the layout guards the session. */
export default function SellerPage() {
  return (
    <Suspense fallback={<p className="text-body text-ink-dim">Loading…</p>}>
      <SellerDashboard />
    </Suspense>
  );
}
