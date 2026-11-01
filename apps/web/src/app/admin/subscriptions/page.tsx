import type { Metadata } from 'next';
import React from 'react';
import { AdminApprovalsView } from '@/components/billing/admin-approvals-view';

export const metadata: Metadata = { title: 'Subscriptions' };

/**
 * Subscriptions approvals (admin section): payments approve/reject,
 * counts, screenshot view, with the coupons tab and webhook-issues
 * section inside the same view. No subdomain: the admin section is
 * global.
 */
export default function AdminSubscriptionsPage() {
  return <AdminApprovalsView />;
}
