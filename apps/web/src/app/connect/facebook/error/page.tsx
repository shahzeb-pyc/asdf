'use client';

import React, { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { ConnectStatusLayout } from '@/components/accounts/connect-status-layout';
import { Button } from '@/components/shared/ui/button';
import {
  buildScopeRejectionMessage,
  parseMissingScopesParam,
} from '@/lib/facebook-permissions';

/**
 * Reason → copy mapping (spec 136 §3.4, OD-136-4 default: keep the
 * existing map for the reasons it covers).
 *
 * Audit UX1: distinct failures must not all read as "link
 * expired" — a BYOC-misconfiguration failure sent users into a
 * generate → fail → "expired" loop. `app_not_configured` and
 * `credentials_required` get their own copy pointing at the
 * workspace's Facebook app setup, `missing_token` gets its own
 * invalid-link copy, and only genuinely unknown reasons fall
 * through to the expired/invalid default.
 */
export function getConnectErrorCopy(
  reason?: string | null,
  missing?: string | null
): {
  title: string;
  description: string;
} {
  if (reason === 'scope_rejected') {
    // Same hard rejection as the direct flow's Accounts banner:
    // nothing was saved, and the missing scopes are named in plain
    // language instead of a generic permissions line.
    return {
      title: 'Facebook Account Not Connected',
      description: buildScopeRejectionMessage(
        parseMissingScopesParam(missing)
      ),
    };
  }
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
  if (reason === 'app_not_configured' || reason === 'credentials_required') {
    // Audit UX1: the workspace has no Facebook App ID/Secret (or
    // they were removed between link generation and callback). A
    // fresh link cannot fix this — the workspace owner must add
    // them in Workspace Settings → Facebook first.
    return {
      title: 'Facebook App Not Configured',
      description:
        'This workspace doesn’t have a Facebook App ID and Secret configured yet, so the connection can’t be completed. Ask the workspace owner to add them in Workspace Settings → Facebook, then generate a fresh link.',
    };
  }
  if (reason === 'missing_token') {
    // Audit UX1: a link with no token is invalid, not expired —
    // saying "expired" sends the user to regenerate a link that
    // was never valid in the first place.
    return {
      title: 'Connection Link Invalid',
      description:
        'This link is missing its authorization token and can’t be used. Please generate a fresh link from your FBUploadPro dashboard.',
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
  missing,
}: Readonly<{
  reason?: string | null | undefined;
  missing?: string | null | undefined;
}>) {
  const { title, description } = getConnectErrorCopy(reason, missing);

  return (
    <ConnectStatusLayout
      testId="magic-connect-error"
      variant="error"
      title={title}
      description={description}
    >
      {reason === 'cancelled' ? null : (
        // Audit UX1: every failure except an explicit cancel gets a
        // way forward. This device holds no session, so it cannot
        // restart the connect itself — the back action returns the
        // user to FBUploadPro, where they can connect again from
        // Accounts (BL1 established this pattern for save failures).
        <Button asChild data-testid="magic-connect-error-back">
          <Link href={process.env.NEXT_PUBLIC_APP_URL || '/'}>
            Back to FBUploadPro
          </Link>
        </Button>
      )}
    </ConnectStatusLayout>
  );
}

function ConnectErrorQueryReader() {
  const searchParams = useSearchParams();
  const reason = searchParams.get('reason');
  const missing = searchParams.get('missing');
  return <ConnectErrorView reason={reason} missing={missing} />;
}

export default function FacebookConnectErrorPage() {
  return (
    <Suspense fallback={<ConnectErrorView />}>
      <ConnectErrorQueryReader />
    </Suspense>
  );
}
