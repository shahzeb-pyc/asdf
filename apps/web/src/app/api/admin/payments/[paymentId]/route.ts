import { type NextRequest, NextResponse } from 'next/server';
import { AdminDecisionRequestSchema } from '@fbuploadpro/contracts';
import { authenticateAdminRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import {
  approvePayment,
  invalidateEntitlementCache,
  rejectPayment,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import { getBillingAdminClient, mapPaymentToItem } from '@/lib/billing/route-helpers';

/**
 * POST /api/admin/payments/[paymentId]
 * Admin only, fail closed. Approving starts a paid period of
 * exactly 30 days from approval and is idempotent — approving
 * twice returns the same period and does not extend it again.
 * Only bank payments can be approved here.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ paymentId: string }> }
): Promise<NextResponse> {
  const { paymentId } = await context.params;
  const auth = await authenticateAdminRoute(request);
  if (auth.errorResponse) return auth.errorResponse;
  if (auth.session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 503 }
    );
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The decision could not be read.' },
      { status: 400 }
    );
  }
  const parsed = AdminDecisionRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Choose approve or reject.' },
      { status: 400 }
    );
  }

  try {
    if (parsed.data.decision === 'reject') {
      // Required reason (owner decision 2026-11-02): an admin cannot
      // reject without choosing one; "Other" needs free text.
      const reason = parsed.data.rejectionReason?.trim();
      const detail = parsed.data.rejectionDetail?.trim() ?? null;
      if (!reason || (reason === 'Other' && !detail)) {
        return NextResponse.json(
          {
            error: 'INVALID_REQUEST',
            message: reason === 'Other'
              ? 'For "Other", write what was wrong with this payment.'
              : 'Choose a reason for rejecting this payment.',
          },
          { status: 400 }
        );
      }
      const payment = await rejectPayment(client, paymentId, new Date(), {
        reason,
        detail,
        adminUserId: auth.session.userId,
      });
      return NextResponse.json({ payment: mapPaymentToItem(payment), period: null });
    }

    // Bank-only approval gate: load the payment first so a
    // non-bank payment can never be approved into a paid period.
    // A missing row is a 404, not the 400 below.
    const { data, error: loadError } = await client
      .from('subscription_payments')
      .select('method,screenshot_storage_key')
      .eq('id', paymentId)
      .maybeSingle();
    if (loadError) {
      logServerError('[billing] admin decision load failed', loadError, { source: 'billing' });
      return NextResponse.json(
        { error: 'That payment could not be loaded right now. Please try again.' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json(
        { error: 'PAYMENT_NOT_FOUND', message: 'That payment could not be found.' },
        { status: 404 }
      );
    }
    const method =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)['method']
        : null;
    if (method !== 'bank') {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message: 'Only bank payments can be approved here.',
        },
        { status: 400 }
      );
    }
    const screenshotKey =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)['screenshot_storage_key']
        : null;
    const overrideReason = parsed.data.overrideReason?.trim() ?? null;
    if (typeof screenshotKey !== 'string' || screenshotKey.length === 0) {
      // Admin override (owner decision 2026-11-02): approve without
      // a screenshot only with a recorded reason.
      if (!overrideReason) {
        return NextResponse.json(
          {
            error: 'INVALID_REQUEST',
            message: 'This payment has no screenshot. Approve it only with a recorded reason, or reject it.',
          },
          { status: 400 }
        );
      }
    }

    const { payment, period } = await approvePayment(client, paymentId, auth.session.userId, new Date(), {
      overrideReason,
    });
    // Plan-check S1 (W2): approvePayment is called from exactly one
    // production site (this route), so the route is the right layer
    // for the invalidation createPeriodForPurchase (W1) does not
    // cover: the schedule-only approval (no period created yet),
    // the idempotent re-approve (no new period), and the lost-link
    // race orphan supersede inside approvePayment. Best-effort per
    // instance; the 30 s TTL is the guarantee.
    invalidateEntitlementCache(client, payment.userId);
    // A scheduled downgrade has no period yet (option A): the
    // schedule lives on the payment and the period is created
    // when it goes live. Returning a period here would be a lie.
    if (!period) {
      return NextResponse.json({
        payment: mapPaymentToItem(payment),
        scheduled: true,
        scheduledStartsAt: payment.scheduledStartsAt
          ? payment.scheduledStartsAt.toISOString()
          : null,
      });
    }
    return NextResponse.json({
      payment: mapPaymentToItem(payment),
      period: {
        id: period.id,
        startsAt: period.startsAt.toISOString(),
        endsAt: period.endsAt.toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof SubscriptionGateError) {
      const status =
        err.code === 'PAYMENT_NOT_FOUND'
          ? 404
          : err.code === 'PAYMENT_ALREADY_DECIDED'
            ? 409
            : 500;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    logServerError('[billing] admin decision failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'That decision could not be saved. Please try again.' },
      { status: 500 }
    );
  }
}
