import type { Metadata } from 'next';
import React from 'react';
import { AdminSellersList } from '@/components/sellers/admin-sellers-list';

export const metadata: Metadata = { title: 'Sellers' };

/**
 * Sellers list + create + payout queue (admin section). No
 * subdomain: the admin section is global.
 */
export default function AdminSellersPage() {
  return <AdminSellersList />;
}
