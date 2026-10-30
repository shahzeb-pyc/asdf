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
import { enforceIpRateLimit } from '@/lib/request-body';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import {
  getCredentials,
  platformLabel,
  type ByocPlatform,
} from '@/lib/server/platform-credentials';

async function extractSession(request: NextRequest): Promise<SessionPayload | null> {
  const token = request.cookies.get('fbup_session')?.value;
  if (!token) return null;
  try {
    return await verifySessionToken(token, getSessionSecret());
  } catch {
    // Surfaced, not swallowed (spec 137 §3.1): an unverifiable
    // session cookie on a secret-disclosure action is worth an
    // audit line — the line never carries the token itself.
    console.error('[Platform Credentials API] Session verification failed on a reveal request.');
    return null;
  }
}

/**
 * Reveal the workspace's saved App Secret for instagram or threads
 * (spec 139 N3).
 *
 * The settings GET is masked-by-default and never carries the secret;
 * this dedicated action is the ONLY way the value leaves the server,
 * and only for the signed-in workspace's own credentials. The
 * response is no-store and the reveal is logged — the log line never
 * contains the secret value.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; platform: string }> }
): Promise<NextResponse> {
  const { subdomain, platform } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_platform_credentials_reveal', 20);
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

  if (platform !== 'instagram' && platform !== 'threads') {
    return NextResponse.json(
      { error: 'App details can only be added for Instagram and Threads here.' },
      { status: 400 }
    );
  }
  const byocPlatform: ByocPlatform = platform;

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 503 });
  }

  try {
    const workspaceId = await resolveTenantWorkspaceId(supabase, subdomain, session.userId);
    if (!workspaceId) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const credentials = await getCredentials(workspaceId, byocPlatform, supabase);
    if (!credentials?.encryptedClientSecret) {
      return NextResponse.json(
        {
          error: `No ${platformLabel(byocPlatform)} App Secret is saved for this workspace.`,
        },
        { status: 404 }
      );
    }

    let decryptedSecret: string;
    try {
      decryptedSecret = await decryptToken(credentials.encryptedClientSecret, getTokenEncryptionKey());
    } catch (err) {
      console.error('[Platform Credentials API] Failed to decrypt app secret for reveal:', err);
      return NextResponse.json(
        { error: "Couldn't show your App Secret. Please try again." },
        { status: 500 }
      );
    }

    // Audit the reveal WITHOUT the value: who, which workspace, when.
    console.info(
      `[Platform Credentials API] ${platformLabel(byocPlatform)} app secret revealed for workspace ${workspaceId} by user ${session.userId}`
    );

    return NextResponse.json(
      { appSecret: decryptedSecret },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    console.error('[Platform Credentials API] Unhandled reveal exception:', err);
    return NextResponse.json(
      { error: "Couldn't show your App Secret. Please try again." },
      { status: 500 }
    );
  }
}
