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
import { resolveWorkspaceFacebookCredentials } from '@/lib/server/byoc-resolver';
import { z } from 'zod';
import { bodyTooLargeResponse, enforceIpRateLimit, readJsonBody } from '@/lib/request-body';

/**
 * Body schema for the magic-link request (spec 139 Wave B, audit C2:
 * this body was previously read with no validation at all). Both fields
 * are optional hints about the account the user expects to connect;
 * a field of the wrong type or blank is dropped (`.catch(undefined)`),
 * exactly matching the previous ignore-it behaviour.
 */
const MagicLinkRequestBodySchema = z.object({
  expectedFbAccountId: z
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
  expectedFbAccountId?: string | undefined;
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
    expectedFbAccountId: parsed.data.expectedFbAccountId,
    expectedDisplayName: parsed.data.expectedDisplayName,
  };
}

export async function handleGenerateMagicLink(
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

  // Audit S1: live session validation — a suspended user or a
  // session issued before a password change must not reach the
  // tenant check or any mutation below.
  const { validateSessionActive } = await import('@/lib/auth/session');
  if (!(await validateSessionActive(session))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Tenant isolation check
  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // 3. Pre-check that Facebook BYOC is configured for this workspace
  const client = dbClient || getSupabaseAdminClient();
  const byoc = await resolveWorkspaceFacebookCredentials(client, subdomain, session.userId);
  if (!byoc.ok) {
    return NextResponse.json(
      {
        error: 'BYOC_NOT_CONFIGURED',
        message: 'Facebook BYOC is not configured for this workspace. Configure your App ID and Secret in Settings.',
      },
      { status: 422 }
    );
  }

  // 4. Generate 15-minute cryptographically signed magic token
  const { expectedFbAccountId, expectedDisplayName, bodyTooLarge } =
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
      ...(expectedFbAccountId ? { expectedFbAccountId } : {}),
      ...(expectedDisplayName ? { expectedDisplayName } : {}),
    },
    sessionSecret
  );

  const magicUrl = `${appUrl}/connect/facebook?token=${token}`;

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
  return handleGenerateMagicLink(request, subdomain);
}
