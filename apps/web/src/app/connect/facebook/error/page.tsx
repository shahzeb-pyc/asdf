'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { ConnectStatusLayout } from '@/components/accounts/connect-status-layout';
import { Button } from '@/components/shared/ui/button';

/**
 * Reason → copy mapping (spec 136 §3.4, preserved verbatim — OD-136-4
 * default: keep the existing map). Reasons the entry route emits that
 * have no specific entry here (`missing_token`, `expired_or_invalid`,
 * `app_not_configured`) fall through to the default expired/invalid
 * copy, exactly as before this rebuild.
 */
export function getConnectErrorCopy(reason?: string | null): {
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
      title: "Couldn't Connect to Facebook",
      description: "Couldn't connect to Facebook. Check your permissions and try again.",
    };
  }
  if (reason === 'account_save_failed') {
    // BL1 fix: a failed account save is not a permissions problem and
    // not an expired link, so it gets its own copy — never the
    // fallthrough below, which would send the user into a
    // generate-a-fresh-link loop for a failure a fresh link cannot fix.
    return {
      title: "Couldn't Save Your Facebook Account",
      description:
        'Facebook approved the connection, but we couldn\u2019t save the account. Nothing was connected. Please try connecting again from your FBUploadPro dashboard.',
    };
  }
  return {
    title: 'Connection Link Expired or Invalid',
    description:
      'This Facebook authorization link has expired or is no longer valid (links are valid for 15 minutes). Please generate a fresh link.',
  };
}

export function ConnectErrorView({
  reason,
}: Readonly<{ reason?: string | null | undefined }>) {
  const { title, description } = getConnectErrorCopy(reason);

  return (
    <ConnectStatusLayout
      testId="magic-connect-error"
      variant="error"
      title={title}
      description={description}
    >
      {reason === 'account_save_failed' ? (
        // BL1 fix: the magic error page previously had no action at all.
        // This device holds no session, so it cannot restart the connect
        // itself — the back action returns the user to FBUploadPro, where
        // they can connect again from Accounts.
        <Button asChild data-testid="magic-connect-error-back">
          <Link href={process.env.NEXT_PUBLIC_APP_URL || '/'}>
            Back to FBUploadPro
          </Link>
        </Button>
      ) : null}
    </ConnectStatusLayout>
  );
}

function ConnectErrorQueryReader() {
  const searchParams = useSearchParams();
  const reason = searchParams.get('reason');
  return <ConnectErrorView reason={reason} />;
}

export default function FacebookConnectErrorPage() {
  return (
    <Suspense fallback={<ConnectErrorView />}>
      <ConnectErrorQueryReader />
    </Suspense>
  );
}
