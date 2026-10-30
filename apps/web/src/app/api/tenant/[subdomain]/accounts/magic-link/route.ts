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
 * Body schema for the magic-link request (spec 139 Wave B, audit C2).
 * Both fields are optional hints about the account the user expects
 * to connect. Audit N5: a field of the wrong type, blank, or over
 * 255 chars is a 400 now — the old `.catch(undefined)` silently
 * dropped malformed hints, which also silently lost the BL2
 * mismatch warning they carried. An absent/empty body still means
 * "no hints" (the modal posts no body for a fresh connect).
 */
const MagicLinkRequestBodySchema = z.object({
  expectedFbAccountId: z.string().trim().min(1).max(255).optional(),
  expectedDisplayName: z.string().trim().min(1).max(255).optional(),
});

async function extractExpectedAccountFromBody(request: NextRequest): Promise<{
  expectedFbAccountId?: string | undefined;
  expectedDisplayName?: string | undefined;
  bodyTooLarge?: boolean;
  bodyInvalid?: boolean;
}> {
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return { bodyTooLarge: true };
    // No/unreadable body: no hints, not an error.
    return {};
  }
  const parsed = MagicLinkRequestBodySchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return { bodyInvalid: true };
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

  // P1-7: the app URL must never fall back to localhost outside
  // development — a signed URL minted against localhost silently
  // breaks connect in production. Fail loud (500, no URL, no token
  // minted) when the variable is unset in production; development
  // keeps the localhost fallback. This check runs after auth and
  // the tenant check (so unauthenticated callers learn nothing
  // about configuration) but before the BYOC pre-check and any
  // token minting: a missing deployment URL is the more
  // fundamental misconfiguration and must surface first.
  const configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configuredAppUrl && process.env.NODE_ENV === 'production') {
    return NextResponse.json(
      {
        error: 'APP_URL_NOT_CONFIGURED',
        message: 'The app URL is not configured; magic links cannot be generated.',
      },
      { status: 500 }
    );
  }
  const appUrl = configuredAppUrl || 'http://localhost:3000';

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
  const { expectedFbAccountId, expectedDisplayName, bodyTooLarge, bodyInvalid } =
    await extractExpectedAccountFromBody(request);
  if (bodyTooLarge) return bodyTooLargeResponse();
  if (bodyInvalid) {
    return NextResponse.json(
      { error: 'Invalid request payload: expectedFbAccountId and expectedDisplayName must be non-empty strings of at most 255 characters.' },
      { status: 400 }
    );
  }

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

  // Audit N5: strip trailing slashes off the app URL (no double
  // slash) and encode the token — safe today only because the
  // token charset is base64url+hex, which must not be assumed.
  // Plain loop, not a /\/+$/ regex: Sonar S8786 flags the regex
  // form for super-linear backtracking.
  let magicBase = appUrl;
  while (magicBase.endsWith('/')) magicBase = magicBase.slice(0, -1);
  const magicUrl = `${magicBase}/connect/facebook?token=${encodeURIComponent(token)}`;

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
