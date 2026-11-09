import { type NextRequest, NextResponse } from 'next/server';
import {
  getSessionSecret,
  SwitchWorkspaceRequestSchema,
  verifySessionToken,
  signSessionToken,
  buildTenantUrl,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { setSessionCookie } from '@/lib/auth/session';
import { bodyTooLargeResponse, enforceIpRateLimit, readJsonBody } from '@/lib/request-body';

async function extractSession(request: NextRequest): Promise<SessionPayload | null> {
  const token = request.cookies.get('fbup_session')?.value;
  if (!token) return null;
  try {
    return await verifySessionToken(token, getSessionSecret());
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await enforceIpRateLimit(request, 'workspaces_switch', 30);
  if (limited) return limited;
  const session = await extractSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json({ error: 'Invalid JSON request body' }, { status: 400 });
  }
  const body: unknown = bodyResult.value;

  const parseResult = SwitchWorkspaceRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.errors[0]?.message || 'Validation failed' },
      { status: 400 }
    );
  }

  const { subdomain } = parseResult.data;
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 503 });
  }

  try {
    // Validate ownership via Supabase PostgREST
    const { data: rows, error } = await supabase
      .from('workspaces')
      .select('id, name, subdomain')
      .eq('owner_id', session.userId)
      .eq('subdomain', subdomain);

    if (error) {
      console.error('[Switch Workspace API] Query failed:', error);
      return NextResponse.json({ error: 'Failed to verify workspace access' }, { status: 500 });
    }

    if ((!rows || rows.length === 0) && session.role !== 'admin') {
      return NextResponse.json(
        { error: 'You do not have access to this workspace' },
        { status: 403 }
      );
    }

    // Populate allowedSubdomains with all workspaces owned by the user
    const { data: userWorkspaces } = await supabase
      .from('workspaces')
      .select('subdomain')
      .eq('owner_id', session.userId);

    const allowedSubdomains = Array.from(
      new Set(
        (userWorkspaces || [])
          .map((w) => w.subdomain)
          .concat(subdomain)
          .filter((sub): sub is string => typeof sub === 'string' && Boolean(sub))
      )
    );

    // Issue updated session token pointing to the switched workspace subdomain
    // S3: the claim is the NEW active workspace's id (rows[0].id, just
    // owner-checked above) — never the old token's claim — and only
    // for role === 'user'; admin/seller tokens carry no claim.
    const secret = getSessionSecret();
    const newToken = await signSessionToken(
      {
        userId: session.userId,
        email: session.email,
        name: session.name,
        subdomain,
        allowedSubdomains,
        role: session.role,
        status: session.status,
        ...(session.role === 'user' && rows?.[0]?.id ? { workspaceId: rows[0].id } : {}),
      },
      secret
    );

    const rootDomain = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'localhost:3000';
    const redirectUrl = buildTenantUrl(subdomain, '/', request.url, rootDomain).toString();

    const response = NextResponse.json({
      success: true,
      targetSubdomain: subdomain,
      redirectUrl,
    });

    setSessionCookie(response, newToken, request.headers.get('host'));
    return response;
  } catch (err) {
    console.error('[Switch Workspace API] Unhandled exception:', err);
    return NextResponse.json(
      { error: 'An unexpected server error occurred while switching workspace' },
      { status: 500 }
    );
  }
}
