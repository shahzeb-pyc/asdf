import { type NextRequest, NextResponse } from 'next/server';
import {
  BankMethodSchema,
  PlatformCountsSchema,
  totalPricePkr,
} from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { getStorageService } from '@/lib/storage';
import {
  getActivePeriod,
  paymentFromRow,
  pricePurchase,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import {
  getBillingAdminClient,
  mapPaymentToItem,
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

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 503 }
    );
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

  try {
    const counts = countsResult.data;
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

    const storageKey = `billing-screenshots/${session.userId}/${crypto.randomUUID()}.${extension}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      await getStorageService().putObject({
        key: storageKey,
        body: bytes,
        contentType: file.type,
      });
    } catch (err) {
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
      })
      .select(
        'id,user_id,method,bank_method,status,facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count,amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,period_id,approved_at,created_at'
      )
      .single();
    if (error || !data) {
      throw new Error('Payment insert failed');
    }
    const payment = paymentFromRow(data as Record<string, unknown>);
    if (!payment) throw new Error('Payment insert returned an unreadable row');
    return NextResponse.json(mapPaymentToItem(payment), { status: 201 });
  } catch (err) {
    logServerError('[billing] bank payment failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Your payment could not be submitted. Please try again.' },
      { status: 500 }
    );
  }
}
