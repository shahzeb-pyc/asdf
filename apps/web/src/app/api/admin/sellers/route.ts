import { type NextRequest, NextResponse } from 'next/server';
import { SellerCreateSchema } from '@fbuploadpro/contracts';
import { authenticateAdminRoute } from '@/lib/route-auth';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import {
  changeReferralCode,
  createSeller,
  deleteSeller,
  listSellers,
  SellerError,
} from '@/lib/billing/sellers';
import { sellerErrorResponse } from '@/lib/route-seller';
import { logServerError } from '@/lib/server-analytics';

/**
 * GET /api/admin/sellers — admin seller list, newest first.
 * POST — admin creates a seller (name, email, admin-set password,
 * rate + scope, optional initial referral code).
 * Admin only, fail closed: non-admins get 403 and no data.
 */
export async function GET(
  request: NextRequest
): Promise<NextResponse> {
  const auth = await authenticateAdminRoute(request);
  if (auth.errorResponse) return auth.errorResponse;
  if (auth.session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 503 });
  }

  const pageParam = Number(request.nextUrl.searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const PAGE_SIZE = 20;

  try {
    const { sellers, total } = await listSellers(client, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    return NextResponse.json({
      sellers: sellers.map((s) => ({
        id: s.id,
        name: s.name,
        email: s.email,
        currentCode: s.currentCode,
        rate: s.rate,
        scope: s.scope,
        status: s.status,
        signups: s.signups,
        purchasers: s.purchasers,
        payablePkr: s.payablePkr,
        paidPkr: s.paidPkr,
        createdAt: s.createdAt,
      })),
      total,
    });
  } catch (err) {
    if (err instanceof SellerError) return sellerErrorResponse(err);
    logServerError('[sellers] admin list failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'Sellers could not be loaded right now.' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest
): Promise<NextResponse> {
  const auth = await authenticateAdminRoute(request);
  if (auth.errorResponse) return auth.errorResponse;
  if (auth.session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const parsed = SellerCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid seller details.' }, { status: 400 });
  }

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 503 });
  }

  try {
    const { sellerId } = await createSeller(client, {
      name: parsed.data.name,
      email: parsed.data.email,
      password: parsed.data.password,
      rate: parsed.data.rate,
      scope: parsed.data.scope,
    });
    // The initial code is set after creation (createSeller owns
    // only the account). If the code is taken, the just-created
    // seller is rolled back so a failed create never leaves a
    // codeless seller behind — the admin retries with a new code.
    if (parsed.data.referralCode) {
      try {
        await changeReferralCode(client, sellerId, parsed.data.referralCode);
      } catch (codeErr) {
        try {
          await deleteSeller(client, sellerId);
        } catch (rollbackErr) {
          // Rollback is best-effort, but its failure is logged
          // loudly: the original error is what the admin sees,
          // and the seller row stays visible in the list for
          // manual cleanup if this ever fails.
          logServerError('[sellers] seller-create rollback failed', rollbackErr, {
            source: 'sellers',
          });
        }
        throw codeErr;
      }
    }
    return NextResponse.json({ sellerId }, { status: 201 });
  } catch (err) {
    if (err instanceof SellerError) return sellerErrorResponse(err);
    logServerError('[sellers] admin create failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'The seller could not be created right now.' }, { status: 500 });
  }
}
