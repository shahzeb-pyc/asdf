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
import { resolvePlatformClientCredentials } from '@/lib/connect/persist';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { z } from 'zod';
import { bodyTooLargeResponse, enforceIpRateLimit, readJsonBody } from '@/lib/request-body';

/**
 * POST …/threads/accounts/magic-link — the Threads magic-link
 * generator, following the Facebook pattern exactly
 * (`…/accounts/magic-link` on main): session guard, tenant
 * isolation, a BYOC pre-check (Threads app details, not Facebook's),
 * then a 15-minute cryptographically signed magic token. The token
 * carries the same fields Facebook's does, with the platform-
 * agnostic `expectedExternalAccountId` in place of Facebook's
 * `expectedFbAccountId`. The link points at the Threads magic
 * entry (`/connect/threads?token=…`), built from
 * `NEXT_PUBLIC_APP_URL` — never hardcoded.
 *
 * Reuse behaviour matches Facebook on main: the token is a signed
 * envelope with a 15-minute expiry and no server-side record, so it
 * is reusable within its window until it expires (same as
 * Facebook's magic links).
 */
const MagicLinkRequestBodySchema = z.object({
  expectedExternalAccountId: z
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
  expectedExternalAccountId?: string | undefined;
  expectedDisplayName?: string | undefined;
  bodyTooLarge?: boolean;
}> {
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return { bodyTooLarge: true };
    return {};
  }
  const parsed = MagicLinkRequestBodySchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return {};
  }
  return {
    expectedExternalAccountId: parsed.data.expectedExternalAccountId,
    expectedDisplayName: parsed.data.expectedDisplayName,
  };
}

export async function handleGenerateThreadsMagicLink(
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

  // 3. Pre-check that Threads BYOC is configured for this workspace
  const client = dbClient || getSupabaseAdminClient();
  const workspaceId = await resolveTenantWorkspaceId(
    client,
    subdomain,
    session.userId,
    session.role
  );
  if (!workspaceId) {
    return NextResponse.json(
      { error: 'Workspace not found' },
      { status: 404 }
    );
  }
  const credentials = await resolvePlatformClientCredentials(
    client,
    workspaceId,
    'threads'
  );
  if (!credentials) {
    return NextResponse.json(
      {
        error: 'BYOC_NOT_CONFIGURED',
        message: 'Threads BYOC is not configured for this workspace. Configure your App ID and Secret in Settings.',
      },
      { status: 422 }
    );
  }

  // 4. Generate 15-minute cryptographically signed magic token
  const { expectedExternalAccountId, expectedDisplayName, bodyTooLarge } =
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
      ...(expectedExternalAccountId ? { expectedExternalAccountId } : {}),
      ...(expectedDisplayName ? { expectedDisplayName } : {}),
    },
    sessionSecret
  );

  const magicUrl = `${appUrl}/connect/threads?token=${token}`;

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
  const limited = await enforceIpRateLimit(request, 'tenant_magic_link', 10);
  if (limited) return limited;
  return handleGenerateThreadsMagicLink(request, subdomain);
}
