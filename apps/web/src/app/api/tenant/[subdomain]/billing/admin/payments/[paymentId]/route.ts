import { type NextRequest, NextResponse } from 'next/server';
import { AdminDecisionRequestSchema } from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import {
  approvePayment,
  rejectPayment,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import {
  getBillingAdminClient,
  mapPaymentToItem,
} from '@/lib/billing/route-helpers';

/**
 * POST /api/tenant/[subdomain]/billing/admin/payments/[paymentId]
 * Admin only, fail closed. Approving starts a paid period of
 * exactly 30 days from approval and is idempotent — approving
 * twice returns the same period and does not extend it again.
 * Only bank payments can be approved here: crypto payments
 * activate automatically when NOWPayments reports them finished,
 * so an admin approval must never start a period for unpaid crypto.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; paymentId: string }> }
): Promise<NextResponse> {
  const { subdomain, paymentId } = await context.params;
  const auth = await authenticateTenantRoute(request, subdomain);
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
      const payment = await rejectPayment(client, paymentId);
      return NextResponse.json({ payment: mapPaymentToItem(payment), period: null });
    }

    // Bank-only approval gate: load the payment first so a crypto
    // payment can never be approved into a paid period.
    const { data } = await client
      .from('subscription_payments')
      .select('method')
      .eq('id', paymentId)
      .maybeSingle();
    const method =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)['method']
        : null;
    if (method !== 'bank') {
      return NextResponse.json(
        {
          error: 'INVALID_REQUEST',
          message: 'Crypto payments activate automatically when they are paid. They do not need approval.',
        },
        { status: 400 }
      );
    }

    const { payment, period } = await approvePayment(client, paymentId, auth.session.userId);
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
