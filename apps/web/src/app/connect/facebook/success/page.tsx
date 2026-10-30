'use client';

import React, { Suspense } from 'react';
import { useSearchParams, type ReadonlyURLSearchParams } from 'next/navigation';

import Link from 'next/link';

import { ConnectStatusLayout } from '@/components/accounts/connect-status-layout';
import { Button } from '@/components/shared/ui/button';

export interface ConnectSuccessParams {
  alreadyConnected?: boolean | undefined;
  accountName?: string | undefined;
  reconnectedMismatch?: boolean | undefined;
  newAccountName?: string | undefined;
  expectedAccountName?: string | undefined;
}

/**
 * Param → copy mapping for the magic-link success page. Unlike the old
 * page, this reads the params the callback actually sets: a mismatch
 * is never reported as a plain success, and every variant names the
 * account. Confirmation copy is name + connected only — never pages.
 */
export function getConnectSuccessCopy(params: ConnectSuccessParams): {
  variant: 'success' | 'error';
  title: string;
  description: string;
} {
  if (params.reconnectedMismatch) {
    const expected = params.expectedAccountName || 'the expired account';
    return {
      // BL2 fix: the mismatched account IS connected (auto-saved as a
      // separate account) — say so plainly instead of reading like a
      // failed connect. Variant stays 'error' because action is still
      // needed: the expected account is not reconnected yet.
      variant: 'error',
      title: `${params.newAccountName || 'another account'} is now connected as a separate account.`,
      description: `${expected} still needs to be reconnected. Open your FBUploadPro dashboard, go to Facebook Accounts, and use Reconnect on ${expected}.`,
    };
  }
  if (params.alreadyConnected) {
    const name = params.accountName || 'Account';
    return {
      variant: 'success',
      title: `${name} already connected — session refreshed`,
      description:
        "You're all set! You can close this tab and return to your FBUploadPro dashboard.",
    };
  }
  const name = params.accountName;
  return {
    variant: 'success',
    title: name ? `${name} connected` : 'Facebook account connected',
    description:
      "You're all set! You can close this tab and return to your FBUploadPro dashboard.",
  };
}

export function ConnectSuccessView({
  params,
}: Readonly<{ params: ConnectSuccessParams }>) {
  const { variant, title, description } = getConnectSuccessCopy(params);
  return (
    <ConnectStatusLayout
      testId="magic-connect-success"
      variant={variant}
      title={title}
      description={description}
    >
      <div className="rounded-sm bg-subtle px-3.5 py-2.5 text-metadata text-ink-dim">
        Linked to FBUploadPro via Facebook.
      </div>
      {/* Audit UX1: if the original tab was closed, "close this tab
          and return" leaves the user to navigate manually — offer
          the dashboard link on every success variant, not just the
          mismatch one. */}
      {!params.reconnectedMismatch ? (
        <Button asChild variant="outline" className="mt-4">
          <Link href="/" data-testid="magic-success-dashboard-link">
            Back to FBUploadPro dashboard
          </Link>
        </Button>
      ) : null}
      {params.reconnectedMismatch ? (
        // BL2 fix: this device holds no session, so it cannot reconnect
        // the expected account itself — link back to the dashboard,
        // where the expected account's card Reconnect lives. Do not
        // fake a reconnect action here.
        <Button asChild variant="outline" className="mt-4">
          <Link href="/" data-testid="magic-mismatch-dashboard-link">
            Back to FBUploadPro dashboard
          </Link>
        </Button>
      ) : null}
    </ConnectStatusLayout>
  );
}

function ConnectSuccessQueryReader() {
  // useSearchParams() is typed non-null but returns null at runtime
  // when rendered outside the Suspense boundary (tests) or during
  // prerendering — never crash on it; a missing param simply means
  // the plain success variant.
  const searchParams = useSearchParams() as ReadonlyURLSearchParams | null;
  const get = (key: string): string | null => searchParams?.get(key) ?? null;
  return (
    <ConnectSuccessView
      params={{
        alreadyConnected: get('already_connected') === '1',
        accountName: get('accountName') ?? undefined,
        reconnectedMismatch: get('reconnected_mismatch') === '1',
        newAccountName: get('newAccountName') ?? undefined,
        expectedAccountName: get('expectedAccountName') ?? undefined,
      }}
    />
  );
}

export default function FacebookConnectSuccessPage() {
  return (
    <Suspense fallback={<ConnectSuccessView params={{}} />}>
      <ConnectSuccessQueryReader />
    </Suspense>
  );
}
