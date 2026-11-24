import { type NextRequest, NextResponse } from 'next/server';
import {
  AnalyticsAggregateQuerySchema,
  AnalyticsAggregateResponseSchema,
  canAccessTenant,
  getSessionSecret,
  verifySessionToken,
  type Database,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  aggregateAnalytics,
  countConnectedPages,
  formatDateRangeLabel,
  parseStoredAnalytics,
  periodLabel,
  type AnalyticsPageRecord,
} from '@/lib/analytics/aggregate';
import { logServerError } from '@/lib/server-analytics';
import { resolveWorkspaceIdFromSession } from '@/lib/server/workspace-resolver';

/**
 * Spec 241 — combined Analytics read (stored data only, no live
 * Facebook calls).
 *
 * GET /api/tenant/[subdomain]/analytics?workspace=all|<uuid>&period=1|7|28
 *
 * The worker fills four JSON columns per page record once a day; this
 * route sums them across the picked workspace (or all of the caller's
 * workspaces) into the combined dashboard numbers. One row per
 * Facebook page (deduped by page id, preferring the destinations
 * copy, falling back to the row with stored analytics). Listed set:
 * Facebook pages, status active, 100+ stored followers — the same
 * set the worker fetches. A stored column that does not parse is
 * logged and contributes nothing (fail loud in the log, never a
 * guessed number in the response).
 *
 * Spec 242 — `pagesConnected` counts distinct Facebook page ids
 * over the SAME destinations scan (every status except
 * `disconnected`); it follows the workspace picker and never
 * changes with the period picker.
 *
 * Reads are bounded and paged (200 rows per page, ordered by id) —
 * PostgREST silently truncates at 1,000 rows, so an unbounded read
 * would silently drop pages.
 */

const PAGE_SIZE = 200;

interface DestinationRow {
  id: string;
  workspace_id: string;
  external_destination_id: string;
  status: string;
  metadata: Record<string, unknown> | null;
  analytics_1d: unknown;
  analytics_7d: unknown;
  analytics_28d: unknown;
  analytics_locations: unknown;
}

interface AduRow {
  id: string;
  destination_id: string;
  workspace_id: string;
  status: string;
  starting_followers: number | null;
  current_followers: number | null;
  analytics_1d: unknown;
  analytics_7d: unknown;
  analytics_28d: unknown;
  analytics_locations: unknown;
  analytics_updated_at: string | null;
}

interface MirrorRow {
  id: string;
  workspace_id: string;
  target_platform: string;
  target_external_id: string;
  status: string;
  starting_followers: number | null;
  current_followers: number | null;
  analytics_1d: unknown;
  analytics_7d: unknown;
  analytics_28d: unknown;
  analytics_locations: unknown;
  analytics_updated_at: string | null;
}

interface PageResult {
  data: unknown;
  error: { message?: string } | null;
}

/**
 * Bounded paged scan: 200 rows per page, ordered by the immutable
 * id, until a short page. PostgREST silently truncates at 1,000
 * rows, so a single unbounded read would silently drop pages.
 */
async function fetchAll<T>(build: (offset: number) => PromiseLike<PageResult>): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await build(offset);
    if (error) {
      throw new Error(`analytics scan failed: ${error.message ?? 'unknown error'}`);
    }
    const rows = (Array.isArray(data) ? data : []) as T[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return out;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metadataUpdatedAt(metadata: Record<string, unknown> | null): string | null {
  const value = metadata?.analytics_updated_at;
  return typeof value === 'string' ? value : null;
}

function hasStoredAnalytics(record: AnalyticsPageRecord): boolean {
  return (
    record.analytics1d != null ||
    record.analytics7d != null ||
    record.analytics28d != null ||
    record.analyticsLocations != null
  );
}

export async function handleGetAnalytics(
  request: NextRequest,
  subdomain: string,
  dbClient?: DatabaseClient | SupabaseClient<Database> | null
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
  const currentWorkspaceId = await resolveWorkspaceIdFromSession(
    session,
    subdomain,
    dbClient,
    session.role
  );
  if (!currentWorkspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }
  const parsedQuery = AnalyticsAggregateQuerySchema.safeParse({
    // Defaults match the page: the current workspace, 28 days.
    workspace: request.nextUrl.searchParams.get('workspace') ?? currentWorkspaceId,
    period: request.nextUrl.searchParams.get('period') ?? '28',
  });
  if (!parsedQuery.success) {
    return NextResponse.json({ error: 'Invalid workspace or period' }, { status: 400 });
  }
  const { workspace, period } = parsedQuery.data;

  const supabase =
    dbClient && 'from' in dbClient
      ? (dbClient as SupabaseClient<Database>)
      : getSupabaseAdminClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Analytics unavailable' }, { status: 503 });
  }

  // The caller's workspaces: 'all' unions exactly these, never more.
  // (Admin sessions see every workspace; user sessions see their own —
  // the same ownership rule as the workspaces list endpoint.)
  let workspaceQuery = supabase.from('workspaces').select('id');
  if (session.role !== 'admin') {
    workspaceQuery = workspaceQuery.eq('owner_id', session.userId);
  }
  const { data: workspaceRows, error: workspaceError } = await workspaceQuery
    .order('created_at', { ascending: true });
  if (workspaceError) {
    logServerError('analytics: workspace list failed', workspaceError, {
      source: 'analytics-route',
    });
    return NextResponse.json({ error: 'Analytics unavailable' }, { status: 503 });
  }
  const ownedWorkspaceIds = (workspaceRows as Array<{ id: string }>).map((w) => w.id);
  if (!ownedWorkspaceIds.includes(currentWorkspaceId)) {
    ownedWorkspaceIds.push(currentWorkspaceId);
  }
  const workspaceIds =
    workspace === 'all'
      ? ownedWorkspaceIds
      : ownedWorkspaceIds.includes(workspace)
        ? [workspace]
        : null;
  if (workspaceIds === null) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  if (workspaceIds.length === 0) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  try {
    // No status filter here: the listed set needs active rows only,
    // but the spec-242 count reads the same scan with every status
    // except `disconnected`. The split below keeps the listed set
    // exactly as it was.
    const allDestinations = await fetchAll<DestinationRow>((offset) =>
      supabase
        .from('destinations')
        .select(
          'id, workspace_id, external_destination_id, status, metadata, analytics_1d, analytics_7d, analytics_28d, analytics_locations'
        )
        .eq('platform', 'facebook')
        .in('workspace_id', workspaceIds)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1)
    );
    const destinations = allDestinations.filter((d) => d.status === 'active');
    const pagesConnected = countConnectedPages(
      allDestinations.map((d) => ({
        externalDestinationId: d.external_destination_id,
        status: d.status,
      }))
    );
    const aduRows = await fetchAll<AduRow>((offset) =>
      supabase
        .from('adu_configs')
        .select(
          'id, destination_id, workspace_id, status, starting_followers, current_followers, analytics_1d, analytics_7d, analytics_28d, analytics_locations, analytics_updated_at'
        )
        .eq('status', 'active')
        .in('workspace_id', workspaceIds)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1)
    );
    const mirrors = await fetchAll<MirrorRow>((offset) =>
      supabase
        .from('mirrors')
        .select(
          'id, workspace_id, target_platform, target_external_id, status, starting_followers, current_followers, analytics_1d, analytics_7d, analytics_28d, analytics_locations, analytics_updated_at'
        )
        .eq('target_platform', 'facebook')
        .eq('status', 'active')
        .in('workspace_id', workspaceIds)
        .order('id', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1)
    );

    // Dedup by Facebook page id, preferring the destinations copy.
    const destinationById = new Map(destinations.map((d) => [d.id, d]));
    const candidates = new Map<string, AnalyticsPageRecord[]>();
    const add = (fbPageId: string, record: AnalyticsPageRecord) => {
      const list = candidates.get(fbPageId);
      if (list) list.push(record);
      else candidates.set(fbPageId, [record]);
    };
    for (const dest of destinations) {
      if (!dest.external_destination_id) continue;
      add(dest.external_destination_id, {
        facebookPageId: dest.external_destination_id,
        workspaceId: dest.workspace_id,
        startingFollowers: finiteNumber(dest.metadata?.starting_followers),
        currentFollowers: finiteNumber(dest.metadata?.current_followers),
        analytics1d: dest.analytics_1d,
        analytics7d: dest.analytics_7d,
        analytics28d: dest.analytics_28d,
        analyticsLocations: dest.analytics_locations,
        analyticsUpdatedAt: metadataUpdatedAt(dest.metadata),
      });
    }
    for (const adu of aduRows) {
      const dest = destinationById.get(adu.destination_id);
      if (!dest?.external_destination_id) continue;
      add(dest.external_destination_id, {
        facebookPageId: dest.external_destination_id,
        workspaceId: adu.workspace_id,
        startingFollowers: finiteNumber(adu.starting_followers),
        currentFollowers: finiteNumber(adu.current_followers),
        analytics1d: adu.analytics_1d,
        analytics7d: adu.analytics_7d,
        analytics28d: adu.analytics_28d,
        analyticsLocations: adu.analytics_locations,
        analyticsUpdatedAt: adu.analytics_updated_at,
      });
    }
    for (const mirror of mirrors) {
      if (!mirror.target_external_id) continue;
      add(mirror.target_external_id, {
        facebookPageId: mirror.target_external_id,
        workspaceId: mirror.workspace_id,
        startingFollowers: finiteNumber(mirror.starting_followers),
        currentFollowers: finiteNumber(mirror.current_followers),
        analytics1d: mirror.analytics_1d,
        analytics7d: mirror.analytics_7d,
        analytics28d: mirror.analytics_28d,
        analyticsLocations: mirror.analytics_locations,
        analyticsUpdatedAt: mirror.analytics_updated_at,
      });
    }

    const records: AnalyticsPageRecord[] = [];
    for (const [fbPageId, rows] of candidates) {
      // Prefer the destinations copy; otherwise the row with stored
      // analytics; otherwise the first row (followers still count).
      const picked = pickCandidate(fbPageId, rows, destinations);
      // Listed set: 100+ stored followers, like the worker's fetch gate.
      const current = picked.currentFollowers;
      if (typeof current !== 'number' || current < 100) continue;
      // A stored column that does not parse is corruption: log it
      // loudly, contribute nothing for that column.
      const parsed = parseStoredAnalytics(picked);
      if (
        (picked.analytics1d != null && parsed.one === null) ||
        (picked.analytics7d != null && parsed.seven === null) ||
        (picked.analytics28d != null && parsed.twentyEight === null) ||
        (picked.analyticsLocations != null && parsed.locations === null)
      ) {
        logServerError('analytics: stored columns failed to parse', undefined, {
          source: 'analytics-route',
          fbPageId,
        });
      }
      records.push(picked);
    }

    const aggregate = aggregateAnalytics(records, period);
    const response = AnalyticsAggregateResponseSchema.safeParse({
      success: true,
      workspace,
      period,
      dateRangeLabel: formatDateRangeLabel(aggregate.chart.map((p) => p.date)),
      periodLabel: periodLabel(period),
      pagesIncluded: aggregate.pagesIncluded,
      pagesConnected,
      updatedAt: aggregate.updatedAt,
      followers: aggregate.followers,
      mediaViews: aggregate.mediaViews,
      uniqueViewers: aggregate.uniqueViewers,
      profileViews: aggregate.profileViews,
      engagement: aggregate.engagement,
      videoViews: aggregate.videoViews,
      videoCompleteViews30s: aggregate.videoCompleteViews30s,
      watchTimeMs: aggregate.watchTimeMs,
      totalActions: aggregate.totalActions,
      newFollows: aggregate.newFollows,
      unfollows: aggregate.unfollows,
      netFollows: aggregate.netFollows,
      chart: aggregate.chart,
      topCountries: aggregate.topCountries,
      topCities: aggregate.topCities,
      hasNoData: aggregate.hasNoData,
    });
    if (!response.success) {
      logServerError('analytics: aggregate failed contract validation', response.error, {
        source: 'analytics-route',
      });
      return NextResponse.json({ error: 'Analytics unavailable' }, { status: 500 });
    }
    return NextResponse.json(response.data, {
      headers: { 'Cache-Control': 'private, no-cache, no-store' },
    });
  } catch (err) {
    logServerError('analytics: read failed', err, { source: 'analytics-route' });
    return NextResponse.json({ error: 'Analytics unavailable' }, { status: 503 });
  }
}

/**
 * Prefer the destinations copy for a page; otherwise the row with
 * stored analytics; otherwise the first row (its followers still
 * count). The destinations copy is identified by its workspace —
 * the same page id in two workspaces is two different pages.
 */
function pickCandidate(
  fbPageId: string,
  rows: AnalyticsPageRecord[],
  destinations: DestinationRow[]
): AnalyticsPageRecord {
  const destRow = rows.find((r) =>
    destinations.some(
      (d) => d.external_destination_id === fbPageId && d.workspace_id === r.workspaceId
    )
  );
  if (destRow) return destRow;
  return rows.find((r) => hasStoredAnalytics(r)) ?? rows[0]!;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await params;
  return handleGetAnalytics(request, subdomain);
}
