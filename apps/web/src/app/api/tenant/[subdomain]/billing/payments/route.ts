import { type NextRequest, NextResponse } from 'next/server';
import {
  BankMethodSchema,
  PlatformCountsSchema,
  totalPricePkr,
} from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { getStorageService } from '@/lib/storage';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import {
  getActivePeriod,
  hasPendingPayment,
  paymentFromRow,
  PENDING_PAYMENT_EXISTS_MESSAGE,
  pricePurchase,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import {
  CouponError,
  computeDiscount,
  holdCoupon,
  loadCouponByCode,
  releaseRedemption,
  type CouponRedemptionRow,
} from '@/lib/billing/coupons';
import {
  getBillingAdminClient,
  lookupBillingIdempotency,
  mapPaymentToItem,
  storeBillingIdempotency,
} from '@/lib/billing/route-helpers';

/**
 * POST /api/tenant/[subdomain]/billing/payments
 * Manual bank payment, multipart form: counts (JSON), bankMethod,
 * and a payment screenshot image (max 10 MB).
 *
 * The amount is always computed server-side from the current
 * period: a fresh purchase pays the full total; an active period
 * can only be upgraded, with credit for the days left. The
 * screenshot goes to the app's R2 storage under an unguessable
 * key; only the key is stored on the payment row, never a public
 * URL. The payment stays pending until an admin approves it.
 */
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const SCREENSHOT_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const { session } = auth;

  // Admins never buy plans (audit fix 2026-11-01): an admin account
  // is for approvals, not for subscribing.
  if (session.role === 'admin') {
    return NextResponse.json(
      { error: 'FORBIDDEN', message: 'Admin accounts do not buy plans.' },
      { status: 403 }
    );
  }

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 503 }
    );
  }

  // Billing idempotency (audit fix 2026-11-01): a retry with a known
  // key replays the stored response instead of creating a second
  // pending payment.
  // The workspace is only the idempotency scope. If it cannot be
  // resolved, idempotency is skipped with a loud log rather than
  // failing the submission — the one-pending guard still protects
  // against duplicates, and the payment row itself carries no
  // workspace (its workspace_id column is dead).
  let workspaceId: string | null = null;
  try {
    workspaceId = await resolveTenantWorkspaceId(client, subdomain, session.userId, session.role);
  } catch (error) {
    logServerError('[billing] idempotency workspace unresolvable, skipping', error, {
      source: 'billing',
    });
  }
  let idempotencyKey: string | null = null;
  if (workspaceId) {
  try {
    const idempotency = await lookupBillingIdempotency(
      client,
      workspaceId,
      session.userId,
      'billing-bank',
      request.headers
    );
    if ('invalid' in idempotency) {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'Idempotency-Key must be a UUID' },
        { status: 400 }
      );
    }
    idempotencyKey = idempotency.key;
    if (idempotency.replay) {
      return NextResponse.json(idempotency.replay.body, {
        status: idempotency.replay.status,
        headers: { 'Idempotency-Replayed': 'true' },
      });
    }
  } catch {
    return NextResponse.json(
      { error: 'IDEMPOTENCY_STORE_UNAVAILABLE', message: 'Idempotency store unavailable' },
      { status: 500 }
    );
  }
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The payment could not be read. Please try again.' },
      { status: 400 }
    );
  }

  const countsRaw = form.get('counts');
  const bankMethodRaw = form.get('bankMethod');
  const file = form.get('screenshot');
  let countsParsed: unknown = null;
  if (typeof countsRaw === 'string') {
    try {
      countsParsed = JSON.parse(countsRaw) as unknown;
    } catch {
      countsParsed = null;
    }
  }
  const countsResult = PlatformCountsSchema.safeParse(countsParsed);
  const bankResult = BankMethodSchema.safeParse(bankMethodRaw);
  if (!countsResult.success || !bankResult.success || totalPricePkr(countsResult.data) <= 0) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'Choose at least one page or account and a payment method.',
      },
      { status: 400 }
    );
  }
  // One coupon per purchase, enforced here: a second couponCode
  // field is a 400, never a silent second discount.
  const couponCodes = form
    .getAll('couponCode')
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (couponCodes.length > 1) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'Only one coupon can be used per purchase.',
      },
      { status: 400 }
    );
  }
  const couponCode = couponCodes.length === 1 ? couponCodes[0] : null;
  if (file === null || typeof file === 'string' || file.size === 0) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'Attach a screenshot of your payment so it can be approved.',
      },
      { status: 400 }
    );
  }
  const extension = SCREENSHOT_EXTENSIONS[file.type];
  if (!extension || file.size > MAX_SCREENSHOT_BYTES) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'The screenshot must be a PNG, JPG, WebP, or GIF image under 10 MB.',
      },
      { status: 400 }
    );
  }

  // Coupon hold (if any): the claim lands before any money moves,
  // so a failed submission never strands a discount. The payment
  // row is inserted with the REDUCED amount; the redemption is
  // linked to it right after the insert. These live outside the
  // try block so the catch can release an unlinked hold.
  let heldRedemption: CouponRedemptionRow | null = null;
  let redemptionLinked = false;
  try {
    const counts = countsResult.data;
    // One pending payment per user: checked before any screenshot is
    // stored and before any row is created.
    if (await hasPendingPayment(client, session.userId)) {
      return NextResponse.json(
        { error: 'PENDING_PAYMENT_EXISTS', message: PENDING_PAYMENT_EXISTS_MESSAGE },
        { status: 409 }
      );
    }
    const activePeriod = await getActivePeriod(client, session.userId, new Date());
    let amountPkr: number;
    let isUpgrade: boolean;
    try {
      const priced = pricePurchase(counts, activePeriod);
      amountPkr = priced.amountPkr;
      isUpgrade = priced.isUpgrade;
    } catch (err) {
      if (err instanceof SubscriptionGateError) {
        return NextResponse.json({ error: 'INVALID_REQUEST', message: err.message }, { status: 400 });
      }
      throw err;
    }

    let discountPkr = 0;
    if (couponCode) {
      const coupon = await loadCouponByCode(client, couponCode);
      if (!coupon) {
        return NextResponse.json(
          { error: 'COUPON_NOT_FOUND', message: 'That coupon code was not found.' },
          { status: 404 }
        );
      }
      discountPkr = computeDiscount(coupon, amountPkr);
      // A coupon covering the full amount belongs to the zero-due
      // path, not here: a 0-PKR bank payment needing a screenshot
      // and an approval would be nonsense. Refused before any hold.
      if (discountPkr >= amountPkr) {
        return NextResponse.json(
          {
            error: 'INVALID_REQUEST',
            message: 'This coupon covers the full amount. Activate your plan with the coupon instead of paying by bank.',
          },
          { status: 400 }
        );
      }
      heldRedemption = await holdCoupon(client, {
        coupon,
        userId: session.userId,
        paymentId: null,
        discountPkr,
      });
      // Charge and record the SETTLED discount (audit fix
      // 2026-11-01): a balance race can settle smaller than the
      // pre-hold figure, and the payment must carry what the
      // coupon actually gave, not what was computed before the
      // claim. (Percent discounts settle exactly; the full-cover
      // check above already guarantees settled < amount here.)
      discountPkr = heldRedemption.amountPkr;
      amountPkr -= discountPkr;
    }

    const storageKey = `billing-screenshots/${session.userId}/${crypto.randomUUID()}.${extension}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      await getStorageService().putObject({
        key: storageKey,
        body: bytes,
        contentType: file.type,
      });
    } catch (err) {
      if (heldRedemption) {
        try {
          await releaseRedemption(client, heldRedemption);
        } catch (releaseError) {
          logServerError('[billing] coupon release after screenshot failure failed', releaseError, {
            source: 'billing',
          });
        }
      }
      logServerError('[billing] screenshot upload failed', err, { source: 'billing' });
      return NextResponse.json(
        { error: 'The screenshot could not be saved. Please try again.' },
        { status: 502 }
      );
    }

    const { data, error } = await client
      .from('subscription_payments')
      .insert({
        user_id: session.userId,
        method: 'bank',
        bank_method: bankResult.data,
        status: 'pending',
        facebook_count: counts.facebook,
        instagram_count: counts.instagram,
        threads_count: counts.threads,
        x_count: counts.x,
        tiktok_count: counts.tiktok,
        youtube_count: counts.youtube,
        amount_pkr: amountPkr,
        is_upgrade: isUpgrade,
        screenshot_storage_key: storageKey,
        coupon_code: couponCode ? couponCode.trim().toUpperCase() : null,
        discount_pkr: discountPkr,
      })
      .select(
        'id,user_id,method,bank_method,status,facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count,amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,coupon_code,discount_pkr,period_id,approved_at,created_at'
      )
      .single();
    if (error?.code === '23505') {
      // Race backstop: two submissions that both passed the pending
      // check can still collide on the one-pending-per-user index.
      // The loser gets the same plain 409 as the check above, and no
      // second row exists — the screenshot it uploaded is orphaned
      // bytes under an unguessable key, never attached to a payment.
      // The held coupon is released FIRST (audit fix 2026-11-01):
      // this is a plain return, not a throw, so the catch below
      // would never release it — returning without releasing used
      // to strand the hold (burning a one-time coupon or debiting
      // a balance with no payment to show for it).
      if (heldRedemption) {
        try {
          await releaseRedemption(client, heldRedemption);
        } catch (releaseError) {
          logServerError('[billing] coupon release after pending race failed', releaseError, {
            source: 'billing',
          });
        }
      }
      return NextResponse.json(
        { error: 'PENDING_PAYMENT_EXISTS', message: PENDING_PAYMENT_EXISTS_MESSAGE },
        { status: 409 }
      );
    }
    if (error || !data) {
      // Diagnostic only: the Supabase error was previously discarded here,
      // so the server log could not say WHY the insert was rejected
      // (e.g. 42501 RLS denial vs 42P01 missing table vs 42703 missing
      // column). Log the PostgREST fields server-side, then still throw
      // the generic error so the user-facing message is unchanged.
      // PostgREST code/message/details/hint for an insert describe the
      // schema/constraint failure, not row contents or secrets.
      if (error) {
        const detailParts = [
          `PostgREST code: ${error.code}`,
          `message: ${error.message}`,
          ...(error.details ? [`details: ${error.details}`] : []),
          ...(error.hint ? [`hint: ${error.hint}`] : []),
        ];
        logServerError('[billing] bank payment insert failed', new Error(detailParts.join(' | ')), {
          source: 'billing',
          postgrest_code: error.code,
          postgrest_message: error.message,
          ...(error.details ? { postgrest_details: error.details } : {}),
          ...(error.hint ? { postgrest_hint: error.hint } : {}),
        });
      }
      throw new Error('Payment insert failed');
    }
    const payment = paymentFromRow(data as Record<string, unknown>);
    if (!payment) throw new Error('Payment insert returned an unreadable row');
    if (heldRedemption) {
      // Link the held redemption to this payment. If the link
      // itself fails, the payment is removed again (it was created
      // milliseconds ago by this request and never seen) and the
      // coupon is released, so no discounted-but-couponless payment
      // can strand the user or the coupon.
      const { error: linkError } = await client
        .from('coupon_redemptions')
        .update({ payment_id: payment.id })
        .eq('id', heldRedemption.id)
        .eq('status', 'held');
      if (linkError) {
        await client.from('subscription_payments').delete().eq('id', payment.id);
        try {
          await releaseRedemption(client, heldRedemption);
        } catch (releaseError) {
          logServerError('[billing] coupon release after link failure failed', releaseError, {
            source: 'billing',
          });
        }
        throw new Error('Coupon redemption link failed');
      }
      redemptionLinked = true;
    }
    const item = mapPaymentToItem(payment);
    await storeBillingIdempotency(client, workspaceId, session.userId, 'billing-bank', idempotencyKey, {
      status: 201,
      body: item,
    });
    return NextResponse.json(item, { status: 201 });
  } catch (err) {
    if (err instanceof CouponError) {
      const status = err.code === 'COUPON_NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    // A hold that never got linked (insert failed, link failed,
    // unreadable row) must not strand the coupon: release it.
    // Releasing is idempotent — a hold already released by an
    // inner path simply no-ops here.
    if (heldRedemption && !redemptionLinked) {
      try {
        await releaseRedemption(client, heldRedemption);
      } catch (releaseError) {
        logServerError('[billing] coupon release after bank failure failed', releaseError, {
          source: 'billing',
        });
      }
    }
    logServerError('[billing] bank payment failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Your payment could not be submitted. Please try again.' },
      { status: 500 }
    );
  }
}
