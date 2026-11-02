import { type NextRequest, NextResponse } from 'next/server';
import { authenticateTenantRoute, getRouteSupabase } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import type { SupabaseClient } from '@supabase/supabase-js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Revoking a Muse key deletes its row. It does not flip to a
 * Revoked row and stay in the list. Past uploads stay in the
 * Media Library and in agent_activity (agent_key_id SET NULL);
 * only the key row itself is gone.
 */
export async function handleDeleteKey(
  request: NextRequest,
  subdomain: string,
  keyId: string,
  dbClient?: SupabaseClient
): Promise<NextResponse> {
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  if (!UUID_REGEX.test(keyId)) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }
  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return NextResponse.json(
      { error: 'Database service unavailable' },
      { status: 500 }
    );
  }
  const { error, count } = await supabase
    .from('agent_keys')
    .delete({ count: 'exact' })
    .eq('id', keyId)
    .eq('user_id', auth.session.userId);
  if (error) {
    if (error.code === '42P01') {
      return NextResponse.json(
        { error: 'Muse keys are not set up yet' },
        { status: 500 }
      );
    }
    logServerError('[muse/keys] Failed to delete key', error, {
      source: 'muse-keys',
      subdomain,
    });
    return NextResponse.json(
      { error: 'Failed to delete key' },
      { status: 500 }
    );
  }
  if (!count) {
    return NextResponse.json({ error: 'Key not found' }, { status: 404 });
  }
  return NextResponse.json({ success: true, keyId });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; keyId: string }> }
): Promise<NextResponse> {
  const { subdomain, keyId } = await context.params;
  return handleDeleteKey(request, subdomain, keyId);
}
