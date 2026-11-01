import { type NextRequest, NextResponse } from 'next/server';
import { SellerPatchSchema } from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import {
  deleteSeller,
  getSellerBalances,
  getSellerPurchaserCount,
  getSellerSettings,
  getSellerSignupCount,
  listReferredUsers,
  listReferralCodes,
  listSellerCommissions,
  listSellerPayoutRequests,
  SellerError,
  updateSeller,
} from '@/lib/billing/sellers';
import { sellerErrorResponse } from '@/lib/route-seller';
import { logServerError } from '@/lib/server-analytics';

/**
 * GET /api/tenant/[subdomain]/sellers/[sellerId] — admin detail:
 * profile, codes, balances, commissions, payout history, referrals.
 * PATCH — edit rate/scope/status (future purchases only).
 * DELETE — blocked while any commission is unpaid.
 * Admin only, fail closed.
 */
async function adminAuth(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; sellerId: string }> }
): Promise<
  | { sellerId: string; errorResponse?: never }
  | { sellerId?: never; errorResponse: NextResponse }
> {
  const { subdomain, sellerId } = await context.params;
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return { errorResponse: auth.errorResponse };
  if (auth.session.role !== 'admin') {
    return { errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { sellerId };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; sellerId: string }> }
): Promise<NextResponse> {
  const gate = await adminAuth(request, context);
  if (gate.errorResponse) return gate.errorResponse;
  const sellerId = gate.sellerId;

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 503 });
  }

  try {
    const userRow = await client
      .from('users')
      .select('name,email,role,created_at')
      .eq('id', sellerId)
      .maybeSingle();
    const userData =
      userRow.data !== null && typeof userRow.data === 'object'
        ? (userRow.data as Record<string, unknown>)
        : null;
    if (!userData || userData['role'] !== 'seller') {
      return NextResponse.json({ error: 'Seller not found.' }, { status: 404 });
    }
    const settings = await getSellerSettings(client, sellerId);
    if (!settings) {
      return NextResponse.json({ error: 'Seller not found.' }, { status: 404 });
    }
    const [codes, balances, commissions, payoutPage, referredPage, signups, purchasers] =
      await Promise.all([
        listReferralCodes(client, sellerId),
        getSellerBalances(client, sellerId),
        listSellerCommissions(client, sellerId, 100),
        listSellerPayoutRequests(client, sellerId, 20, 0),
        listReferredUsers(client, sellerId, 50, 0),
        getSellerSignupCount(client, sellerId),
        getSellerPurchaserCount(client, sellerId),
      ]);
    const current = codes.find((c) => c.current);
    const createdAt =
      typeof userData['created_at'] === 'string' ? userData['created_at'] : new Date(0).toISOString();
    return NextResponse.json({
      seller: {
        id: sellerId,
        name: typeof userData['name'] === 'string' ? userData['name'] : null,
        email: typeof userData['email'] === 'string' ? userData['email'] : '',
        currentCode: current?.code ?? null,
        rate: settings.rate,
        scope: settings.scope,
        status: settings.status,
        signups,
        purchasers,
        payablePkr: balances.payable,
        paidPkr: balances.paid,
        createdAt,
      },
      codes: codes.map((c) => ({
        code: c.code,
        current: c.current,
        tombstoned: c.tombstoned,
        createdAt: c.createdAt,
      })),
      balances,
      commissions: commissions.map((c) => ({
        id: c.id,
        buyerName: c.buyerName,
        buyerEmail: c.buyerEmail,
        paymentId: c.paymentId,
        periodStartsAt: c.periodStartsAt,
        rate: c.rateSnapshot,
        scope: c.scopeSnapshot,
        amountPkr: c.amountPkr,
        status: c.status,
        createdAt: c.createdAt,
      })),
      payoutRequests: payoutPage.requests.map((r) => ({
        id: r.id,
        sellerId: r.sellerId,
        sellerName: r.sellerNameSnapshot,
        sellerEmail: r.sellerEmailSnapshot,
        totalPkr: r.totalPkr,
        commissionCount: r.commissionCount,
        status: r.status,
        payoutMethod: r.payoutMethodSnapshot,
        payoutAccount: r.payoutAccountSnapshot,
        requestedAt: r.requestedAt,
        decidedAt: r.decidedAt,
      })),
      referredUsers: referredPage.users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        referralCode: u.referralCode,
        purchased: u.purchased,
        signedUpAt: u.signedUpAt,
      })),
      referredTotal: referredPage.total,
    });
  } catch (err) {
    if (err instanceof SellerError) return sellerErrorResponse(err);
    logServerError('[sellers] admin detail failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'Seller details could not be loaded right now.' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; sellerId: string }> }
): Promise<NextResponse> {
  const gate = await adminAuth(request, context);
  if (gate.errorResponse) return gate.errorResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }
  const parsed = SellerPatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid seller update.' }, { status: 400 });
  }

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 503 });
  }

  try {
    // Strip undefined keys: updateSeller's patch type is exact
    // optional, so explicit undefineds are not assignable.
    const patch: { rate?: number; scope?: 'one-time' | 'every'; status?: 'active' | 'paused' } = {};
    if (parsed.data.rate !== undefined) patch.rate = parsed.data.rate;
    if (parsed.data.scope !== undefined) patch.scope = parsed.data.scope;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    await updateSeller(client, gate.sellerId, patch);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SellerError) return sellerErrorResponse(err);
    logServerError('[sellers] admin update failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'The seller could not be updated right now.' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; sellerId: string }> }
): Promise<NextResponse> {
  const gate = await adminAuth(request, context);
  if (gate.errorResponse) return gate.errorResponse;

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 503 });
  }

  try {
    await deleteSeller(client, gate.sellerId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof SellerError) return sellerErrorResponse(err);
    logServerError('[sellers] admin delete failed', err, { source: 'sellers' });
    return NextResponse.json({ error: 'The seller could not be deleted right now.' }, { status: 500 });
  }
}
