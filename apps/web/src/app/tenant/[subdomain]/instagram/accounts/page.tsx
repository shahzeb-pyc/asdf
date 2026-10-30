'use client';

import React, { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { InstagramAccountsShell } from '@/components/accounts/instagram-accounts-shell';

/**
 * Instagram Accounts — the real accounts list (no longer the shared
 * placeholder shell: Threads, X, TikTok, and YouTube still use that
 * shell, but Instagram now has its own list, exactly like Facebook
 * Accounts). The placeholder's testing notice and "Return to Overview"
 * are gone with it; the placeholder's own description lives on in the
 * shell's empty state, verbatim.
 *
 * The shell reads search params (pagination `?page=` and OAuth-return
 * notices), so it is mounted inside a Suspense boundary — under
 * Next 16 the bailout is contained to the island, exactly as on
 * Facebook Accounts.
 */
export default function InstagramAccountsPage() {
  const params = useParams();
  const subdomain = (params?.subdomain as string) || '';

  return (
    <Suspense>
      <InstagramAccountsShell subdomain={subdomain} />
    </Suspense>
  );
}
