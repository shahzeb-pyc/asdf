import { type NextRequest, NextResponse } from 'next/server';
import { AdminCouponActionSchema } from '@fbuploadpro/contracts';
import { authenticateAdminRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { couponFromRow, couponToItem } from '@/lib/billing/coupons';

/**
 * PATCH /api/admin/coupons/[couponId]
 * Admin only. One action per call: pause, resume, or delete.
 * Transitions are conditional on the current status, so a stale
 * admin tab cannot silently re-pause a coupon that was already
 * deleted:
 *   pause  — active → paused (held redemptions unaffected)
 *   resume — paused → active
 *   delete — active/paused → deleted (SOFT: the row and all its
 *            history stay; only new uses stop). Deleted is
 *            terminal — there is no un-delete.
 * A transition from the wrong state is a 409 with a plain
 * message, not a silent no-op.
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ couponId: string }> }
): Promise<NextResponse> {
  const { couponId } = await context.params;
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
      { error: 'INVALID_REQUEST', message: 'The coupon action could not be read.' },
      { status: 400 }
    );
  }
  const parsed = AdminCouponActionSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Choose pause, resume, or delete.' },
      { status: 400 }
    );
  }
  const { action } = parsed.data;

  const targetStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'deleted';
  const fromStatuses =
    action === 'pause' ? ['active'] : action === 'resume' ? ['paused'] : ['active', 'paused'];
  const wrongStateMessage =
    action === 'pause'
      ? 'Only an active coupon can be paused.'
      : action === 'resume'
        ? 'Only a paused coupon can be resumed.'
        : 'This coupon is already deleted.';

  try {
    const { data: current, error: lookupError } = await client
      .from('coupons')
      .select(
        'id,code,kind,percent,initial_balance_pkr,remaining_balance_pkr,consumed_at,status,created_by,created_at,updated_at'
      )
      .eq('id', couponId)
      .maybeSingle();
    if (lookupError) throw lookupError;
    const currentCoupon = current ? couponFromRow(current as Record<string, unknown>) : null;
    if (!currentCoupon) {
      return NextResponse.json({ error: 'NOT_FOUND', message: 'That coupon was not found.' }, { status: 404 });
    }
    if (!fromStatuses.includes(currentCoupon.status)) {
      return NextResponse.json({ error: 'INVALID_STATE', message: wrongStateMessage }, { status: 409 });
    }
    const { data, error } = await client
      .from('coupons')
      .update({ status: targetStatus, updated_at: new Date().toISOString() })
      .eq('id', couponId)
      .in('status', fromStatuses)
      .select(
        'id,code,kind,percent,initial_balance_pkr,remaining_balance_pkr,consumed_at,status,created_by,created_at,updated_at'
      )
      .maybeSingle();
    if (error) throw error;
    // Zero rows here means the status moved between the lookup
    // and the update (two admin tabs); the transition is refused
    // rather than silently applied to a new state.
    if (!data) {
      return NextResponse.json({ error: 'INVALID_STATE', message: wrongStateMessage }, { status: 409 });
    }
    const updated = couponFromRow(data as Record<string, unknown>);
    if (!updated) throw new Error('Coupon update returned an unreadable row');
    const { count } = await client
      .from('coupon_redemptions')
      .select('id', { count: 'exact', head: true })
      .eq('coupon_id', couponId);
    return NextResponse.json(couponToItem(updated, count ?? 0));
  } catch (err) {
    logServerError('[billing] admin coupon action failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'The coupon could not be updated. Please try again.' },
      { status: 500 }
    );
  }
}
