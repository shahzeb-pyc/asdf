import { type NextRequest, NextResponse } from 'next/server';
import { MediaStorageResponseSchema } from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import {
  getStorageQuotaState,
  toMediaStorageDisplay,
} from '@/lib/billing/storage-quota';

/** GET /api/tenant/[subdomain]/billing/storage — the Media Library storage meter. */
export async function GET(
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

  try {
    const quotaState = await getStorageQuotaState(client, session.userId);
    const display = toMediaStorageDisplay(quotaState);
    // Validated at the boundary, same as the entitlement route: the
    // meter must never render numbers the server did not shape.
    const payload = MediaStorageResponseSchema.parse({
      ...display,
      hasActivePeriod: quotaState.quotaBytes > 0,
    });
    return NextResponse.json(payload);
  } catch (err) {
    logServerError('[billing] storage state failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Your storage could not be checked right now. Please try again.' },
      { status: 500 }
    );
  }
}
