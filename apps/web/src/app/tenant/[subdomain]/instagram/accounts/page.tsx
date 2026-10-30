'use client';

import React from 'react';
import { useParams } from 'next/navigation';
import { InstagramAccountsShell } from '@/components/accounts/instagram-accounts-shell';

/**
 * Instagram Accounts — the real accounts list (no longer the shared
 * placeholder shell: Threads, X, TikTok, and YouTube still use that
 * shell, but Instagram now has its own list, modelled on Facebook
 * Accounts). The placeholder's testing notice and "Return to Overview"
 * are gone with it; the placeholder's own description lives on in the
 * shell's empty state, verbatim.
 */
export default function InstagramAccountsPage() {
  const params = useParams();
  const subdomain = (params?.subdomain as string) || '';

  return <InstagramAccountsShell subdomain={subdomain} />;
}
