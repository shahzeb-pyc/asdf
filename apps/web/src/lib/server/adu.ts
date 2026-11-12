import { type NextRequest, NextResponse } from 'next/server';
import {
  aduDisplayStatus,
  aduSourceLink,
  aduStatusAlert,
  instagramAduStatusAlert,
  threadsAduStatusAlert,
  decryptToken,
  encryptToken,
  fetchAllFacebookPages,
  getTokenEncryptionKey,
  sanitizeSourceIdentity,
  type AduConfigRow,
  type AduSourcePlatform,
} from '@fbuploadpro/contracts';
import { authenticateTenantRoute, getRouteSupabase } from '@/lib/route-auth';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import {
  isTokenDeadGraphStatus,
  markAccountConnectionError,
} from '@/lib/connect/account-probe';
import { resolveWorkspaceIdFromSession } from '@/lib/server/workspace-resolver';
import { logServerError } from '@/lib/server-analytics';
import {
  registerUsage,
  releaseUsageForFeature,
  SubscriptionGateError,
  type Entitlement,
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
  const workspaceId = await resolveWorkspaceIdFromSession(
    auth.session,
    subdomain,
    supabase as SupabaseClient,
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
    .eq('section', 'adu')
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
 *
 * The optional `sharedEntitlement` is a read the caller already
 * made for this user in this request (plan-check R3): it is passed
 * straight through to registerUsage so the register does not pay
 * for a second full entitlement read. Absent, registerUsage reads
 * on its own, as before.
 */
export async function registerAduConfigUsage(
  ctx: AduContext,
  platform: 'facebook' | 'instagram' | 'threads',
  destinationId: string,
  configId: string,
  sharedEntitlement?: Entitlement
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
      destinationId,
      undefined,
      sharedEntitlement
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
  platform: 'facebook' | 'instagram' | 'threads',
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
      .eq('section', 'adu')
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

export interface AduDiscoveredGraphPage {
  fbPageId: string;
  pageName: string;
  category: string | null;
  tasks: string[];
  followers: number;
  profilePictureUrl: string | null;
  accessToken: string | null;
}

/**
 * Re-discovers one account's Facebook pages server-side, exactly like
 * the Pages picker's discover route: the account token is decrypted
 * here and Graph `/me/accounts` is queried with it. The client must
 * never be trusted with a page token — submit re-proves the page
 * belongs to the account and holds its token, so a forged fbPageId
 * cannot attach an arbitrary page to this workspace.
 */
export async function fetchAduAccountDiscoveredPages(
  supabase: SupabaseClient,
  workspaceId: string,
  accountId: string,
): Promise<
  | { ok: true; pages: AduDiscoveredGraphPage[] }
  | { ok: false; error: string }
> {
  const { data: account, error: accountError } = await supabase
    .from('social_accounts')
    .select('encrypted_access_token')
    .eq('id', accountId)
    .eq('workspace_id', workspaceId)
    .eq('platform', 'facebook')
    .maybeSingle();
  if (accountError || !account) {
    return { ok: false, error: 'Facebook account not found.' };
  }
  const encryptedToken = (account as { encrypted_access_token?: string | null })
    .encrypted_access_token;
  if (!encryptedToken) {
    return { ok: false, error: 'Failed to decrypt account credentials.' };
  }
  let rawToken: string;
  try {
    rawToken = await decryptToken(encryptedToken, getTokenEncryptionKey());
  } catch (err) {
    logServerError('[adu] Failed to decrypt account credentials', err, {
      source: 'adu-discover',
    });
    return { ok: false, error: 'Failed to decrypt account credentials.' };
  }
  let fetched: Awaited<ReturnType<typeof fetchAllFacebookPages>>;
  try {
    fetched = await fetchAllFacebookPages(
      rawToken,
      'id,name,category,tasks,access_token,followers_count,picture{url}',
    );
  } catch (err: unknown) {
    logServerError('[adu] Facebook Graph query failed', err, {
      source: 'adu-discover',
    });
    const status =
      err !== null &&
      typeof err === 'object' &&
      'status' in err &&
      typeof (err as { status: unknown }).status === 'number'
        ? (err as { status: number }).status
        : undefined;
    // Discover is the probe (same rule as the Pages routes): an
    // auth-class failure means the user token is dead, so the
    // account is marked 'error' now instead of reading
    // "Connected" until a publish fails.
    if (isTokenDeadGraphStatus(status)) {
      await markAccountConnectionError(supabase, workspaceId, accountId);
    }
    return { ok: false, error: 'Failed to query Facebook Graph API.' };
  }
  return {
    ok: true,
    pages: fetched.pages.map((item) => ({
      fbPageId: String(item.id),
      pageName: String(item.name ?? ''),
      category: item.category ?? null,
      tasks: Array.isArray(item.tasks) ? item.tasks : [],
      followers:
        typeof item.followers_count === 'number'
          ? Math.max(0, item.followers_count)
          : 0,
      profilePictureUrl: item.picture?.data?.url ?? null,
      accessToken: item.access_token ?? null,
    })),
  };
}

/**
 * Ensures the `destinations` row for a discovered page, exactly like
 * Pages import does: upsert on (`account_id`,
 * `external_destination_id`), reusing the existing row when present.
 * The per-page `access_token` from Graph is stored encrypted — ADU
 * publishing reads `destinations.encrypted_destination_token` and
 * fails permanently without it, so a page without a token is refused
 * here, never imported tokenless. A paused row (disconnected +
 * `fb_status='paused'`) keeps its status, marker, and follower
 * baseline; any other pre-existing row keeps its starting-followers
 * baseline. Nothing about any other page's or account's row is
 * touched: a second row for the same page under another account is
 * legitimate and separate.
 */
export async function ensureAduDestination(
  supabase: SupabaseClient,
  workspaceId: string,
  accountId: string,
  page: AduDiscoveredGraphPage,
): Promise<{ ok: true; destinationId: string } | { ok: false; error: string }> {
  if (!page.accessToken) {
    return {
      ok: false,
      error: `This page did not return a page token from Facebook and was not added: ${page.fbPageId}.`,
    };
  }
  let encryptedPageToken: string;
  try {
    encryptedPageToken = await encryptToken(page.accessToken, getTokenEncryptionKey());
  } catch (err) {
    logServerError('[adu] Failed to encrypt page token', err, {
      source: 'adu-ensure-destination',
    });
    return { ok: false, error: 'Failed to save the page credentials.' };
  }
  const { data: existing, error: existingError } = await supabase
    .from('destinations')
    .select('id, status, metadata')
    .eq('workspace_id', workspaceId)
    .eq('account_id', accountId)
    .eq('platform', 'facebook')
    .eq('section', 'adu')
    .eq('external_destination_id', page.fbPageId)
    .maybeSingle();
  if (existingError) {
    logServerError('[adu] Failed to load existing destination', existingError, {
      source: 'adu-ensure-destination',
    });
    return { ok: false, error: 'Could not add this page. Please try again.' };
  }
  const existingMetadata = ((existing?.metadata ?? {}) as Record<string, unknown>);
  const paused =
    existing?.status === 'disconnected' && existingMetadata.fb_status === 'paused';
  const preserveBaseline =
    existing != null &&
    (existing.status !== 'disconnected' || paused) &&
    typeof existingMetadata.starting_followers === 'number';
  const startingFollowers = preserveBaseline
    ? (existingMetadata.starting_followers as number)
    : page.followers;
  const nextMetadata: Record<string, unknown> = {
    ...existingMetadata,
    category: page.category,
    tasks: page.tasks,
    starting_followers: startingFollowers,
    current_followers: page.followers,
    // Spec 162: the import writes the current total, so it stamps
    // the last-updated time too — the Pages "last updated" display
    // reads this key.
    followers_updated_at: new Date().toISOString(),
  };
  if (!paused) {
    delete nextMetadata.fb_status;
  }
  const { data: upserted, error: upsertError } = await supabase
    .from('destinations')
    .upsert(
      {
        workspace_id: workspaceId,
        account_id: accountId,
        platform: 'facebook',
        section: 'adu',
        external_destination_id: page.fbPageId,
        name: page.pageName,
        avatar_url: page.profilePictureUrl,
        encrypted_destination_token: encryptedPageToken,
        status: paused ? 'disconnected' : 'active',
        metadata: nextMetadata,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id,external_destination_id,section' },
    )
    .select('id')
    .single();
  if (upsertError || !upserted) {
    logServerError('[adu] Failed to upsert destination', upsertError, {
      source: 'adu-ensure-destination',
    });
    return { ok: false, error: 'Could not add this page. Please try again.' };
  }
  return { ok: true, destinationId: upserted.id as string };
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
  /** Last successful follower check (daily worker or ADU creation); null when never checked. Spec 162. */
  followersUpdatedAt: string | null;
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
    .eq('section', 'adu')
    .maybeSingle();
  const dest = destination as DestinationJoin | null;
  // Bounded counts only: the old code loaded every reel and every job
  // for a config and counted in memory, which silently truncates past
  // PostgREST's 1,000-row limit. Count queries return a number, never
  // rows, and the jobs table is retention-pruned (see adu-tick.ts).
  // A count-query failure is logged server-side (code only, no data)
  // and counted as 0 for this render — a read fallback, never a
  // fabricated persist.
  // Pending = reels still in the pipeline (pending, processing,
  // downloaded) minus failed jobs whose reel is STILL in the
  // pipeline. A terminally-failed reel leaves the pipeline (status
  // 'failed', written by the tick on settlement), so its job must not
  // be subtracted again — the reel leaving the pipeline already
  // removed it from the count. Only the crash window (job settled,
  // reel update not yet applied) still subtracts, via the
  // embedded-reel filtered count below. The max(0, ...) floor guards
  // only against that invariant ever breaking (a duplicate job for
  // one reel), never against a miscount: both terms are exact count
  // queries, never rows.
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
  const inPipelineCount = await countRows('adu_reels', ['pending', 'processing', 'downloaded']);
  const postedCount = await countRows('adu_posting_jobs', 'published');
  const failedCount = await countRows('adu_posting_jobs', failedStatuses);
  // Failed jobs whose reel is still in the pipeline (the crash window
  // between the job settling and the reel going 'failed'). The !inner
  // join keeps only jobs whose reel is in a pipeline status, so a
  // failed job whose reel already left the pipeline is not subtracted
  // a second time. Verified against the supabase-js query builder:
  // select=id,adu_reels!inner(status) with adu_reels.status=in.(...).
  // A failure here falls back to 0 (logged, same read-fallback rule
  // as countRows) — pending then counts the stranded reel, the safe
  // pre-fix direction.
  const { count: failedInPipelineCount, error: failedInPipelineError } = await supabase
    .from('adu_posting_jobs')
    .select('id, adu_reels!inner(status)', { count: 'exact', head: true })
    .eq('config_id', config.id)
    .in('status', failedStatuses)
    .in('adu_reels.status', ['pending', 'processing', 'downloaded']);
  let failedInPipeline = 0;
  if (failedInPipelineError) {
    console.error(
      `ADU count failed: table=adu_posting_jobs code=${failedInPipelineError.code ?? 'unknown'}`,
    );
  } else {
    failedInPipeline = failedInPipelineCount ?? 0;
  }
  const pendingCount = Math.max(0, inPipelineCount - failedInPipeline);
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
    // Alert wording follows the destination platform: the Facebook
    // alert names Facebook Accounts / Business Manager, which would
    // leak the wrong platform into the Instagram and Threads sections.
    // (Threads re-overrides this below in loadThreadsAduConfigView;
    // the same wording is selected here so every caller agrees.)
    alert:
      dest?.platform === 'instagram'
        ? instagramAduStatusAlert(config.status, config.sync_status)
        : dest?.platform === 'threads'
          ? threadsAduStatusAlert(config.status, config.sync_status)
          : aduStatusAlert(config.status, config.sync_status),
    followersCount: config.starting_followers,
    followersGained: config.current_followers,
    // Spec 162: the last successful follower check. A caller that
    // selects explicit columns without followers_updated_at passes
    // undefined here — that reads as null, never a faked time.
    followersUpdatedAt:
      typeof config.followers_updated_at === 'string'
        ? config.followers_updated_at
        : null,
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
