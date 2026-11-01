'use client';

import * as React from 'react';
import { apiGet, apiPatch, apiPost, getErrorMessage } from '@/lib/api';
import {
  CouponRedemptionsResponseSchema,
  CouponsListResponseSchema,
  type Coupon,
  type CouponRedemptionsResponse,
  type CouponsListResponse,
} from '@/lib/api/schemas/billing';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Input } from '@/components/shared/ui/input';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { BillingStatusMark } from './billing-status-mark';

function kindLabel(kind: Coupon['kind']): string {
  if (kind === 'percent_once') return 'Percent off, one-time';
  if (kind === 'percent_multi') return 'Percent off, multi-use';
  return 'Balance';
}

function valueLabel(coupon: Coupon): string {
  if (coupon.kind === 'balance') {
    return `${coupon.initialBalancePkr ?? 0} PKR total · ${coupon.remainingBalancePkr ?? 0} PKR left`;
  }
  return `${coupon.percent ?? 0}% off`;
}

function stateLabel(coupon: Coupon): string {
  if (coupon.kind === 'percent_once') {
    return coupon.consumedAt ? 'Used' : 'Not used yet';
  }
  if (coupon.kind === 'percent_multi') {
    return 'Usable until paused or deleted';
  }
  return (coupon.remainingBalancePkr ?? 0) <= 0 ? 'Exhausted' : 'Balance left';
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

/**
 * Admin coupons section: list, create, pause/resume, soft delete,
 * and redemption history per coupon. Admin-only by route guard;
 * this view never renders for non-admins (the billing page routes
 * them to the user view instead).
 *
 * Delete is soft: the row and its history stay, only new uses
 * stop. Pausing blocks new uses but leaves already-held
 * redemptions alone — they still apply or release on their own
 * payment's outcome.
 */
export function AdminCouponsView() {
  const [data, setData] = React.useState<CouponsListResponse | null>(null);
  const [page, setPage] = React.useState(1);
  const [error, setError] = React.useState<string | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const [kind, setKind] = React.useState<Coupon['kind']>('percent_multi');
  const [code, setCode] = React.useState('');
  const [percent, setPercent] = React.useState('20');
  const [valuePkr, setValuePkr] = React.useState('1000');
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);

  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [redemptions, setRedemptions] = React.useState<CouponRedemptionsResponse | null>(null);
  const [redemptionsLoading, setRedemptionsLoading] = React.useState(false);
  const [redemptionsError, setRedemptionsError] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (targetPage: number) => {
      try {
        const result = await apiGet(
          `/api/admin/coupons?page=${targetPage}`,
          { schema: CouponsListResponseSchema }
        );
        setData(result);
        setPage(targetPage);
        setError(null);
      } catch (err) {
        setError(getErrorMessage(err));
      }
    },
    []
  );

  React.useEffect(() => {
    void load(1);
  }, [load]);

  async function handleRetry() {
    setReloading(true);
    try {
      await load(page);
    } finally {
      setReloading(false);
    }
  }

  async function create() {
    setCreating(true);
    setCreateError(null);
    setNotice(null);
    try {
      const body: Record<string, unknown> = { code: code.trim(), kind };
      if (kind === 'balance') {
        const parsed = Math.floor(Number(valuePkr));
        if (!Number.isFinite(parsed) || parsed < 1) {
          setCreateError('Enter a PKR value of at least 1.');
          return;
        }
        body['valuePkr'] = parsed;
      } else {
        const parsed = Math.floor(Number(percent));
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
          setCreateError('Enter a percent between 1 and 100.');
          return;
        }
        body['percent'] = parsed;
      }
      await apiPost('/api/admin/coupons', body);
      setNotice(`Coupon ${code.trim().toUpperCase()} created.`);
      setCode('');
      await load(1);
    } catch (err) {
      setCreateError(getErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function act(coupon: Coupon, action: 'pause' | 'resume' | 'delete') {
    setBusyId(coupon.id);
    setNotice(null);
    setError(null);
    try {
      await apiPatch(`/api/admin/coupons/${coupon.id}`, {
        action,
      });
      setNotice(
        action === 'pause'
          ? `Coupon ${coupon.code} paused. New uses are blocked; held uses are unaffected.`
          : action === 'resume'
            ? `Coupon ${coupon.code} resumed.`
            : `Coupon ${coupon.code} deleted. Past history is kept; no new uses.`
      );
      await load(page);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function toggleRedemptions(coupon: Coupon) {
    if (expandedId === coupon.id) {
      setExpandedId(null);
      setRedemptions(null);
      return;
    }
    setExpandedId(coupon.id);
    setRedemptions(null);
    setRedemptionsError(null);
    setRedemptionsLoading(true);
    try {
      const result = await apiGet(
        `/api/admin/coupons/${coupon.id}/redemptions`,
        { schema: CouponRedemptionsResponseSchema }
      );
      setRedemptions(result);
    } catch (err) {
      setRedemptionsError(getErrorMessage(err));
    } finally {
      setRedemptionsLoading(false);
    }
  }

  if (error && !data) {
    return (
      <div className="flex flex-col gap-6">
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load coupons</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <div>
          <Button onClick={() => void handleRetry()} loading={reloading}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div aria-busy="true" aria-label="Loading coupons" className="flex flex-col gap-6">
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-32" />
          </CardContent>
        </Card>
      </div>
    );
  }

  const coupons = data.coupons;

  return (
    <div className="flex flex-col gap-6">
      {notice ? (
        <Alert variant="success">
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t save that</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Create a coupon</CardTitle>
          <CardDescription>
            Codes are not tied to one user — anyone can use any coupon. A one-time percent
            coupon dies on first use; a multi-use percent coupon lives until you pause or
            delete it; a balance coupon is a shared pool that drains until it hits 0.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="admin-coupon-kind" className="text-body font-medium text-ink">
              Kind
            </label>
            <select
              id="admin-coupon-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as Coupon['kind'])}
              disabled={creating}
              className="h-10 rounded-md border border-line bg-panel px-3 text-body text-ink"
            >
              <option value="percent_multi">Percent off, multi-use</option>
              <option value="percent_once">Percent off, one-time</option>
              <option value="balance">Balance (PKR pool)</option>
            </select>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="admin-coupon-code" className="text-body font-medium text-ink">
              Code
            </label>
            <Input
              id="admin-coupon-code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="e.g. SAVE20"
              autoCapitalize="characters"
              autoComplete="off"
              disabled={creating}
            />
          </div>
          {kind === 'balance' ? (
            <div className="flex flex-col gap-2">
              <label htmlFor="admin-coupon-value" className="text-body font-medium text-ink">
                PKR value
              </label>
              <Input
                id="admin-coupon-value"
                value={valuePkr}
                onChange={(event) => setValuePkr(event.target.value)}
                inputMode="numeric"
                disabled={creating}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label htmlFor="admin-coupon-percent" className="text-body font-medium text-ink">
                Percent (1–100)
              </label>
              <Input
                id="admin-coupon-percent"
                value={percent}
                onChange={(event) => setPercent(event.target.value)}
                inputMode="numeric"
                disabled={creating}
              />
            </div>
          )}
          <div>
            <Button
              onClick={() => void create()}
              loading={creating}
              disabled={creating || code.trim().length === 0}
            >
              Create coupon
            </Button>
          </div>
          {createError ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn&apos;t create that coupon</AlertTitle>
              <AlertDescription>{createError}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <section aria-label="Coupons" className="flex flex-col gap-4">
        <h2 className="text-lg leading-heading font-semibold text-ink">Coupons</h2>
        {coupons.length === 0 ? (
          <EmptyState
            type="first-use"
            title="No coupons yet"
            description="Create one above. Percent coupons take a percent; balance coupons take a PKR pool."
          />
        ) : null}
        {coupons.map((coupon) => {
          const isBusy = busyId === coupon.id;
          const expanded = expandedId === coupon.id;
          return (
            <Card key={coupon.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <CardTitle className="truncate">{coupon.code}</CardTitle>
                    <CardDescription>
                      {kindLabel(coupon.kind)} · {valueLabel(coupon)} · {stateLabel(coupon)} ·{' '}
                      {coupon.redemptionsCount} redemptions · Created {formatDate(coupon.createdAt)}
                    </CardDescription>
                  </div>
                  {coupon.status === 'active' ? (
                    <BillingStatusMark kind="ok" label="Active" />
                  ) : coupon.status === 'paused' ? (
                    <BillingStatusMark kind="pending" label="Paused" />
                  ) : (
                    <BillingStatusMark kind="failed" label="Deleted" />
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  {coupon.status === 'active' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void act(coupon, 'pause')}
                      loading={isBusy}
                      disabled={isBusy}
                    >
                      Pause
                    </Button>
                  ) : null}
                  {coupon.status === 'paused' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void act(coupon, 'resume')}
                      loading={isBusy}
                      disabled={isBusy}
                    >
                      Resume
                    </Button>
                  ) : null}
                  {coupon.status !== 'deleted' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void act(coupon, 'delete')}
                      loading={isBusy}
                      disabled={isBusy}
                    >
                      Delete
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => void toggleRedemptions(coupon)}>
                    {expanded ? 'Hide history' : 'Show history'}
                  </Button>
                </div>
                {expanded ? (
                  <div className="flex flex-col gap-2 border-t border-line pt-4">
                    {redemptionsLoading ? (
                      <Skeleton className="h-10 w-full" />
                    ) : redemptionsError ? (
                      <Alert variant="destructive">
                        <AlertTitle>Couldn&apos;t load history</AlertTitle>
                        <AlertDescription>{redemptionsError}</AlertDescription>
                      </Alert>
                    ) : redemptions && redemptions.redemptions.length === 0 ? (
                      <p className="text-body text-ink-sub">No redemptions yet.</p>
                    ) : (
                      redemptions?.redemptions.map((redemption) => (
                        <div
                          key={redemption.id}
                          className="flex flex-wrap items-baseline justify-between gap-2 text-body"
                        >
                          <span className="text-ink">
                            {redemption.userEmail ?? 'Unknown user'} · {formatDate(redemption.createdAt)}
                          </span>
                          <span className="text-ink-sub">
                            {redemption.amountPkr} PKR ·{' '}
                            {redemption.status === 'applied'
                              ? 'Applied'
                              : redemption.status === 'released'
                                ? 'Released'
                                : 'Held'}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
        {coupons.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={page <= 1} onClick={() => void load(page - 1)}>
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={coupons.length < 20}
              onClick={() => void load(page + 1)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
