import type { Metadata } from 'next';
import React from 'react';
import { AdminSellerDetail } from '@/components/sellers/admin-seller-detail';

export const metadata: Metadata = { title: 'Seller detail' };

interface AdminSellerDetailPageProps {
  params: Promise<{ sellerId: string }>;
}

/**
 * Seller detail (admin section). Keeps the sellerId param; no
 * subdomain: the admin section is global.
 */
export default async function AdminSellerDetailPage({
  params,
}: Readonly<AdminSellerDetailPageProps>) {
  const { sellerId } = await params;
  return <AdminSellerDetail sellerId={sellerId} />;
}
