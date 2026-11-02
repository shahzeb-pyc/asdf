'use client';

/**
 * RefundView — the Refund section only, split out of the old
 * BillingView in the 2026-11-02 separate-sections build.
 *
 * The section is mounted regardless of plan state, shows the
 * ineligibility reason and the full refund history unconditionally,
 * and has its own error state (the old section returned null on
 * error, which on a dedicated page would read as "no refunds").
 * No user-side cancel/withdraw of a pending refund in this build;
 * no in-app refund payout.
 */

import * as React from 'react';

import { RefundSection } from './refund-section';

export function RefundView({ subdomain }: Readonly<{ subdomain: string }>) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl leading-heading font-semibold text-ink">Refund</h1>
        <p className="text-body text-ink-sub">
          Your monthly plan refunds. Only your first purchase can be refunded, within 7 days of
          approval, and the refund is what you paid minus the days you used. Refunds are paid
          outside the app and then marked sent here.
        </p>
      </div>
      <RefundSection subdomain={subdomain} standalone />
    </div>
  );
}
