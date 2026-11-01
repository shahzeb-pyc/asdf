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
import { logServerError } from '@/lib/server-analytics';
import {
  registerUsage,
  releaseUsageForFeature,
  SubscriptionGateError,
} from '@/lib/billing/entitlement';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
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
  userId: string;
  role: string;
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
  return {
    context: {
      workspaceId,
      supabase,
      userId: auth.session.userId,
      role: auth.session.role,
    },
  };
}

/**
 * Destination keys (external id, else the destination row id) for the
 * plan-cap gate on ADU adds, loaded in ONE query for the single and
 * bulk paths alike. Unknown ids are skipped here — createOne rejects
 * them per item downstream — so a stale id can never block a valid add.
 * Throws on a database error: the caller turns it into a 500, never a
 * silent pass.
 */
export async function aduDestinationKeysForCap(
  supabase: SupabaseClient,
  workspaceId: string,
  platform: 'facebook' | 'instagram' | 'threads',
  destinationIds: string[]
): Promise<string[]> {
  const ids = [...new Set(destinationIds)];
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from('destinations')
    .select('id, external_destination_id')
    .eq('workspace_id', workspaceId)
    .eq('platform', platform)
    .in('id', ids);
  if (error) {
    throw new Error(`ADU cap key lookup failed: ${error.message}`);
  }
  // Error is thrown above, so data is the row array here by the
  // client's types; a null here would throw loudly in the caller.
  return data.map((row) => {
    const typed = row as { id: string; external_destination_id?: string | null };
    return typed.external_destination_id ?? typed.id;
  });
}

/**
 * Cap at add, second half (audit fix 2026-11-01): after an ADU
 * config row is created, register its destination in the usage
 * registry, so the cap counts worker-driven features from the
 * moment they are added — not only when they first queue. The
 * add-gate (assertFeatureAddWithinCap) only CHECKS; this WRITES.
 * Admins never register. A missing billing client skips with a
 * loud log (the same skip rule as the gate). On ANY registration
 * failure the just-created config is deleted again, so a config
 * can never exist without its cap unit: the caller reports the
 * returned error for that item instead of a success.
 */
export async function registerAduConfigUsage(
  ctx: AduContext,
  platform: 'facebook' | 'instagram',
  destinationId: string,
  configId: string
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  if (ctx.role === 'admin') return { ok: true };
  const billingClient = getBillingAdminClient();
  if (!billingClient) {
    logServerError('[billing] ADU usage registration skipped: no billing client', null, {
      source: 'billing',
      platform,
    });
    return { ok: true };
  }
  const rollback = async (): Promise<void> => {
    await ctx.supabase.from('adu_configs').delete().eq('id', configId);
  };
  try {
    const keys = await aduDestinationKeysForCap(
      billingClient,
      ctx.workspaceId,
      platform,
      [destinationId]
    );
    const key = keys[0];
    if (!key) {
      throw new Error('ADU cap key lookup returned no key for the destination.');
    }
    await registerUsage(
      billingClient,
      ctx.userId,
      platform,
      key,
      'auto-download-upload',
      destinationId
    );
    return { ok: true };
  } catch (err) {
    // Roll back the config: without its unit, the config must not
    // exist. A rollback failure is logged loudly — the config row
    // surviving unregistered is a cap leak the admin must see.
    try {
      await rollback();
    } catch (rollbackError) {
      logServerError('[billing] ADU config rollback after usage failure failed', rollbackError, {
        source: 'billing',
        configId,
      });
    }
    if (err instanceof SubscriptionGateError) {
      return { ok: false, error: err };
    }
    logServerError('[billing] ADU usage registration failed', err, {
      source: 'billing',
      platform,
    });
    return { ok: false, error: err };
  }
}

/**
 * Cap-at-add release (audit fix 2026-11-01): deleting an ADU config
 * frees its unit — but only when the registry row still carries the
 * ADU feature (see releaseUsageForFeature: a destination first
 * registered by queueing keeps its row). Admins never registered,
 * so they never release. A missing billing client or a release
 * failure is logged loudly and swallowed: the config is already
 * deleted by then, and failing the delete response over it would
 * be worse than a visible unit leak the admin can see in logs.
 */
export async function releaseAduConfigUsage(
  ctx: AduContext,
  platform: 'facebook' | 'instagram',
  destinationId: string
): Promise<void> {
  if (ctx.role === 'admin') return;
  const billingClient = getBillingAdminClient();
  if (!billingClient) {
    logServerError('[billing] ADU usage release skipped: no billing client', null, {
      source: 'billing',
      platform,
    });
    return;
  }
  try {
    const keys = await aduDestinationKeysForCap(
      billingClient,
      ctx.workspaceId,
      platform,
      [destinationId]
    );
    const key = keys[0] ?? destinationId;
    await releaseUsageForFeature(
      billingClient,
      ctx.userId,
      platform,
      key,
      'auto-download-upload'
    );
  } catch (err) {
    logServerError('[billing] ADU usage release failed', err, {
      source: 'billing',
      platform,
    });
  }
}

export function aduMissingTable(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42P01';
}

/**
 * True when an ADU RPC/table is missing because its migration was never
 * applied. PostgREST reports a missing RPC as PGRST202 ("Could not find
 * the function"), NOT Postgres 42883 — a route that only checks 42P01 /
 * 42883 turns an unapplied ADU migration into a bare "Failed to load
 * pages." instead of the migration-missing banner that names the fix.
 */
export function aduRpcMissing(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42P01' || error?.code === '42883' || error?.code === 'PGRST202';
}

export interface AduOptionsLists {
  accounts: Array<Record<string, unknown>>;
  pages: Array<Record<string, unknown>>;
  configured: Array<Record<string, unknown>>;
  migrationMissing: boolean;
}

interface PageResult<T> {
  data: T[] | null;
  error: { message?: string; code?: string } | null;
}

/**
 * PostgREST silently truncates an unbounded select at 1,000 rows, so a
 * picker that loads "all" accounts/pages/configs drops rows past 1,000
 * with no error. Range pages (deterministic order, 1,000/page) keep
 * every row reachable at any workspace size.
 */
async function selectAllPages<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<{ rows: T[]; error: PageResult<T>['error'] }> {
  const rows: T[] = [];
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) return { rows, error };
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return { rows, error: null };
  }
}

/**
 * Accounts + managed Facebook pages + already-configured ADU rows for
 * the Add Page picker. Throws on any fatal load failure (the route
 * turns it into a 500) — a transient database error must never render
 * as an empty picker that invites duplicate configs. A missing
 * adu_configs table is NOT fatal: the picker still shows accounts and
 * pages, flagged with migrationMissing, so the UI can say why adding
 * is unavailable instead of failing the whole picker.
 */
export async function loadAduOptionsLists(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<AduOptionsLists> {
  const accounts = await selectAllPages<Record<string, unknown>>((from, to) =>
    supabase
      .from('social_accounts')
      .select('id, external_account_id, display_name, avatar_url, status')
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .order('display_name')
      .range(from, to),
  );
  if (accounts.error) {
    throw new Error(accounts.error.message ?? 'Could not load Facebook accounts.');
  }
  const pages = await selectAllPages<Record<string, unknown>>((from, to) =>
    supabase
      .from('destinations')
      .select('id, account_id, external_destination_id, name, avatar_url, status, metadata')
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .order('name')
      .range(from, to),
  );
  if (pages.error) {
    throw new Error(pages.error.message ?? 'Could not load Facebook pages.');
  }
  const configured = await selectAllPages<Record<string, unknown>>((from, to) =>
    supabase
      .from('adu_configs')
      .select('destination_id, source_platform, source_username')
      .eq('workspace_id', workspaceId)
      .order('destination_id')
      .range(from, to),
  );
  if (configured.error) {
    if (aduMissingTable(configured.error)) {
      return {
        accounts: accounts.rows,
        pages: pages.rows,
        configured: [],
        migrationMissing: true,
      };
    }
    throw new Error(configured.error.message ?? 'Could not load configured pages.');
  }
  return {
    accounts: accounts.rows,
    pages: pages.rows,
    configured: configured.rows,
    migrationMissing: false,
  };
}

export interface AduConfigView {
  id: string;
  destinationId: string;
  destinationName: string;
  destinationExternalId: string;
  destinationAvatarUrl: string | null;
  destinationHandle: string | null;
  destinationPlatform: string | null;
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
  handle: string | null;
  platform: string | null;
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
    .select('id, name, external_destination_id, avatar_url, status, account_id, handle, platform, social_accounts(display_name, avatar_url)')
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
    destinationName:
      dest?.name ?? config.display_name ??
      (dest?.platform === 'instagram' ? 'Instagram account' : 'Facebook Page'),
    destinationExternalId: dest?.external_destination_id ?? '',
    destinationAvatarUrl: dest?.avatar_url ?? null,
    destinationHandle: dest?.handle ?? null,
    destinationPlatform: dest?.platform ?? null,
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

/**
 * Instagram-route guard: true only when the config belongs to the
 * workspace AND its destination platform is instagram. Instagram
 * routes return 404 for any other config, so a Facebook ADU config
 * can never be read or mutated through the Instagram routes (and
 * vice versa for the Facebook routes, which never see IG configs
 * because their picker/list are Facebook-filtered).
 */
export async function isInstagramAduConfig(
  supabase: SupabaseClient,
  workspaceId: string,
  configId: string
): Promise<boolean> {
  const { data: config } = await supabase
    .from('adu_configs')
    .select('destination_id')
    .eq('workspace_id', workspaceId)
    .eq('id', configId)
    .maybeSingle();
  const destinationId = (config as { destination_id?: string } | null)?.destination_id;
  if (!destinationId) return false;
  const { data: destination } = await supabase
    .from('destinations')
    .select('platform')
    .eq('id', destinationId)
    .maybeSingle();
  return (destination as { platform?: string } | null)?.platform === 'instagram';
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
