import { type NextRequest, NextResponse } from 'next/server';
import {
  getSessionSecret,
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
  generateWorkspaceSubdomain,
  verifySessionToken,
  signSessionToken,
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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await extractSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 503 });
  }

  try {
    const { data: workspaces, error } = await supabase
      .from('workspaces')
      .select('id, owner_id, name, subdomain, created_at, updated_at')
      .eq('owner_id', session.userId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[Workspaces API] Failed to fetch workspaces:', error);
      return NextResponse.json({ error: error.message || 'Failed to fetch workspaces' }, { status: 500 });
    }

    const rows = (workspaces || []).map((w) => ({
      id: w.id as string,
      ownerId: w.owner_id as string,
      name: w.name as string,
      subdomain: w.subdomain as string,
      createdAt: w.created_at as string | undefined,
      updatedAt: w.updated_at as string | undefined,
    }));

    return NextResponse.json({ workspaces: rows });
  } catch (err) {
    console.error('[Workspaces API] Unhandled GET exception:', err);
    return NextResponse.json({ error: 'Failed to retrieve workspaces' }, { status: 500 });
  }
}

async function resolveUniqueSubdomain(
  supabase: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  userId: string,
  userSubdomain: string | undefined,
  requestedSubdomain?: string
): Promise<{ subdomain?: string; error?: string; status?: number }> {
  if (requestedSubdomain) {
    const { data: conflictCheck, error } = await supabase
      .from('workspaces')
      .select('id')
      .eq('subdomain', requestedSubdomain)
      .maybeSingle();

    if (error) {
      return { error: 'Database query failed checking subdomain availability', status: 500 };
    }

    if (conflictCheck) {
      return {
        error: 'Subdomain already in use. Please select a different subdomain.',
        status: 409,
      };
    }
    return { subdomain: requestedSubdomain };
  }

  const { data: primaryWsRows } = await supabase
    .from('workspaces')
    .select('subdomain')
    .eq('owner_id', userId)
    .order('created_at', { ascending: true })
    .limit(1);

  const mainSubdomain = primaryWsRows?.[0]?.subdomain || userSubdomain || 'ws';

  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = generateWorkspaceSubdomain(mainSubdomain);
    const { data: existing, error } = await supabase
      .from('workspaces')
      .select('id')
      .eq('subdomain', candidate)
      .maybeSingle();

    if (!error && !existing) {
      return { subdomain: candidate };
    }
  }

  return {
    error: 'Unable to auto-generate a unique workspace subdomain. Please try again.',
    status: 500,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await enforceIpRateLimit(request, 'workspaces_create', 20);
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

  const parseResult = CreateWorkspaceRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.errors[0]?.message || 'Validation failed' },
      { status: 400 }
    );
  }

  const { name, subdomain } = parseResult.data;
  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 503 });
  }

  try {
    const resolution = await resolveUniqueSubdomain(supabase, session.userId, session.subdomain, subdomain);
    if (resolution.error || !resolution.subdomain) {
      return NextResponse.json({ error: resolution.error }, { status: resolution.status || 500 });
    }
    const targetSubdomain = resolution.subdomain;

    // Insert workspace via Supabase PostgREST
    const { data: inserted, error: insertError } = await supabase
      .from('workspaces')
      .insert({
        owner_id: session.userId,
        name,
        subdomain: targetSubdomain,
      })
      .select('id, owner_id, name, subdomain, created_at, updated_at')
      .single();

    if (insertError || !inserted) {
      console.error('[Workspaces API] Failed to insert workspace:', insertError);
      return NextResponse.json(
        { error: insertError?.message || 'Failed to create workspace' },
        { status: 500 }
      );
    }

    const newWorkspace = {
      id: inserted.id as string,
      ownerId: inserted.owner_id as string,
      name: inserted.name as string,
      subdomain: inserted.subdomain as string,
      createdAt: inserted.created_at as string | undefined,
      updatedAt: inserted.updated_at as string | undefined,
    };

    // Query all workspaces owned by the user to populate allowedSubdomains
    const { data: userWorkspaces } = await supabase
      .from('workspaces')
      .select('subdomain')
      .eq('owner_id', session.userId);

    const allowedSubdomains = Array.from(
      new Set(
        (userWorkspaces || [])
          .map((w) => w.subdomain)
          .concat(newWorkspace.subdomain)
          .filter((sub): sub is string => typeof sub === 'string' && Boolean(sub))
      )
    );

    // Generate new session token pointing to the newly created workspace
    const secret = getSessionSecret();
    const newToken = await signSessionToken(
      {
        userId: session.userId,
        email: session.email,
        name: session.name,
        subdomain: newWorkspace.subdomain,
        allowedSubdomains,
        role: session.role,
        status: session.status,
      },
      secret
    );

    const response = NextResponse.json({
      success: true,
      workspace: newWorkspace,
    });

    setSessionCookie(response, newToken, request.headers.get('host'));
    return response;
  } catch (err) {
    console.error('[Workspaces API] Unhandled POST exception:', err);
    return NextResponse.json(
      { error: 'An unexpected server error occurred while creating workspace' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const limited = await enforceIpRateLimit(request, 'workspaces_update', 20);
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

  const parseResult = UpdateWorkspaceRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.errors[0]?.message || 'Validation failed' },
      { status: 400 }
    );
  }

  const targetSubdomain = parseResult.data.subdomain || session.subdomain;
  if (!targetSubdomain) {
    return NextResponse.json({ error: 'Target workspace subdomain is required' }, { status: 400 });
  }

  const supabase = getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 503 });
  }

  try {
    const { data: updated, error } = await supabase
      .from('workspaces')
      .update({ name: parseResult.data.name })
      .eq('owner_id', session.userId)
      .eq('subdomain', targetSubdomain)
      .select('id, owner_id, name, subdomain, created_at, updated_at')
      .maybeSingle();

    if (error) {
      console.error('[Workspaces API] Failed to update workspace:', error);
      return NextResponse.json({ error: error.message || 'Failed to update workspace' }, { status: 500 });
    }

    if (!updated) {
      return NextResponse.json({ error: 'Workspace not found or unauthorized' }, { status: 404 });
    }

    const updatedWorkspace = {
      id: updated.id as string,
      ownerId: updated.owner_id as string,
      name: updated.name as string,
      subdomain: updated.subdomain as string,
      createdAt: updated.created_at as string | undefined,
      updatedAt: updated.updated_at as string | undefined,
    };

    return NextResponse.json({
      success: true,
      workspace: updatedWorkspace,
    });
  } catch (err) {
    console.error('[Workspaces API] Unhandled PATCH exception:', err);
    return NextResponse.json(
      { error: 'An unexpected server error occurred while updating workspace' },
      { status: 500 }
    );
  }
}

