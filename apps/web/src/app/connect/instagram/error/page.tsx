'use client';

import React, { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

import Link from 'next/link';

import { ConnectStatusLayout } from '@/components/accounts/connect-status-layout';
import { useBrandConfig } from '@/components/brand';
import { Button } from '@/components/shared/ui/button';

/**
 * Reason → copy mapping for the Instagram magic-link error page —
 * Facebook's `getConnectErrorCopy`, with Instagram copy. Reasons the
 * entry route emits that have no specific entry here
 * (`missing_token`, `expired_or_invalid`, `app_not_configured`,
 * `missing_code_or_state`, `credentials_required`) fall through to
 * the default expired/invalid copy, exactly as Facebook's does.
 */
export function getInstagramConnectErrorCopy(reason?: string | null): {
  title: string;
  description: string;
} {
  if (reason === 'cancelled') {
    return {
      title: 'Connection Canceled',
      description: 'Connection canceled. No changes were made. You can close this tab.',
    };
  }
  if (reason === 'scope_rejected') {
    return {
      title: 'Instagram Account Not Connected',
      description:
        'This Instagram account was not connected. A required permission was declined. Please reconnect and allow all requested permissions to continue.',
    };
  }
  if (reason === 'oauth_failed' || reason === 'internal_oauth_error') {
    return {
      title: "Couldn't Connect to Instagram",
      description: "Couldn't connect to Instagram. Check your permissions and try again.",
    };
  }
  return {
    title: 'Connection Link Expired or Invalid',
    description:
      'This Instagram authorization link has expired or is no longer valid (links are valid for 15 minutes). Please generate a fresh link.',
  };
}

export function InstagramConnectErrorView({
  reason,
}: Readonly<{ reason?: string | null | undefined }>) {
  // Spec 191: the dashboard name follows the request's brand.
  const brandConfig = useBrandConfig();
  const { title, description } = getInstagramConnectErrorCopy(reason);

  return (
    <ConnectStatusLayout
      testId="instagram-magic-connect-error"
      variant="error"
      title={title}
      description={description}
    >
      {reason === 'cancelled' ? null : (
        // Spec 208 (FB parity): every failure except an explicit
        // cancel gets a way forward — the back action returns the
        // user to the app host, where they can connect again from
        // Accounts. Relative `/`: this page is served from the
        // brand's app host, so it is the brand gateway host.
        <Button asChild data-testid="instagram-magic-connect-error-back">
          <Link href="/">
            Back to {brandConfig.shortName}
          </Link>
        </Button>
      )}
    </ConnectStatusLayout>
  );
}

function InstagramConnectErrorQueryReader() {
  const searchParams = useSearchParams();
  const reason = searchParams.get('reason');
  return <InstagramConnectErrorView reason={reason} />;
}

export default function InstagramConnectErrorPage() {
  return (
    <Suspense fallback={<InstagramConnectErrorView />}>
      <InstagramConnectErrorQueryReader />
    </Suspense>
  );
}
