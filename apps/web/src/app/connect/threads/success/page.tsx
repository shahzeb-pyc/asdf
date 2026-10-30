'use client';

import React, { Suspense } from 'react';
import { useSearchParams, type ReadonlyURLSearchParams } from 'next/navigation';

import { ConnectStatusLayout } from '@/components/accounts/connect-status-layout';

export interface ThreadsConnectSuccessParams {
  alreadyConnected?: boolean | undefined;
  accountName?: string | undefined;
  reconnectedMismatch?: boolean | undefined;
  newAccountName?: string | undefined;
  expectedAccountName?: string | undefined;
}

/**
 * Param → copy mapping for the Threads magic-link success page,
 * mirroring Facebook's (`/connect/facebook/success`): a mismatch
 * is never reported as a plain success, and every variant names
 * the account. Confirmation copy is name + connected only.
 */
export function getThreadsConnectSuccessCopy(params: ThreadsConnectSuccessParams): {
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
    title: name ? `${name} connected` : 'Threads account connected',
    description:
      "You're all set! You can close this tab and return to your FBUploadPro dashboard.",
  };
}

export function ThreadsConnectSuccessView({
  params,
}: Readonly<{ params: ThreadsConnectSuccessParams }>) {
  const { variant, title, description } = getThreadsConnectSuccessCopy(params);
  return (
    <ConnectStatusLayout
      testId="threads-magic-connect-success"
      variant={variant}
      title={title}
      description={description}
    >
      <div className="rounded-sm bg-subtle px-3.5 py-2.5 text-metadata text-ink-dim">
        Linked to FBUploadPro via Threads.
      </div>
    </ConnectStatusLayout>
  );
}

function ThreadsConnectSuccessQueryReader() {
  // useSearchParams() is typed non-null but returns null at runtime
  // when rendered outside the Suspense boundary (tests) or during
  // prerendering — never crash on it; a missing param simply means
  // the plain success variant.
  const searchParams = useSearchParams() as ReadonlyURLSearchParams | null;
  const get = (key: string): string | null => searchParams?.get(key) ?? null;
  return (
    <ThreadsConnectSuccessView
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

export default function ThreadsConnectSuccessPage() {
  return (
    <Suspense fallback={<ThreadsConnectSuccessView params={{}} />}>
      <ThreadsConnectSuccessQueryReader />
    </Suspense>
  );
}
