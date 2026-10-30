import { type NextRequest, NextResponse } from 'next/server';
import {
  aduDisplayStatus,
  aduSourceLink,
  aduStatusAlert,
  sanitizeSourceIdentity,
  type AduConfigRow,
  type AduSourcePlatform,
} from '@fbuploadpro/contracts';
import { authenticateTenantRoute, getRouteSupabase } from '@/lib/route-auth';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * ADU server helpers. All ADU routes use the tenant session (fbup_session
 * cookie) + workspace resolution, then the service-role Supabase client:
 * the ADU tables have RLS enabled with no permissive policies, exactly
 * like idempotency_keys, so only this server path reaches them.
 */

export interface AduContext {
  workspaceId: string;
  supabase: SupabaseClient;
}

export async function aduContext(
  request: NextRequest,
  subdomain: string
): Promise<{ context: AduContext } | { errorResponse: NextResponse }> {
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return { errorResponse: auth.errorResponse };
  const supabase = getRouteSupabase(getSupabaseAdminClient() ?? undefined);
  if (!supabase) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Database unavailable' },
        { status: 503 }
      ),
    };
  }
  const workspaceId = await resolveTenantWorkspaceId(
    supabase as SupabaseClient,
    subdomain,
    auth.session.userId,
    auth.session.role
  );
  if (!workspaceId) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Workspace not found' },
        { status: 404 }
      ),
    };
  }
  return { context: { workspaceId, supabase } };
}

export function aduMissingTable(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42P01';
}

export interface AduConfigView {
  id: string;
  destinationId: string;
  destinationName: string;
  destinationExternalId: string;
  destinationAvatarUrl: string | null;
  destinationStatus: string;
  accountName: string | null;
  accountAvatarUrl: string | null;
  sourcePlatform: AduSourcePlatform;
  sourceUsername: string;
  sourceLink: string;
  sourceIdentity: string;
  timezone: string;
  postsPerDay: number;
  scheduleType: 'dailyrandom' | 'fixed';
  postingTimes: string[];
  status: AduConfigRow['status'];
  syncStatus: AduConfigRow['sync_status'];
  displayStatus: string;
  alert: string | null;
  followersCount: number;
  followersGained: number;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
  postedCount: number;
  pendingCount: number;
  failedCount: number;
  postedToday: number;
  pendingToday: number;
  failedToday: number;
}

interface DestinationJoin {
  id: string;
  name: string;
  external_destination_id: string;
  avatar_url: string | null;
  status: string;
  account_id: string;
  social_accounts?: { display_name: string; avatar_url: string | null } | null;
}

function startOfDayInTimezone(timezone: string): Date {
  // Page-local midnight, approximated from the current local date in
  // that timezone. A full tz database is not available here; the
  // Intl-based date parts give the local calendar date, and midnight
  // is taken in UTC for the 48h-window count the old app used.
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timezone,
    }).formatToParts(new Date());
    const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
    const month = parts.find((p) => p.type === 'month')?.value ?? '01';
    const day = parts.find((p) => p.type === 'day')?.value ?? '01';
    return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  } catch {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}

export async function loadAduConfigView(
  supabase: SupabaseClient,
  workspaceId: string,
  configId: string
): Promise<AduConfigView | null> {
  const { data: config, error } = await supabase
    .from('adu_configs')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', configId)
    .maybeSingle();
  if (error || !config) return null;
  return buildAduConfigView(supabase, config as AduConfigRow);
}

export async function buildAduConfigView(
  supabase: SupabaseClient,
  config: AduConfigRow
): Promise<AduConfigView> {
  const { data: destination } = await supabase
    .from('destinations')
    .select('id, name, external_destination_id, avatar_url, status, account_id, social_accounts(display_name, avatar_url)')
    .eq('id', config.destination_id)
    .maybeSingle();
  const dest = destination as DestinationJoin | null;
  // Bounded counts only: the old code loaded every reel and every job
  // for a config and counted in memory, which silently truncates past
  // PostgREST's 1,000-row limit. Count queries return a number, never
  // rows, and the jobs table is retention-pruned (see adu-tick.ts).
  // A count-query failure is logged server-side (code only, no data)
  // and counted as 0 for this render — a read fallback, never a
  // fabricated persist.
  const failedStatuses = ['failed_to_publish', 'publish_error', 'integrity_error'];
  const midnight = startOfDayInTimezone(config.timezone).toISOString();
  async function countRows(
    table: 'adu_reels' | 'adu_posting_jobs',
    status: string | string[],
    since?: string,
  ): Promise<number> {
    let query = supabase
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('config_id', config.id);
    query = Array.isArray(status) ? query.in('status', status) : query.eq('status', status);
    if (since) query = query.gte('created_at', since);
    const { count, error } = await query;
    if (error) {
      console.error(`ADU count failed: table=${table} code=${error.code ?? 'unknown'}`);
      return 0;
    }
    return count ?? 0;
  }
  const pendingCount = await countRows('adu_reels', 'downloaded');
  const postedCount = await countRows('adu_posting_jobs', 'published');
  const failedCount = await countRows('adu_posting_jobs', failedStatuses);
  const postedToday = await countRows('adu_posting_jobs', 'published', midnight);
  const failedToday = await countRows('adu_posting_jobs', failedStatuses, midnight);
  return {
    id: config.id,
    destinationId: config.destination_id,
    destinationName: dest?.name ?? config.display_name ?? 'Facebook Page',
    destinationExternalId: dest?.external_destination_id ?? '',
    destinationAvatarUrl: dest?.avatar_url ?? null,
    destinationStatus: dest?.status ?? 'active',
    accountName: dest?.social_accounts?.display_name ?? null,
    accountAvatarUrl: dest?.social_accounts?.avatar_url ?? null,
    sourcePlatform: config.source_platform,
    sourceUsername: config.source_username,
    sourceLink: aduSourceLink(config.source_platform, config.source_username),
    sourceIdentity:
      config.source_platform === 'facebook'
        ? config.source_username
        : `@${config.source_username}`,
    timezone: config.timezone,
    postsPerDay: config.posts_per_day,
    scheduleType: config.schedule_type,
    postingTimes: config.posting_times ?? [],
    status: config.status,
    syncStatus: config.sync_status,
    displayStatus: aduDisplayStatus(config.status, config.sync_status),
    alert: aduStatusAlert(config.status, config.sync_status),
    followersCount: config.followers_count,
    followersGained: config.followers_gained,
    displayName: config.display_name,
    createdAt: config.created_at,
    updatedAt: config.updated_at,
    postedCount,
    pendingCount,
    failedCount,
    postedToday,
    pendingToday: Math.max(0, config.posts_per_day - postedToday),
    failedToday,
  };
}

export function sanitizeAduSource(
  platform: AduSourcePlatform,
  raw: string
): string {
  return sanitizeSourceIdentity(platform, raw);
}

// --- Discovery + download: NOT in the web app -----------------------
//
// Discovery and download live in the VPS services apps/adu-scraper
// (yt-dlp + Puppeteer) and apps/adu-downloader (yt-dlp + aria2 + R2),
// exactly like the old fbuploadpro. They cannot run in Vercel
// serverless or the Cloudflare Worker (no yt-dlp binary, no
// persistent logged-in browser profile), so the web app deliberately
// contains NO discovery/download code at all — no feed API, no
// third-party download API. The web app's only discovery-related
// action is re-queueing a config (sync_status -> 'pending') for the
// scraper service to claim on its next loop; the downloader claims
// pending reels itself. If the VPS services are not running, a
// config stays 'pending' and the UI shows "Scrape pending" — loud,
// never a fake success.
