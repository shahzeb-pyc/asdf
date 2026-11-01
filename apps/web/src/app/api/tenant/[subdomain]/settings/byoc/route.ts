import { type NextRequest, NextResponse } from 'next/server';
import {
  getSessionSecret,
  getTokenEncryptionKey,
  SaveBYOCCredentialsRequestSchema,
  verifySessionToken,
  canAccessTenant,
  decryptToken,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { bodyTooLargeResponse, enforceIpRateLimit, readJsonBody } from '@/lib/request-body';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import {
  deleteCredentials,
  getCredentials,
  saveCredentials,
  toSecretHint,
} from '@/lib/server/platform-credentials';
import { verifyFacebookApp } from '@/lib/server/facebook-app-verify';

async function extractSession(request: NextRequest): Promise<SessionPayload | null> {
  const token = request.cookies.get('fbup_session')?.value;
  if (!token) return null;
  try {
    return await verifySessionToken(token, getSessionSecret());
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const session = await extractSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Audit S1: live session validation — suspension and password
  // changes take effect immediately, including on secret reveal.
  const { validateSessionActive } = await import('@/lib/auth/session');
  if (!(await validateSessionActive(session))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 503 });
  }

  try {
    const workspaceId = await resolveTenantWorkspaceId(supabase, subdomain, session.userId);
    if (!workspaceId) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const byoc = await getCredentials(workspaceId, 'facebook', supabase);

    // Spec 139 N3: the settings GET never carries the secret itself —
    // only a masked hint (bullets + last four). The full value is
    // disclosed solely by the reveal action (POST …/settings/byoc/reveal).
    let secretHint: string | null = null;
    if (byoc?.encryptedClientSecret) {
      try {
        secretHint = toSecretHint(
          await decryptToken(byoc.encryptedClientSecret, getTokenEncryptionKey())
        );
      } catch (err) {
        console.error('[BYOC Settings API] Failed to decrypt app secret for settings hint:', err);
      }
    }

    return NextResponse.json({
      workspaceId,
      subdomain,
      fbAppId: byoc?.clientId || '',
      fbAppSecretHint: secretHint,
      hasSecret: Boolean(byoc?.encryptedClientSecret),
      status: byoc?.status || 'unverified',
      lastTestedAt: byoc?.lastTestedAt || null,
      fbAppName: byoc?.appName ?? null,
      connectedAt: byoc?.createdAt || byoc?.updatedAt || null,
    });
  } catch (err) {
    console.error('[BYOC Settings API] Unhandled GET exception:', err);
    return NextResponse.json({ error: 'Failed to retrieve BYOC settings' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_byoc_save', 20);
  if (limited) return limited;
  const session = await extractSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Audit S1: live session validation — suspension and password
  // changes take effect immediately, including on secret reveal.
  const { validateSessionActive } = await import('@/lib/auth/session');
  if (!(await validateSessionActive(session))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
  }
  const body: unknown = bodyResult.value;

  const parseResult = SaveBYOCCredentialsRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.errors[0]?.message || 'Validation failed' },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 503 });
  }

  try {
    const workspaceId = await resolveTenantWorkspaceId(supabase, subdomain, session.userId);
    if (!workspaceId) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const submittedId = parseResult.data.fbAppId;
    const submittedSecret = parseResult.data.fbAppSecret;
    const hasNewSecret = Boolean(submittedSecret && submittedSecret.length > 0);
    const existing = await getCredentials(workspaceId, 'facebook', supabase);

    // Nothing changed: same App ID and no new secret — keep the stored
    // name and status exactly as they are, with no Graph call and no
    // write. (A legacy unverified row stays unverified here; it gains
    // a name only when it is actually re-verified below.)
    if (existing && existing.clientId === submittedId && !hasNewSecret) {
      return NextResponse.json({
        success: true,
        hasSecret: true,
        status: existing.status,
        connectedAt: existing.createdAt ?? existing.updatedAt ?? new Date().toISOString(),
        fbAppName: existing.appName ?? null,
      });
    }

    // The secret the verification runs with: the submitted one, or the
    // stored one when the field was left blank (edit keeps the secret).
    let effectiveSecret: string | null = null;
    if (hasNewSecret) {
      effectiveSecret = submittedSecret as string;
    } else if (existing?.encryptedClientSecret) {
      try {
        effectiveSecret = await decryptToken(
          existing.encryptedClientSecret,
          getTokenEncryptionKey()
        );
      } catch (err) {
        console.error('[BYOC Settings API] Failed to decrypt stored app secret for verification:', err);
        return NextResponse.json({ error: 'Failed to save BYOC credentials' }, { status: 500 });
      }
    }
    if (!effectiveSecret) {
      return NextResponse.json(
        { error: 'Enter your Facebook App Secret to complete setup.' },
        { status: 400 }
      );
    }

    // Verify BEFORE saving: a rejected pair is never stored, so a typo
    // fails here with a plain message instead of surfacing later at
    // account-connect time. An unreachable Meta is a different failure
    // and stays distinguishable in both the response and the log.
    const verification = await verifyFacebookApp(submittedId, effectiveSecret);
    if (!verification.ok) {
      if (verification.kind === 'rejected') {
        return NextResponse.json(
          {
            error:
              'Facebook rejected this App ID and App Secret. Please check them and try again.',
          },
          { status: 400 }
        );
      }
      return NextResponse.json(
        { error: "Couldn't reach Facebook to verify your app. Please try again." },
        { status: 503 }
      );
    }

    const saveResult = await saveCredentials(
      workspaceId,
      'facebook',
      {
        clientId: submittedId,
        clientSecret: hasNewSecret ? (submittedSecret as string) : undefined,
        verifiedAppName: verification.appName,
      },
      supabase
    );

    if (!saveResult.ok) {
      return NextResponse.json({ error: saveResult.error }, { status: saveResult.status });
    }

    return NextResponse.json({
      success: true,
      hasSecret: true,
      status: 'valid',
      connectedAt: new Date().toISOString(),
      fbAppName: verification.appName,
    });
  } catch (err) {
    console.error('[BYOC Settings API] Unhandled PUT exception:', err);
    return NextResponse.json({ error: 'Failed to save BYOC credentials' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const session = await extractSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Audit S1: live session validation — suspension and password
  // changes take effect immediately, including on secret reveal.
  const { validateSessionActive } = await import('@/lib/auth/session');
  if (!(await validateSessionActive(session))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 503 });
  }

  try {
    const workspaceId = await resolveTenantWorkspaceId(supabase, subdomain, session.userId);
    if (!workspaceId) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Delete ONLY the App ID and App Secret (the platform_credentials row for facebook)
    // Connected accounts, Facebook pages, media items, and scheduled posts remain 100% intact.
    const deleteResult = await deleteCredentials(workspaceId, 'facebook', supabase);

    if (!deleteResult.ok) {
      return NextResponse.json({ error: deleteResult.error }, { status: deleteResult.status });
    }

    return NextResponse.json({
      success: true,
      disconnected: true,
    });
  } catch (err) {
    console.error('[BYOC Settings API] Unhandled DELETE exception:', err);
    return NextResponse.json({ error: 'Failed to disconnect Facebook' }, { status: 500 });
  }
}
