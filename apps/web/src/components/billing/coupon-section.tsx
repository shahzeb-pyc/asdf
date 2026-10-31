'use client';

import * as React from 'react';
import { apiPost, buildTenantApiPath, getErrorMessage } from '@/lib/api';
import {
  CouponValidateResponseSchema,
  type CouponValidateResponse,
  type PlatformCounts,
} from '@/lib/api/schemas/billing';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { Input } from '@/components/shared/ui/input';

function kindLabel(kind: CouponValidateResponse['kind']): string {
  if (kind === 'percent_once') return 'Percent off, one-time';
  if (kind === 'percent_multi') return 'Percent off';
  return 'Balance';
}

/**
 * Coupon section for checkout. The preview is server-validated:
 * the code, the discount, and the new amount due all come from
 * /billing/coupons/validate — the client never computes money.
 * Only one coupon at a time: applying a different code replaces
 * the applied one, and a failed apply leaves the applied coupon
 * untouched. Removing clears the coupon; the submit paths then
 * charge the full amount again.
 *
 * When the coupon covers the full amount, no payment method is
 * needed: the section offers activation directly, and the parent
 * disables the bank/crypto submits while it is applied.
 */
export function CouponSection({
  subdomain,
  counts,
  applied,
  onAppliedChange,
  onActivateZeroDue,
  activating,
  disabled,
}: Readonly<{
  subdomain: string;
  counts: PlatformCounts;
  applied: CouponValidateResponse | null;
  onAppliedChange: (preview: CouponValidateResponse | null) => void;
  onActivateZeroDue: () => void;
  activating: boolean;
  disabled: boolean;
}>) {
  const [code, setCode] = React.useState('');
  const [applying, setApplying] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function apply(candidate: string) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      setError('Enter a coupon code first.');
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const preview = await apiPost(
        buildTenantApiPath(subdomain, '/billing/coupons/validate'),
        { code: trimmed, counts },
        { schema: CouponValidateResponseSchema }
      );
      onAppliedChange(preview);
      setCode('');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Coupon</CardTitle>
        <CardDescription>
          {applied
            ? 'One coupon per purchase. Applying a different code replaces this one.'
            : 'Have a coupon code? Apply it before you pay.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {applied ? (
          <div className="flex flex-col gap-3 rounded-md border border-line bg-panel px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-body font-medium text-ink">
                {applied.code} · {kindLabel(applied.kind)}
              </span>
              <span className="font-medium tabular-nums text-ink">−{applied.discountPkr} PKR</span>
            </div>
            <p className="text-body text-ink-sub">
              {applied.fullyCovered
                ? 'This coupon covers the full amount — no payment needed.'
                : `New amount due: ${applied.amountAfterDiscountPkr} PKR (was ${applied.amountDuePkr} PKR).`}
            </p>
            <div className="flex flex-wrap gap-2">
              {applied.fullyCovered ? (
                <Button
                  onClick={onActivateZeroDue}
                  loading={activating}
                  disabled={disabled || activating}
                >
                  Activate plan now
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onAppliedChange(null);
                  setError(null);
                }}
                disabled={disabled || activating}
              >
                Remove coupon
              </Button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          <label htmlFor="billing-coupon-code" className="text-body font-medium text-ink">
            {applied ? 'Use a different code' : 'Coupon code'}
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="billing-coupon-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void apply(code);
                }
              }}
              placeholder="e.g. SAVE20"
              autoCapitalize="characters"
              autoComplete="off"
              disabled={disabled || applying}
              className="sm:flex-1"
            />
            <Button
              variant="outline"
              onClick={() => void apply(code)}
              loading={applying}
              disabled={disabled || applying || code.trim().length === 0}
            >
              Apply
            </Button>
          </div>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Coupon not applied</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
