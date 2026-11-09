import { type NextRequest, NextResponse } from 'next/server';
import { UsageRegisterRequestSchema } from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import {
  getCachedEntitlement,
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
    // R3 + C1: the entitlement is read once here — the
    // request-cached read — and shared with the register below,
    // so the register no longer pays for its own full read.
    // R4: the response is built from the entitlement the
    // register returns instead of re-reading getActivePeriod +
    // getUsageCounts after the insert. The returned entitlement
    // is the PRE-insert read, so the registered platform's count
    // is adjusted by +1 when — and only when — a row was actually
    // inserted: `usedCount` already is that post-insert count
    // (derived +1 on the clean-insert path, re-read on the
    // already-used path), so it is the adjustment. A bare +1
    // here would overstate by one when the inserted row links to
    // a disconnected destination, whose row does not count.
    const entitlement = await getCachedEntitlement(client, session.userId);
    const result = await registerUsage(
      client,
      session.userId,
      parsed.data.platform,
      parsed.data.destinationKey,
      parsed.data.feature,
      parsed.data.destinationId ?? null,
      undefined,
      entitlement
    );
    const usage = {
      ...result.entitlement.usage,
      [parsed.data.platform]: result.usedCount,
    };
    return NextResponse.json({
      platform: parsed.data.platform,
      destinationKey: parsed.data.destinationKey,
      alreadyUsed: result.alreadyUsed,
      usedCount: result.usedCount,
      allowedCount: result.entitlement.counts[parsed.data.platform],
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
