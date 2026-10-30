'use client';

import React, { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

import { ConnectStatusLayout } from '@/components/accounts/connect-status-layout';

/**
 * Reason → copy mapping, mirroring Facebook's
 * (`/connect/facebook/error`). Reasons the entry route emits that
 * have no specific entry here (`missing_token`,
 * `expired_or_invalid`, `app_not_configured`) fall through to the
 * default expired/invalid copy, exactly as Facebook's does.
 */
export function getThreadsConnectErrorCopy(reason?: string | null): {
  title: string;
  description: string;
} {
  if (reason === 'cancelled') {
    return {
      title: 'Connection Canceled',
      description: 'Connection canceled. No changes were made. You can close this tab.',
    };
  }
  if (reason === 'oauth_failed' || reason === 'internal_oauth_error') {
    return {
      title: "Couldn't Connect to Threads",
      description: "Couldn't connect to Threads. Check your permissions and try again.",
    };
  }
  return {
    title: 'Connection Link Expired or Invalid',
    description:
      'This Threads authorization link has expired or is no longer valid (links are valid for 15 minutes). Please generate a fresh link.',
  };
}

export function ThreadsConnectErrorView({
  reason,
}: Readonly<{ reason?: string | null | undefined }>) {
  const { title, description } = getThreadsConnectErrorCopy(reason);

  return (
    <ConnectStatusLayout
      testId="threads-magic-connect-error"
      variant="error"
      title={title}
      description={description}
    />
  );
}

function ThreadsConnectErrorQueryReader() {
  const searchParams = useSearchParams();
  const reason = searchParams.get('reason');
  return <ThreadsConnectErrorView reason={reason} />;
}

export default function ThreadsConnectErrorPage() {
  return (
    <Suspense fallback={<ThreadsConnectErrorView />}>
      <ThreadsConnectErrorQueryReader />
    </Suspense>
  );
}
