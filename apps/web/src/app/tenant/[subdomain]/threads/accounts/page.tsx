'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { ThreadsAccountsShell } from '@/components/accounts/threads-accounts-shell';

/**
 * Threads accounts route — the real list, replacing the former
 * PlatformAccountsShell placeholder. The shell is client-side (it
 * reads ?page= from the URL, so it sits inside a Suspense boundary,
 * as Next requires for useSearchParams).
 */
export default function ThreadsAccountsPage() {
  const params = useParams();
  const subdomain = (params?.subdomain as string) || '';

  return (
    <React.Suspense>
      <ThreadsAccountsShell subdomain={subdomain} />
    </React.Suspense>
  );
}
