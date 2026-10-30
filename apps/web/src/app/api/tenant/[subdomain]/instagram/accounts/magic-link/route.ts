import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  getSessionSecret,
  signMagicLinkToken,
  verifySessionToken,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { bodyTooLargeResponse, enforceIpRateLimit, readJsonBody } from '@/lib/request-body';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { resolvePlatformClientCredentials } from '@/lib/connect/persist';

/**
 * Instagram magic-link generation — Facebook's
 * `/api/tenant/[subdomain]/accounts/magic-link` route, mirrored for
 * Instagram. Same contract: session auth, tenant isolation, a BYOC
 * pre-check (the workspace's Instagram App ID/Secret must be saved),
 * then a 15-minute cryptographically signed token. The token stays
 * REUSABLE within its window (owner decision BL3 for Facebook; same
 * rule here) — expiry is the only limit, there is no nonce store and
 * no single-use.
 *
 * Body fields are optional hints about the account the user expects
 * to connect; a field of the wrong type or blank is dropped, exactly
 * matching the Facebook route's ignore-it behaviour.
 */
const InstagramMagicLinkRequestBodySchema = z.object({
  expectedInstagramAccountId: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .catch(undefined),
  expectedDisplayName: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .catch(undefined),
});

async function extractExpectedAccountFromBody(request: NextRequest): Promise<{
  expectedInstagramAccountId?: string | undefined;
  expectedDisplayName?: string | undefined;
  bodyTooLarge?: boolean;
}> {
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return { bodyTooLarge: true };
    return {};
  }
  const parsed = InstagramMagicLinkRequestBodySchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return {};
  }
  return {
    expectedInstagramAccountId: parsed.data.expectedInstagramAccountId,
    expectedDisplayName: parsed.data.expectedDisplayName,
  };
}

export async function handleGenerateInstagramMagicLink(
  request: NextRequest,
  subdomain: string,
  dbClient?: DatabaseClient | SupabaseClient
): Promise<NextResponse> {
  const sessionSecret = getSessionSecret();
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  // 1. Session auth guard
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let session;
  try {
    session = await verifySessionToken(sessionCookie, sessionSecret);
  } catch (_e) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Tenant isolation check
  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Pre-check that Instagram BYOC is configured for this workspace
  const client = dbClient || getSupabaseAdminClient();
  const workspaceId = await resolveTenantWorkspaceId(
    client,
    subdomain,
    session.userId,
    session.role
  );
  const credentials =
    workspaceId == null
      ? null
      : await resolvePlatformClientCredentials(client, workspaceId, 'instagram');
  if (!credentials) {
    return NextResponse.json(
      {
        error: 'BYOC_NOT_CONFIGURED',
        message:
          'Instagram BYOC is not configured for this workspace. Configure your App ID and Secret in Settings.',
      },
      { status: 422 }
    );
  }

  // 4. Generate 15-minute cryptographically signed magic token
  const { expectedInstagramAccountId, expectedDisplayName, bodyTooLarge } =
    await extractExpectedAccountFromBody(request);
  if (bodyTooLarge) return bodyTooLargeResponse();

  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const expiresInSeconds = 900; // 15 minutes
  const exp = now + expiresInSeconds;

  const token = await signMagicLinkToken(
    {
      tenantSubdomain: subdomain,
      userId: session.userId,
      nonce,
      iat: now,
      exp,
      ...(expectedInstagramAccountId ? { expectedInstagramAccountId } : {}),
      ...(expectedDisplayName ? { expectedDisplayName } : {}),
    },
    sessionSecret
  );

  const magicUrl = `${appUrl}/connect/instagram?token=${token}`;

  return NextResponse.json({
    success: true,
    magicUrl,
    expiresAt: new Date(exp * 1000).toISOString(),
    expiresInSeconds,
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const limited = await enforceIpRateLimit(request, 'instagram_magic_link', 10);
  if (limited) return limited;
  return handleGenerateInstagramMagicLink(request, subdomain);
}
