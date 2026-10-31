import { type NextRequest, NextResponse } from 'next/server';
import { UsageRegisterRequestSchema } from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import {
  getActivePeriod,
  getUsageCounts,
  isLegacyUncappedUsageFeature,
  registerUsage,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';

/**
 * POST /api/tenant/[subdomain]/billing/usage
 * Generic usage registry for features: a feature calls this when
 * it starts using a destination, and the cap is enforced here,
 * server-side, across all features. The same destination in a
 * second feature counts once. Future features (auto
 * download-upload, auto repost) call this same route — they do
 * not need their own cap logic.
 */
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

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The usage request could not be read.' },
      { status: 400 }
    );
  }
  const parsed = UsageRegisterRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'That usage request is not valid.' },
      { status: 400 }
    );
  }
  // Publish Now is uncapped and writes NO usage rows (audit fix
  // 2026-11-01): a publish-now registration here is a caller bug,
  // refused loudly instead of stored and then ignored by the cap.
  if (isLegacyUncappedUsageFeature(parsed.data.feature)) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Publish Now does not register usage.' },
      { status: 400 }
    );
  }

  try {
    const result = await registerUsage(
      client,
      session.userId,
      parsed.data.platform,
      parsed.data.destinationKey,
      parsed.data.feature,
      parsed.data.destinationId ?? null
    );
    const period = await getActivePeriod(client, session.userId, new Date());
    const usage = await getUsageCounts(client, session.userId);
    return NextResponse.json({
      platform: parsed.data.platform,
      destinationKey: parsed.data.destinationKey,
      alreadyUsed: result.alreadyUsed,
      usedCount: result.usedCount,
      allowedCount: period ? period.counts[parsed.data.platform] : 0,
      usage,
    });
  } catch (err) {
    if (err instanceof SubscriptionGateError) {
      const status =
        err.code === 'SUBSCRIPTION_CAP_REACHED' || err.code === 'SUBSCRIPTION_REQUIRED'
          ? 403
          : 500;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    logServerError('[billing] usage register failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Your plan could not be checked right now. Please try again.' },
      { status: 500 }
    );
  }
}
