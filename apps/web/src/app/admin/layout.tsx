import type { Metadata } from 'next';
import React from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionSecret, verifySessionToken } from '@fbuploadpro/contracts';
import { AdminShell } from '@/components/shell/admin-shell';

export const metadata: Metadata = {
  title: 'Admin',
};

/**
 * Admin section layout — the global admin frame (shell isolation).
 * Guarded server-side with the full session token, mirroring the
 * seller layout's pattern (the shared getServerSessionContext drops
 * status, which this guard needs): only an admin session renders
 * it. Anything else goes to login, suspended admins to the
 * suspended page, users to their own workspace home, sellers to
 * /seller. Middleware redirects non-admins first; this is the
 * backstop. AdminShell never renders for a non-admin.
 */
export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  let token: string | undefined;
  try {
    token = (await cookies()).get('fbup_session')?.value;
  } catch {
    token = undefined;
  }

  if (!token) {
    redirect('/login?returnUrl=%2Fadmin%2Fsubscriptions');
  }

  let session;
  try {
    session = await verifySessionToken(token, getSessionSecret());
  } catch {
    redirect('/login?returnUrl=%2Fadmin%2Fsubscriptions');
  }

  if (session.status === 'suspended') {
    redirect('/account-suspended');
  }
  if (session.role === 'seller') {
    redirect('/seller');
  }
  if (session.role !== 'admin') {
    redirect(`/tenant/${session.subdomain}`);
  }

  const user = {
    name: session.name ?? session.email.split('@')[0],
    email: session.email,
  };

  return <AdminShell user={user}>{children}</AdminShell>;
}
