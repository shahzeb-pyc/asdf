import { type NextRequest, NextResponse } from 'next/server';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { getEntitlement, SubscriptionGateError } from '@/lib/billing/entitlement';
import {
  getBillingAdminClient,
  mapEntitlementToResponse,
} from '@/lib/billing/route-helpers';

/** GET /api/tenant/[subdomain]/billing/entitlement — the user's current plan, cap, and usage. */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const { session } = auth;

  // A throwing admin-client factory is a misconfigured deployment
  // (missing key, placeholder key, or a non-service key that would
  // silently read zero rows under RLS and report every user as Free).
  // That must surface as a loud 503 the client fail-opens on — never
  // as a 200 Free body and never as an unhandled 500 without a
  // stable shape.
  let client;
  try {
    client = getBillingAdminClient();
  } catch (err) {
    logServerError('[billing] admin client unavailable', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 503 }
    );
  }
  if (!client) {
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 503 }
    );
  }

  try {
    const entitlement = await getEntitlement(client, session.userId);
    return NextResponse.json(mapEntitlementToResponse(entitlement));
  } catch (err) {
    if (err instanceof SubscriptionGateError) {
      return NextResponse.json({ error: err.code, message: err.message }, { status: 500 });
    }
    logServerError('[billing] entitlement failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Your plan could not be checked right now. Please try again.' },
      { status: 500 }
    );
  }
}
