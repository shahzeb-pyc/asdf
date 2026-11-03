import { type NextRequest, NextResponse } from 'next/server';
import {
  AgentKeyCreateResponseSchema,
  AgentKeyCreateSchema,
  AgentKeyListResponseSchema,
  MUSE_KEY_SCOPES,
  museKeyPrefix,
} from '@fbuploadpro/contracts';
import { authenticateTenantRoute, getRouteSupabase } from '@/lib/route-auth';
import { generateAgentKey, hashAgentKey } from '@/lib/agent-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import type { SupabaseClient } from '@supabase/supabase-js';

function missingTableError(error: { code?: string }): boolean {
  return error?.code === '42P01';
}

export async function handleListKeys(
  request: NextRequest,
  subdomain: string,
  dbClient?: SupabaseClient
): Promise<NextResponse> {
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json(
      { error: 'Database service unavailable' },
      { status: 500 }
    );
  }
  const { data, error } = await supabase
    .from('agent_keys')
    .select('id, name, key_prefix, scopes, expires_at, created_at, last_used_at')
    .eq('user_id', auth.session.userId)
    .order('created_at', { ascending: false });
  if (error) {
    if (missingTableError(error)) {
      return NextResponse.json(
        { error: 'Muse keys are not set up yet' },
        { status: 500 }
      );
    }
    logServerError('[muse/keys] Failed to list keys', error, {
      source: 'muse-keys',
      subdomain,
    });
    return NextResponse.json(
      { error: 'Failed to list keys' },
      { status: 500 }
    );
  }
  const keys = (data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: MUSE_KEY_SCOPES,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
  return NextResponse.json(AgentKeyListResponseSchema.parse({ keys }));
}

export async function handleCreateKey(
  request: NextRequest,
  subdomain: string,
  dbClient?: SupabaseClient
): Promise<NextResponse> {
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }
  const parsed = AgentKeyCreateSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json(
      { error: 'Database service unavailable' },
      { status: 500 }
    );
  }
  // The key is generated here, hashed for storage, and returned
  // exactly once below. It is never logged and never stored.
  const key = generateAgentKey();
  const { data, error } = await supabase
    .from('agent_keys')
    .insert({
      user_id: auth.session.userId,
      name: parsed.data.name,
      key_hash: hashAgentKey(key),
      key_prefix: museKeyPrefix(key),
      scopes: [...MUSE_KEY_SCOPES],
      expires_at: null,
    })
    .select('id, name, key_prefix, scopes, expires_at, created_at, last_used_at')
    .single();
  if (error || !data) {
    if (error && missingTableError(error)) {
      return NextResponse.json(
        { error: 'Muse keys are not set up yet' },
        { status: 500 }
      );
    }
    logServerError('[muse/keys] Failed to create key', error, {
      source: 'muse-keys',
      subdomain,
    });
    return NextResponse.json(
      { error: 'Failed to create key' },
      { status: 500 }
    );
  }
  return NextResponse.json(
    AgentKeyCreateResponseSchema.parse({
      id: data.id,
      name: data.name,
      keyPrefix: data.key_prefix,
      scopes: MUSE_KEY_SCOPES,
      expiresAt: data.expires_at,
      createdAt: data.created_at,
      lastUsedAt: data.last_used_at,
      key,
    }),
    { status: 201 }
  );
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleListKeys(request, subdomain);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleCreateKey(request, subdomain);
}
