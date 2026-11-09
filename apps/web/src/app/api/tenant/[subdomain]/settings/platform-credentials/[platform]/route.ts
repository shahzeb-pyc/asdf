import { type NextRequest, NextResponse } from 'next/server';
import {
  getSessionSecret,
  getTokenEncryptionKey,
  verifySessionToken,
  canAccessTenant,
  decryptToken,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { bodyTooLargeResponse, enforceIpRateLimit, readJsonBody } from '@/lib/request-body';
import { resolveWorkspaceIdFromSession } from '@/lib/server/workspace-resolver';
import {
  SavePlatformCredentialsRequestSchema,
  deleteCredentials,
  getCredentials,
  platformLabel,
  saveCredentials,
  toSecretHint,
  type ByocPlatform,
} from '@/lib/server/platform-credentials';

async function extractSession(request: NextRequest): Promise<SessionPayload | null> {
  const token = request.cookies.get('fbup_session')?.value;
  if (!token) return null;
  try {
    return await verifySessionToken(token, getSessionSecret());
  } catch {
    return null;
  }
}

/**
 * App details (credentials) for the bring-your-own-app platforms that do not
 * have a dedicated settings route: instagram and threads. Facebook keeps
 * its existing route; youtube, x, and tiktok never store app details here.
 */
async function authorizePlatformRequest(
  request: NextRequest,
  subdomain: string,
  platform: string
): Promise<
  | { session: SessionPayload; platform: ByocPlatform }
  | { errorResponse: NextResponse }
> {
  const session = await extractSession(request);
  if (!session) {
    return { errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  // Audit S1: live session validation — suspension and password
  // changes take effect immediately (this helper gates GET/PUT/
  // DELETE alike).
  const { validateSessionActive } = await import('@/lib/auth/session');
  if (!(await validateSessionActive(session))) {
    return { errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return { errorResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  if (platform !== 'instagram' && platform !== 'threads') {
    return {
      errorResponse: NextResponse.json(
        { error: 'App details can only be added for Instagram and Threads here.' },
        { status: 400 }
      ),
    };
  }

  return { session, platform };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; platform: string }> }
): Promise<NextResponse> {
  const { subdomain, platform } = await context.params;
  const auth = await authorizePlatformRequest(request, subdomain, platform);
  if ('errorResponse' in auth) return auth.errorResponse;
  const { session } = auth;
  const byocPlatform = auth.platform;

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 503 });
  }

  try {
    const workspaceId = await resolveWorkspaceIdFromSession(session, subdomain, supabase);
    if (!workspaceId) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const credentials = await getCredentials(workspaceId, byocPlatform, supabase);

    // Spec 139 N3: the settings GET never carries the secret itself —
    // only a masked hint (bullets + last four). The full value is
    // disclosed solely by the reveal action
    // (POST …/settings/platform-credentials/[platform]/reveal).
    let secretHint: string | null = null;
    if (credentials?.encryptedClientSecret) {
      try {
        secretHint = toSecretHint(
          await decryptToken(credentials.encryptedClientSecret, getTokenEncryptionKey())
        );
      } catch (err) {
        console.error('[Platform Credentials API] Failed to decrypt app secret for settings hint:', err);
      }
    }

    return NextResponse.json({
      workspaceId,
      subdomain,
      platform: byocPlatform,
      appId: credentials?.clientId || '',
      secretHint,
      hasSecret: Boolean(credentials?.encryptedClientSecret),
      status: credentials?.status || 'unverified',
      lastTestedAt: credentials?.lastTestedAt || null,
      connectedAt: credentials?.createdAt || credentials?.updatedAt || null,
      // Instagram Unified Login only: the Configuration ID is an
      // identifier, not a secret, so it travels in the GET like the
      // App ID. Other platforms omit it (null).
      configId: credentials?.configId ?? null,
      appName: credentials?.appName ?? null,
    });
  } catch (err) {
    console.error('[Platform Credentials API] Unhandled GET exception:', err);
    return NextResponse.json({ error: 'Failed to retrieve app details' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; platform: string }> }
): Promise<NextResponse> {
  const { subdomain, platform } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_platform_credentials_save', 20);
  if (limited) return limited;
  const auth = await authorizePlatformRequest(request, subdomain, platform);
  if ('errorResponse' in auth) return auth.errorResponse;
  const { session } = auth;
  const byocPlatform = auth.platform;

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
  }
  const body: unknown = bodyResult.value;

  const parseResult = SavePlatformCredentialsRequestSchema.safeParse(body);
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
    const workspaceId = await resolveWorkspaceIdFromSession(session, subdomain, supabase);
    if (!workspaceId) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Instagram Unified Login branch (Threads is untouched): the triple
    // is required and the pair is verified against Meta BEFORE saving,
    // mirroring the Facebook BYOC guarantee. A rejected pair or an
    // unreachable Meta saves nothing, and the two failures stay
    // distinguishable in both the response and the log.
    if (byocPlatform === 'instagram') {
      const submittedConfigId = (parseResult.data.configId ?? '').trim();
      if (!submittedConfigId) {
        return NextResponse.json(
          { error: 'Enter your Configuration ID to complete setup.' },
          { status: 400 }
        );
      }
      const submittedSecret = parseResult.data.appSecret;
      const hasNewSecret = Boolean(submittedSecret && submittedSecret.length > 0);
      const existing = await getCredentials(workspaceId, 'instagram', supabase);

      // Nothing changed: same App ID, same Configuration ID, no new
      // secret — keep the stored name and status exactly as they are,
      // with no Graph call and no write.
      if (
        existing &&
        existing.clientId === parseResult.data.appId &&
        existing.configId === submittedConfigId &&
        !hasNewSecret
      ) {
        return NextResponse.json({
          success: true,
          hasSecret: true,
          status: existing.status,
          connectedAt: existing.createdAt ?? existing.updatedAt ?? new Date().toISOString(),
          appName: existing.appName ?? null,
          configId: existing.configId,
        });
      }

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
          console.error('[Platform Credentials API] Failed to decrypt stored app secret for verification:', err);
          return NextResponse.json({ error: 'Failed to save app details' }, { status: 500 });
        }
      }
      if (!effectiveSecret) {
        return NextResponse.json(
          { error: 'Enter your Instagram App Secret to complete setup.' },
          { status: 400 }
        );
      }

      const { verifyInstagramApp } = await import('@/lib/server/instagram-app-verify');
      const verification = await verifyInstagramApp(parseResult.data.appId, effectiveSecret);
      if (!verification.ok) {
        if (verification.kind === 'rejected') {
          return NextResponse.json(
            { error: 'Meta rejected this App ID and App Secret. Please check them and try again.' },
            { status: 400 }
          );
        }
        return NextResponse.json(
          { error: 'Meta could not be reached to verify your app. Please try again.' },
          { status: 503 }
        );
      }

      const instagramSave = await saveCredentials(
        workspaceId,
        'instagram',
        {
          clientId: parseResult.data.appId,
          clientSecret: hasNewSecret ? (submittedSecret as string) : undefined,
          configId: submittedConfigId,
          verifiedAppName: verification.appName,
        },
        supabase
      );
      if (!instagramSave.ok) {
        return NextResponse.json({ error: instagramSave.error }, { status: instagramSave.status });
      }
      return NextResponse.json({
        success: true,
        hasSecret: true,
        status: 'valid',
        connectedAt: new Date().toISOString(),
        appName: verification.appName,
        configId: submittedConfigId,
      });
    }

    const saveResult = await saveCredentials(
      workspaceId,
      byocPlatform,
      { clientId: parseResult.data.appId, clientSecret: parseResult.data.appSecret },
      supabase
    );

    if (!saveResult.ok) {
      return NextResponse.json({ error: saveResult.error }, { status: saveResult.status });
    }

    return NextResponse.json({
      success: true,
      hasSecret: true,
      status: 'unverified',
      connectedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Platform Credentials API] Unhandled PUT exception:', err);
    return NextResponse.json({ error: 'Failed to save app details' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; platform: string }> }
): Promise<NextResponse> {
  const { subdomain, platform } = await context.params;
  const auth = await authorizePlatformRequest(request, subdomain, platform);
  if ('errorResponse' in auth) return auth.errorResponse;
  const { session } = auth;
  const byocPlatform = auth.platform;

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 503 });
  }

  try {
    const workspaceId = await resolveWorkspaceIdFromSession(session, subdomain, supabase);
    if (!workspaceId) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Delete ONLY this platform's App ID and App Secret (its platform_credentials row).
    // Connected accounts and their tokens remain fully intact.
    const deleteResult = await deleteCredentials(workspaceId, byocPlatform, supabase);

    if (!deleteResult.ok) {
      return NextResponse.json({ error: deleteResult.error }, { status: deleteResult.status });
    }

    return NextResponse.json({
      success: true,
      disconnected: true,
    });
  } catch (err) {
    console.error('[Platform Credentials API] Unhandled DELETE exception:', err);
    return NextResponse.json(
      { error: `Failed to disconnect ${platformLabel(byocPlatform)}` },
      { status: 500 }
    );
  }
}
