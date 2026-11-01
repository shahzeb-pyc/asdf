import { type NextRequest, NextResponse } from 'next/server';
import {
  BillingBankPaymentSubmitSchema,
  totalPricePkr,
} from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { readJsonBody } from '@/lib/request-body';
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
 * Manual bank payment, JSON body: counts, bankMethod, the storage
 * key of an already-uploaded screenshot, and an optional coupon
 * code (submit rewrite 2026-11-01).
 *
 * The screenshot no longer rides this request. The browser uploads
 * it straight to R2 first (see the screenshot-upload route), so a
 * multi-MB image is never bundled with the coupon hold, the DB
 * insert, and the idempotency store into one long request — that
 * bundling is what made submissions fail "randomly" with the
 * generic error whenever any downstream step blipped. The payment
 * row records the key; only the key is stored, never a public URL.
 * The payment stays pending until an admin approves it.
 *
 * The amount is always computed server-side from the current
 * period: a fresh purchase pays the full total; an active period
 * can only be upgraded, with credit for the days left.
 *
 * Errors are specific, never the old generic catch-all: a failed
 * save says the screenshot is still attached and to try again (a
 * retry reuses the uploaded key with the same idempotency key, so
 * it can never double-create), and a failure after the row was
 * created is never reported as a failure at all — the idempotency
 * store is best-effort once the payment exists, and a retry then
 * hits the truthful one-pending 409 instead of a lie.
 */
const SCREENSHOT_KEY_PATTERN =
  /^billing-screenshots\/([0-9a-fA-F-]{36})\/[0-9a-fA-F-]{36}\.(png|jpg|webp|gif)$/;

/** The retry is safe: the screenshot is already stored, nothing is charged twice. */
const SAVE_FAILED_MESSAGE =
  "We couldn't save your payment. Your screenshot is still attached — try again.";

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
  // pending payment. Checkout now always sends a stable key per
  // submission, so automatic and manual retries replay instead of
  // re-inserting. The workspace is only the idempotency scope. If
  // it cannot be resolved, the lookup still runs (an invalid key is
  // rejected either way) but replay and storage are skipped with a
  // loud log rather than failing the submission — the one-pending
  // guard still protects against duplicates, and the payment row
  // itself carries no workspace (its workspace_id column is dead).
  let workspaceId: string | null = null;
  try {
    workspaceId = await resolveTenantWorkspaceId(client, subdomain, session.userId, session.role);
  } catch (error) {
    logServerError('[billing] idempotency workspace unresolvable, skipping', error, {
      source: 'billing',
    });
  }
  let idempotencyKey: string | null = null;
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

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The payment could not be read. Please try again.' },
      { status: 400 }
    );
  }
  const body = BillingBankPaymentSubmitSchema.safeParse(bodyResult.value);
  if (!body.success || totalPricePkr(body.data.counts) <= 0) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'Choose at least one page or account and a payment method.',
      },
      { status: 400 }
    );
  }
  const { counts, bankMethod } = body.data;
  const couponCode = body.data.couponCode ?? null;

  // The screenshot must already exist under this caller's own
  // namespace. A missing key means no upload happened; a key
  // outside the namespace is a forgery attempt, not a client bug —
  // both are refused before any row is created.
  const screenshotStorageKey = body.data.screenshotStorageKey;
  const keyMatch = SCREENSHOT_KEY_PATTERN.exec(screenshotStorageKey);
  if (!keyMatch) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'Attach a screenshot of your payment so it can be approved.',
      },
      { status: 400 }
    );
  }
  if (keyMatch[1].toLowerCase() !== session.userId.toLowerCase()) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'That screenshot does not belong to this payment. Re-upload your screenshot and try again.',
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
    // One pending payment per user: checked before any row is
    // created. The screenshot is already stored by now; a refusal
    // orphans only unguessable bytes, never a payment.
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
          { error: 'COUPON_NOT_FOUND', message: 'Invalid coupon code, try another.' },
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

    const { data, error } = await client
      .from('subscription_payments')
      .insert({
        user_id: session.userId,
        method: 'bank',
        bank_method: bankMethod,
        status: 'pending',
        facebook_count: counts.facebook,
        instagram_count: counts.instagram,
        threads_count: counts.threads,
        x_count: counts.x,
        tiktok_count: counts.tiktok,
        youtube_count: counts.youtube,
        amount_pkr: amountPkr,
        is_upgrade: isUpgrade,
        screenshot_storage_key: screenshotStorageKey,
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
      // second row exists. The held coupon is released FIRST (audit
      // fix 2026-11-01): this is a plain return, not a throw, so
      // the catch below would never release it — returning without
      // releasing used to strand the hold (burning a one-time
      // coupon or debiting a balance with no payment to show for it).
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
      // Diagnostic only: the Supabase error was previously discarded
      // here, so the server log could not say WHY the insert was
      // rejected (e.g. 42501 RLS denial vs 42P01 missing table vs
      // 42703 missing column). Log the PostgREST fields server-side,
      // then return a specific, retryable message — the screenshot
      // is already stored, so a retry with the same key is safe.
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
      if (heldRedemption) {
        try {
          await releaseRedemption(client, heldRedemption);
        } catch (releaseError) {
          logServerError('[billing] coupon release after insert failure failed', releaseError, {
            source: 'billing',
          });
        }
      }
      return NextResponse.json(
        { error: 'PAYMENT_SAVE_FAILED', message: SAVE_FAILED_MESSAGE },
        { status: 500 }
      );
    }
    const payment = paymentFromRow(data as Record<string, unknown>);
    if (!payment) {
      // The row exists but is unreadable: a retry hits the
      // one-pending 409, which is truthful — so say the save failed
      // and to try again, rather than claiming success we cannot
      // show. The hold is released by the catch below.
      throw new Error('Payment insert returned an unreadable row');
    }
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
        return NextResponse.json(
          { error: 'PAYMENT_SAVE_FAILED', message: SAVE_FAILED_MESSAGE },
          { status: 500 }
        );
      }
      redemptionLinked = true;
    }
    const item = mapPaymentToItem(payment);
    try {
      await storeBillingIdempotency(client, workspaceId, session.userId, 'billing-bank', idempotencyKey, {
        status: 201,
        body: item,
      });
    } catch (storeError) {
      // The payment genuinely exists now: failing the request here
      // would be the old lie (user told it failed, retry told a
      // payment is already pending). Log loudly, return the 201 —
      // replay for this key is unavailable, but the one-pending
      // guard still makes any retry truthful and duplicate-free.
      logServerError('[billing] idempotency store after insert failed, returning 201', storeError, {
        source: 'billing',
      });
    }
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
    // Generic fallback, allowed only for a truly unknown error —
    // and it still says the screenshot is attached and to try
    // again, because the upload already happened before this call.
    return NextResponse.json(
      {
        error: 'UNKNOWN',
        message: 'Something went wrong while saving your payment. Your screenshot is still attached — try again.',
      },
      { status: 500 }
    );
  }
}
