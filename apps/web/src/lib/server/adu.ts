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
  AduConfigCountsSchema,
  AduHubListRowSchema,
  AduHubStatsRowSchema,
  type AduConfigCounts,
  type AduConfigRow,
  type AduHubListRow,
  type AduHubStatsRow,
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
 * Deliberately NO section filter (spec 174 1B): the key is the
 * external id, which is identical on every section copy of the same
 * page, and the pre-create gate looks the picked row up BEFORE its
 * adu copy exists — a section filter would return no key and fail
 * the add. The callers already pass ADU-copy ids (register) or the
 * picked row whose copy shares the external id (gate).
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
 * Cap keys for an account-sourced ADU add (spec 174 2A): the IG/Threads
 * Add dialog posts account ids, and the cap key is the account's
 * external id — the same key the adu copy the add creates carries.
 * Deliberately NO destinations lookup: the add's import creates the
 * adu copy from the account, and the copy may not exist yet when the
 * pre-create gate runs. Throws on a database error: the caller turns
 * it into a 500, never a silent pass.
 */
export async function aduAccountKeysForCap(
  supabase: SupabaseClient,
  workspaceId: string,
  platform: 'instagram' | 'threads',
  accountIds: string[]
): Promise<string[]> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from('social_accounts')
    .select('id, external_account_id')
    .eq('workspace_id', workspaceId)
    .eq('platform', platform)
    .in('id', ids);
  if (error) {
    throw new Error(`ADU cap key lookup failed: ${error.message}`);
  }
  return (data ?? []).map((row) => {
    const typed = row as { id: string; external_account_id?: string | null };
    return typed.external_account_id ?? typed.id;
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

/**
 * Hub list/stats rows from the unified `adu_hub_list` / `adu_hub_stats`
 * (F21): validated against the contracts schemas at this boundary —
 * a shape change fails loud, never renders as a wrong hub. Returns
 * null on the first invalid row (the caller logs and turns it into a
 * 500 for the list, or into a stats failure for stats). A stats RPC
 * always returns exactly one row; zero rows is a failure, not zeros.
 */
export function parseAduHubListRows(rows: unknown): AduHubListRow[] | null {
  if (!Array.isArray(rows)) return null;
  const parsed: AduHubListRow[] = [];
  for (const row of rows) {
    const result = AduHubListRowSchema.safeParse(row);
    if (!result.success) return null;
    parsed.push(result.data);
  }
  return parsed;
}

export function parseAduHubStatsRow(rows: unknown): AduHubStatsRow | null {
  const row = (rows as Array<unknown> | null)?.[0];
  if (row === undefined) return null;
  const result = AduHubStatsRowSchema.safeParse(row);
  return result.success ? result.data : null;
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

/**
 * The Instagram/Threads copy of `ensureAduDestination` (spec 174 1B).
 *
 * For Facebook the picker lists live pages and the adu row is created
 * from the discovery; for Instagram/Threads the destination IS the
 * account, so the add dialog hands over an existing destination row
 * (the connected row, or another section's copy) as the identity
 * source. The import creates the section's OWN copy — it never
 * adopts or mutates the source row, so adding the same account to
 * Schedule, Auto Download and Publish Now each holds a separate row
 * and no section can steal another's.
 *
 * Load-first: when the adu copy already exists it is refreshed with
 * the source's identity (name/avatar/followers) and returned; its
 * status is never touched here, so a paused/disconnected copy is
 * never silently reactivated by a re-add. The insert runs only when
 * no copy exists; a concurrent insert (23505) falls back to loading
 * the copy the other call created. Identity-only: no token is ever
 * copied — for Instagram/Threads the publishing token lives on the
 * account row and is read from there.
 */
export async function ensureAduDestinationCopy(
  supabase: SupabaseClient,
  workspaceId: string,
  platform: 'instagram' | 'threads',
  source: {
    account_id: string;
    external_destination_id: string;
    name: string;
    avatar_url: string | null;
    metadata: Record<string, unknown> | null;
  }
): Promise<{ ok: true; destinationId: string; metadata: Record<string, unknown> | null } | { ok: false; error: string }> {
  const { data: existing, error: existingError } = await supabase
    .from('destinations')
    .select('id, avatar_url, metadata')
    .eq('workspace_id', workspaceId)
    .eq('account_id', source.account_id)
    .eq('platform', platform)
    .eq('section', 'adu')
    .eq('external_destination_id', source.external_destination_id)
    .maybeSingle();
  if (existingError) {
    logServerError('[adu] Failed to load existing adu destination', existingError, {
      source: 'adu-ensure-copy',
    });
    return { ok: false, error: 'Could not add this account. Please try again.' };
  }
  if (existing) {
    // A null source metadata keeps the copy's own metadata (spec 174
    // 2A: the ADU add sources the account row, which carries no
    // metadata — refreshing with {} would wipe the copy's follower
    // baseline the insights worker maintains). A provided source
    // metadata replaces it, as before.
    const existingMetadata = (existing as { metadata?: Record<string, unknown> | null }).metadata ?? {};
    const nextMetadata = source.metadata ?? existingMetadata;
    const { error: refreshError } = await supabase
      .from('destinations')
      .update({
        name: source.name,
        avatar_url: source.avatar_url,
        metadata: nextMetadata,
        updated_at: new Date().toISOString(),
      })
      .eq('id', (existing as { id: string }).id);
    if (refreshError) {
      logServerError('[adu] Failed to refresh adu destination', refreshError, {
        source: 'adu-ensure-copy',
      });
      return { ok: false, error: 'Could not add this account. Please try again.' };
    }
    return {
      ok: true,
      destinationId: (existing as { id: string }).id,
      metadata: nextMetadata,
    };
  }
  const { data: inserted, error: insertError } = await supabase
    .from('destinations')
    .insert({
      workspace_id: workspaceId,
      account_id: source.account_id,
      platform,
      section: 'adu',
      external_destination_id: source.external_destination_id,
      name: source.name,
      avatar_url: source.avatar_url,
      status: 'active',
      metadata: source.metadata ?? {},
    })
    .select('id, avatar_url, metadata')
    .single();
  if (insertError && insertError.code === '23505') {
    const { data: raced, error: racedError } = await supabase
      .from('destinations')
      .select('id, avatar_url, metadata')
      .eq('workspace_id', workspaceId)
      .eq('account_id', source.account_id)
      .eq('platform', platform)
      .eq('section', 'adu')
      .eq('external_destination_id', source.external_destination_id)
      .maybeSingle();
    if (racedError || !raced) {
      logServerError('[adu] Failed to load raced adu destination', racedError, {
        source: 'adu-ensure-copy',
      });
      return { ok: false, error: 'Could not add this account. Please try again.' };
    }
    return {
      ok: true,
      destinationId: (raced as { id: string }).id,
      metadata: ((raced as { metadata?: Record<string, unknown> | null }).metadata ?? null),
    };
  }
  if (insertError || !inserted) {
    logServerError('[adu] Failed to insert adu destination', insertError, {
      source: 'adu-ensure-copy',
    });
    return { ok: false, error: 'Could not add this account. Please try again.' };
  }
  return {
    ok: true,
    destinationId: (inserted as { id: string }).id,
    metadata: ((inserted as { metadata?: Record<string, unknown> | null }).metadata ?? null),
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
    // A bad timezone used to fall back to UTC midnight silently, so
    // the detail-view counts used the wrong day window with no trace.
    // Log loudly (bad value); the fallback itself is unchanged.
    console.error(
      `[adu] startOfDayInTimezone: invalid timezone ${JSON.stringify(timezone)} — falling back to UTC midnight`,
    );
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

/**
 * Hub-only view (adu-opt-a F7): the hub card renders a subset of the
 * full view — `accountName` is the only account field it reads, and
 * it never renders `scheduleType`, `postingTimes`, `syncStatus`,
 * `alert`, `displayName`, `updatedAt`, `destinationHandle`,
 * `destinationPlatform`, `accountAvatarUrl` or `destinationStatus`
 * (verified against `AduPageCard` + the list code in
 * `adu-hub-page.tsx`, the list route's only consumer). The detail
 * page, the Instagram hub and Threads detail keep the full shape;
 * only the Facebook list GET builds hub views.
 */
export type AduHubConfigView = Omit<
  AduConfigView,
  | 'scheduleType'
  | 'postingTimes'
  | 'syncStatus'
  | 'alert'
  | 'displayName'
  | 'updatedAt'
  | 'destinationHandle'
  | 'destinationPlatform'
  | 'accountAvatarUrl'
  | 'destinationStatus'
>;

const ZERO_ADU_COUNTS: AduConfigCounts = {
  config_id: '',
  in_pipeline: 0,
  published: 0,
  failed: 0,
  failed_in_pipeline: 0,
  published_today: 0,
  failed_today: 0,
};

const ADU_FAILED_JOB_STATUSES = ['failed_to_publish', 'publish_error', 'integrity_error'];
const ADU_PIPELINE_REEL_STATUSES = ['pending', 'processing', 'downloaded'];

/**
 * Grouped counts for a page of configs (ADU optimization F1): ONE
 * `adu_config_counts` RPC call returns all six counts per config,
 * instead of six exact-count queries per config. Rows are validated
 * against `AduConfigCountsSchema` at this boundary — a shape change
 * fails loud, never renders as wrong numbers.
 *
 * RPC missing (PGRST202 / 42883 / 42P01 = the migration has not been
 * applied yet, e.g. a branch preview running against a DB without it):
 * log loudly and fall back to the legacy per-config count queries for
 * this request only. Any other RPC error throws (the caller turns it
 * into a 500, never silent zeros). A config id absent from the RPC
 * result is logged loudly and counted as 0 for this render (read
 * fallback, same rule as the legacy count queries).
 */
async function loadAduConfigCounts(
  supabase: SupabaseClient,
  configs: AduConfigRow[],
): Promise<Map<string, AduConfigCounts>> {
  const counts = new Map<string, AduConfigCounts>();
  const ids = [...new Set(configs.map((c) => c.id))];
  if (ids.length === 0) return counts;
  const workspaceId = configs[0]?.workspace_id;
  if (!workspaceId || configs.some((c) => c.workspace_id !== workspaceId)) {
    throw new Error('ADU counts require configs from a single workspace.');
  }
  const { data, error } = await supabase.rpc('adu_config_counts', {
    p_workspace_id: workspaceId,
    p_config_ids: ids,
  });
  if (error) {
    if (aduRpcMissing(error)) {
      console.error(
        `ADU counts RPC missing (migration not applied): code=${error.code ?? 'unknown'}; falling back to per-config counts`,
      );
      return loadLegacyAduConfigCounts(supabase, configs);
    }
    console.error(`ADU counts RPC failed: code=${error.code ?? 'unknown'}`);
    throw new Error(`ADU counts failed: ${error.message ?? 'unknown error'}`);
  }
  for (const row of (data ?? []) as unknown[]) {
    const parsed = AduConfigCountsSchema.safeParse(row);
    if (!parsed.success) {
      console.error('ADU counts RPC returned an invalid row');
      throw new Error('ADU counts returned an invalid row.');
    }
    counts.set(parsed.data.config_id, parsed.data);
  }
  for (const config of configs) {
    if (!counts.has(config.id)) {
      console.error(`ADU counts missing for config ${config.id}: counted as 0`);
    }
  }
  return counts;
}

/**
 * Legacy per-config counts — the exact queries `buildAduConfigView`
 * ran before F1, kept as the migration-compat fallback in
 * `loadAduConfigCounts` (RPC missing = migration not yet applied).
 * Bounded counts only: the old code loaded every reel and every job
 * for a config and counted in memory, which silently truncates past
 * PostgREST's 1,000-row limit. Count queries return a number, never
 * rows, and the jobs table is retention-pruned (see adu-tick.ts).
 * A count-query failure is logged server-side (code only, no data)
 * and counted as 0 for this render — a read fallback, never a
 * fabricated persist.
 */
async function loadLegacyAduConfigCounts(
  supabase: SupabaseClient,
  configs: AduConfigRow[],
): Promise<Map<string, AduConfigCounts>> {
  const failedStatuses = ADU_FAILED_JOB_STATUSES;
  async function countRows(
    config: AduConfigRow,
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
  // Failed jobs whose reel is still in the pipeline (the crash window
  // between the job settling and the reel going 'failed'). The !inner
  // join keeps only jobs whose reel is in a pipeline status, so a
  // failed job whose reel already left the pipeline is not subtracted
  // a second time. Verified against the supabase-js query builder:
  // select=id,adu_reels!inner(status) with adu_reels.status=in.(...).
  // A failure here falls back to 0 (logged, same read-fallback rule
  // as countRows) — pending then counts the stranded reel, the safe
  // pre-fix direction.
  async function countFailedInPipeline(config: AduConfigRow): Promise<number> {
    const { count, error } = await supabase
      .from('adu_posting_jobs')
      .select('id, adu_reels!inner(status)', { count: 'exact', head: true })
      .eq('config_id', config.id)
      .in('status', failedStatuses)
      .in('adu_reels.status', ADU_PIPELINE_REEL_STATUSES);
    if (error) {
      console.error(
        `ADU count failed: table=adu_posting_jobs code=${error.code ?? 'unknown'}`,
      );
      return 0;
    }
    return count ?? 0;
  }
  async function countOne(config: AduConfigRow): Promise<AduConfigCounts> {
    const midnight = startOfDayInTimezone(config.timezone).toISOString();
    // The six counts are independent — run them concurrently (adu-opt-a
    // F3). Latency becomes max(count) instead of sum(count).
    const [
      inPipeline,
      published,
      failed,
      failedInPipeline,
      publishedToday,
      failedToday,
    ] = await Promise.all([
      countRows(config, 'adu_reels', ADU_PIPELINE_REEL_STATUSES),
      countRows(config, 'adu_posting_jobs', 'published'),
      countRows(config, 'adu_posting_jobs', failedStatuses),
      countFailedInPipeline(config),
      countRows(config, 'adu_posting_jobs', 'published', midnight),
      countRows(config, 'adu_posting_jobs', failedStatuses, midnight),
    ]);
    return {
      config_id: config.id,
      in_pipeline: inPipeline,
      published,
      failed,
      failed_in_pipeline: failedInPipeline,
      published_today: publishedToday,
      failed_today: failedToday,
    };
  }
  const entries = await Promise.all(
    configs.map(async (config) => [config.id, await countOne(config)] as const),
  );
  return new Map(entries);
}

/**
 * Pure view assembly from one config + its destination + its counts.
 * The field mapping is verbatim the old `buildAduConfigView` body;
 * only the data source changed (grouped counts instead of per-config
 * queries). Pending = reels still in the pipeline (pending,
 * processing, downloaded) minus failed jobs whose reel is STILL in
 * the pipeline. A terminally-failed reel leaves the pipeline (status
 * 'failed', written by the tick on settlement), so its job must not
 * be subtracted again — the reel leaving the pipeline already
 * removed it from the count. Only the crash window (job settled,
 * reel update not yet applied) still subtracts. The max(0, ...) floor
 * guards only against that invariant ever breaking (a duplicate job
 * for one reel), never against a miscount: both terms are exact
 * counts, never rows.
 */
function viewFromParts(
  config: AduConfigRow,
  dest: DestinationJoin | null,
  counts: AduConfigCounts,
  hub: boolean,
): AduConfigView | AduHubConfigView {
  const pendingCount = Math.max(0, counts.in_pipeline - counts.failed_in_pipeline);
  const postedToday = counts.published_today;
  const full: AduConfigView = {
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
    // The hub view drops `alert`, so it is not computed there.
    alert:
      hub
        ? null
        : dest?.platform === 'instagram'
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
    postedCount: counts.published,
    pendingCount,
    failedCount: counts.failed,
    postedToday,
    pendingToday: Math.max(0, config.posts_per_day - postedToday),
    failedToday: counts.failed_today,
  };
  if (!hub) return full;
  // Hub-only view (adu-opt-a F7): same values, without the fields the
  // hub card never renders. Keys stay in the full view's relative order.
  return {
    id: full.id,
    destinationId: full.destinationId,
    destinationName: full.destinationName,
    destinationExternalId: full.destinationExternalId,
    destinationAvatarUrl: full.destinationAvatarUrl,
    accountName: full.accountName,
    sourcePlatform: full.sourcePlatform,
    sourceUsername: full.sourceUsername,
    sourceLink: full.sourceLink,
    sourceIdentity: full.sourceIdentity,
    timezone: full.timezone,
    postsPerDay: full.postsPerDay,
    status: full.status,
    displayStatus: full.displayStatus,
    followersCount: full.followersCount,
    followersGained: full.followersGained,
    followersUpdatedAt: full.followersUpdatedAt,
    createdAt: full.createdAt,
    postedCount: full.postedCount,
    pendingCount: full.pendingCount,
    failedCount: full.failedCount,
    postedToday: full.postedToday,
    pendingToday: full.pendingToday,
    failedToday: full.failedToday,
  };
}

export async function buildAduConfigViews(
  supabase: SupabaseClient,
  configs: AduConfigRow[],
  options: { hub: true },
): Promise<AduHubConfigView[]>;
export async function buildAduConfigViews(
  supabase: SupabaseClient,
  configs: AduConfigRow[],
  options?: { hub?: false },
): Promise<AduConfigView[]>;
export async function buildAduConfigViews(
  supabase: SupabaseClient,
  configs: AduConfigRow[],
  options?: { hub?: boolean },
): Promise<Array<AduConfigView | AduHubConfigView>> {
  const hub = options?.hub === true;
  if (configs.length === 0) return [];
  // Two trips for the whole page, however many configs it holds: one
  // destinations lookup for every distinct destination id, and one
  // grouped-counts RPC for every config id (F1). The old code paid
  // 7 trips per config.
  const destinationIds = [...new Set(configs.map((c) => c.destination_id))];
  const [destinationsResult, counts] = await Promise.all([
    supabase
      .from('destinations')
      .select(
        hub
          ? 'id, name, external_destination_id, avatar_url, status, account_id, platform, social_accounts(display_name)'
          : 'id, name, external_destination_id, avatar_url, status, account_id, handle, platform, social_accounts(display_name, avatar_url)',
      )
      .in('id', destinationIds)
      .eq('section', 'adu'),
    loadAduConfigCounts(supabase, configs),
  ]);
  const { data: destinationRows, error: destinationsError } = destinationsResult;
  if (destinationsError) {
    console.error(
      `ADU destinations lookup failed: code=${destinationsError.code ?? 'unknown'}`,
    );
  }
  const destById = new Map<string, DestinationJoin>();
  // The union select string (hub vs full) does not parse under the
  // supabase-js query-builder types, so the rows arrive as an
  // unparsed type — cast through unknown, exactly like the old
  // `destination as DestinationJoin | null` cast.
  for (const row of (destinationRows ?? []) as unknown as DestinationJoin[]) {
    destById.set(row.id, row);
  }
  return configs.map((config) =>
    viewFromParts(
      config,
      destById.get(config.destination_id) ?? null,
      counts.get(config.id) ?? { ...ZERO_ADU_COUNTS, config_id: config.id },
      hub,
    ),
  );
}

export async function buildAduConfigView(
  supabase: SupabaseClient,
  config: AduConfigRow,
  options: { hub: true },
): Promise<AduHubConfigView>;
export async function buildAduConfigView(
  supabase: SupabaseClient,
  config: AduConfigRow,
  options?: { hub?: false },
): Promise<AduConfigView>;
export async function buildAduConfigView(
  supabase: SupabaseClient,
  config: AduConfigRow,
  options?: { hub?: boolean },
): Promise<AduConfigView | AduHubConfigView> {
  const views =
    options?.hub === true
      ? await buildAduConfigViews(supabase, [config], { hub: true })
      : await buildAduConfigViews(supabase, [config]);
  const [view] = views;
  if (!view) {
    throw new Error('ADU config view build returned no view.');
  }
  return view;
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
