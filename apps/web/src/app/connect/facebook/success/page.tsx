'use client';

import React, { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

import { ConnectStatusLayout } from '@/components/accounts/connect-status-layout';

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
      variant: 'error',
      title: `You signed into ${params.newAccountName || 'another account'} instead of ${expected}.`,
      description: `${expected} still needs to be reconnected.`,
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
    </ConnectStatusLayout>
  );
}

function ConnectSuccessQueryReader() {
  const searchParams = useSearchParams();
  return (
    <ConnectSuccessView
      params={{
        alreadyConnected: searchParams.get('already_connected') === '1',
        accountName: searchParams.get('accountName') ?? undefined,
        reconnectedMismatch: searchParams.get('reconnected_mismatch') === '1',
        newAccountName: searchParams.get('newAccountName') ?? undefined,
        expectedAccountName: searchParams.get('expectedAccountName') ?? undefined,
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
