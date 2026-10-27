import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  decryptToken,
  getSessionSecret,
  getTokenEncryptionKey,
  PageInsightsQuerySchema,
  verifySessionToken,
  type Database,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  fetchPageInsights,
  type GraphFetchFn,
} from '@/lib/insights/page-insights';
import { logServerError } from '@/lib/server-analytics';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';

/**
 * Fresh Page Insights proxy — written 2026-10-27 for the Insights rebuild.
 *
 * The route is a thin server-side proxy and NOT a cache: it decrypts the
 * page's Facebook token in memory, calls Facebook live, and returns the
 * result with `no-cache` headers. It performs NO database writes of any
 * kind (the only query is a scoped SELECT for the destination row). The
 * one-hour cache lives in the browser only (see
 * `lib/insights/insights-local-cache.ts`). The token never appears in the
 * response, logs, or error text.
 */

interface DestinationRow {
  id: string;
  external_destination_id: string;
  encrypted_destination_token: string | null;
}

export async function handleGetPageInsights(
  request: NextRequest,
  subdomain: string,
  pageId: string,
  dbClient?: DatabaseClient | SupabaseClient<Database> | null,
  graphFetch?: GraphFetchFn,
): Promise<NextResponse> {
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  let session;
  try {
    session = await verifySessionToken(sessionCookie, getSessionSecret());
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const access = canAccessTenant(session, subdomain);
  if (!access.allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const workspaceId = await resolveTenantWorkspaceId(
    dbClient,
    subdomain,
    session.userId,
    session.role,
  );
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  const parsedQuery = PageInsightsQuerySchema.safeParse({
    range: request.nextUrl.searchParams.get('range') ?? undefined,
  });
  if (!parsedQuery.success) {
    return NextResponse.json({ error: 'Invalid range' }, { status: 400 });
  }

  const supabase =
    dbClient && 'from' in dbClient
      ? (dbClient as SupabaseClient<Database>)
      : getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Insights unavailable' }, { status: 503 });
  }
  const { data: row, error: rowError } = await supabase
    .from('destinations')
    .select('id, external_destination_id, encrypted_destination_token')
    .eq('id', pageId)
    .eq('workspace_id', workspaceId)
    .eq('platform', 'facebook')
    .maybeSingle();
  const destination = row as DestinationRow | null;
  if (rowError || !destination) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }
  if (!destination.encrypted_destination_token) {
    logServerError('page-insights: destination has no token', undefined, {
      source: 'page-insights-route',
    });
    return NextResponse.json({ error: 'Insights unavailable' }, { status: 502 });
  }

  try {
    const token = await decryptToken(
      destination.encrypted_destination_token,
      getTokenEncryptionKey(),
    );
    const payload = await fetchPageInsights({
      fbPageId: destination.external_destination_id,
      pageId,
      token,
      range: parsedQuery.data.range,
      ...(graphFetch ? { graphFetch } : {}),
    });
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'private, no-cache, no-store' },
    });
  } catch (err) {
    logServerError('page-insights: live fetch failed', err, {
      source: 'page-insights-route',
    });
    return NextResponse.json({ error: 'Insights unavailable' }, { status: 502 });
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; pageId: string }> },
): Promise<NextResponse> {
  const { subdomain, pageId } = await context.params;
  return handleGetPageInsights(request, subdomain, pageId);
}
