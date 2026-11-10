import { type NextRequest, NextResponse } from 'next/server';
import {
  CreateMirrorRequestSchema,
  CreateMirrorResponseSchema,
  decryptToken,
  encryptToken,
  FB_RATE_LIMITED_COOLDOWN_MS,
  fetchAllFacebookPages,
  getTokenEncryptionKey,
  isFacebookAccountRestricted,
  MIRROR_FACEBOOK_RESTRICTED_MESSAGE,
  mirrorFbStatusFromPageStatus,
  MirrorListResponseSchema,
  MIRROR_FB_STATUSES,
  type MirrorFbStatus,
  type MirrorListView,
  type MirrorView,
} from '@fbuploadpro/contracts';
import {
  authenticateTenantRoute,
  getRouteSupabase,
  isLegacyClient,
} from '@/lib/route-auth';
import { resolveWorkspaceIdFromSession } from '@/lib/server/workspace-resolver';
import {
  assertFeatureAddWithinCap,
  getEntitlement,
  registerUsage,
  SubscriptionGateError,
  type Entitlement,
} from '@/lib/billing/entitlement';
import {
  getBillingAdminClient,
  subscriptionGateResponse,
} from '@/lib/billing/route-helpers';
import {
  paginateMeta,
  parsePaginationParams,
  type PaginationMeta,
} from '@/lib/server/pagination';
import { logServerError, trackServerEvent } from '@/lib/server-analytics';
import { unifiedDestinationStatusToWire } from '@/lib/server/facebook-wire';
import {
  buildTikwmPauseStore,
  fetchTikwmUserInfo,
  fetchTikwmUserPosts,
  getTikwmApiKeys,
  resolveTikwmVideo,
  selectLatestReel,
  TikwmError,
} from '@/lib/server/tikwm';
import { FacebookReelError, publishFacebookReel } from '@/lib/server/facebook-reel';
import { InstagramReelError, publishInstagramReel } from '@/lib/server/instagram-reel';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DatabaseClient } from '@fbuploadpro/contracts';

/**
 * TikTok mirrors — list + create (TikTok → Facebook auto-post, and
 * TikTok → Instagram auto-post for Instagram Auto Repost).
 *
 * A mirror links one TikTok username to one target destination
 * (a Facebook page, or an Instagram account). The same username
 * may feed several targets, but the exact pair (username + target)
 * may exist only once. Creation verifies the username's feed with
 * the paid tikwmapi endpoint BEFORE creating anything, then
 * resolves and immediately posts the account's current latest reel
 * via the free tikwm POST endpoint; a failed immediate post is
 * recorded as `failed` and puts the mirror in error — it stays
 * manually retryable and is never silently dropped.
 *
 * Mirror posts bypass queue/slots entirely. The mirrors table is
 * platform-agnostic, so Instagram targets need no migration.
 * Instagram targets differ in exactly two ways: the account IS the
 * destination (no linked-pages discovery), and publishing uses the
 * account token (Instagram destination rows carry no token).
 */

type Db = SupabaseClient | DatabaseClient;

export interface DestinationRow {
  id: string;
  account_id: string;
  external_destination_id: string;
  name: string;
  avatar_url: string | null;
  encrypted_destination_token: string | null;
  status: string;
  /** Spec 155: needed to derive the target's Facebook error detail. */
  metadata: Record<string, unknown> | null;
}

export interface MirrorRow {
  id: string;
  workspace_id: string;
  source_platform: string;
  source_username: string;
  source_display_name: string | null;
  source_avatar_url: string | null;
  target_platform: string;
  target_external_id: string;
  target_display_name: string;
  target_avatar_url: string | null;
  status: string;
  last_posted_source_id: string | null;
  last_posted_create_time: number | null;
  last_checked_at: string | null;
  next_check_at: string | null;
  last_error: string | null;
  /** Spec 155: the Facebook error detail (mirrors.fb_status) and its
   *  3-day auto-resume anchor (mirrors.fb_rate_limited_at). */
  fb_status: string | null;
  fb_rate_limited_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MirrorPostRow {
  id: string;
  source_post_id: string;
  caption: string;
  cover_url: string | null;
  status: string;
  published_post_id: string | null;
  created_at: string;
}

export interface CreateMirrorDeps {
  fetchTikwmPosts?: typeof fetchTikwmUserPosts;
  fetchTikwmInfo?: typeof fetchTikwmUserInfo;
  resolveTikwmVideo?: typeof resolveTikwmVideo;
  publishReel?: typeof publishFacebookReel;
  publishInstagramReel?: typeof publishInstagramReel;
  fetchGraphPages?: typeof fetchAllFacebookPages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function asDestinationRow(row: unknown): DestinationRow | null {
  if (!isRecord(row)) return null;
  const id = row.id;
  const accountId = row.account_id;
  const externalId = row.external_destination_id;
  const name = row.name;
  if (
    typeof id !== 'string' ||
    typeof accountId !== 'string' ||
    typeof externalId !== 'string' ||
    typeof name !== 'string'
  ) {
    return null;
  }
  return {
    id,
    account_id: accountId,
    external_destination_id: externalId,
    name,
    avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
    encrypted_destination_token:
      typeof row.encrypted_destination_token === 'string'
        ? row.encrypted_destination_token
        : null,
    status: typeof row.status === 'string' ? row.status : 'active',
    metadata:
      typeof row.metadata === 'object' && row.metadata !== null
        ? (row.metadata as Record<string, unknown>)
        : null,
  };
}

export function asMirrorRow(row: unknown): MirrorRow | null {
  if (!isRecord(row)) return null;
  const id = row.id;
  const workspaceId = row.workspace_id;
  const sourcePlatform = row.source_platform;
  const username = row.source_username;
  const targetPlatform = row.target_platform;
  const targetExternalId = row.target_external_id;
  const targetDisplayName = row.target_display_name;
  if (
    typeof id !== 'string' ||
    typeof workspaceId !== 'string' ||
    typeof sourcePlatform !== 'string' ||
    typeof username !== 'string' ||
    typeof targetPlatform !== 'string' ||
    typeof targetExternalId !== 'string' ||
    typeof targetDisplayName !== 'string'
  ) {
    return null;
  }
  return {
    id,
    workspace_id: workspaceId,
    source_platform: sourcePlatform,
    source_username: username,
    source_display_name:
      typeof row.source_display_name === 'string' ? row.source_display_name : null,
    source_avatar_url:
      typeof row.source_avatar_url === 'string' ? row.source_avatar_url : null,
    target_platform: targetPlatform,
    target_external_id: targetExternalId,
    target_display_name: targetDisplayName,
    target_avatar_url:
      typeof row.target_avatar_url === 'string' ? row.target_avatar_url : null,
    status: typeof row.status === 'string' ? row.status : 'active',
    last_posted_source_id:
      typeof row.last_posted_source_id === 'string' ? row.last_posted_source_id : null,
    last_posted_create_time:
      typeof row.last_posted_create_time === 'number' ? row.last_posted_create_time : null,
    last_checked_at: typeof row.last_checked_at === 'string' ? row.last_checked_at : null,
    next_check_at: typeof row.next_check_at === 'string' ? row.next_check_at : null,
    last_error: typeof row.last_error === 'string' ? row.last_error : null,
    // Spec 155: the live selects list fb_status /
    // fb_rate_limited_at explicitly and fail loudly if the
    // migration has not landed — a missing column is an error,
    // never a silent null. A missing key on a returned row (a
    // row read through a path that does not select the columns)
    // still defaults to null here; no value is ever invented.
    fb_status: typeof row.fb_status === 'string' ? row.fb_status : null,
    fb_rate_limited_at:
      typeof row.fb_rate_limited_at === 'string' ? row.fb_rate_limited_at : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : '',
  };
}

/**
 * Spec 155: the Facebook target destination's error detail, in
 * mirror spelling — the fallback in `resolveMirrorDisplayStatus`
 * when the mirror itself carries no detail. Facebook targets only:
 * Instagram targets never carry a Facebook detail, and a missing
 * destination resolves to null (the mirror then shows its own
 * detail, or generic Error).
 */
export function targetFbStatusFor(
  mirror: MirrorRow,
  destination: DestinationRow | null
): MirrorFbStatus | null {
  if (mirror.target_platform !== 'facebook' || !destination) return null;
  const wire = unifiedDestinationStatusToWire(destination.status, destination.metadata);
  // A rate-limited target whose 3-day anchor is stale reads as
  // active — the Pages read-time rule — so the mirror never shows
  // a cooldown that has already ended while nothing has flipped
  // the destination row yet.
  if (wire === 'fb_rate_limited') {
    const anchor =
      typeof destination.metadata?.rate_limited_at === 'string'
        ? Date.parse(destination.metadata.rate_limited_at)
        : Number.NaN;
    if (!Number.isNaN(anchor) && Date.now() - anchor >= FB_RATE_LIMITED_COOLDOWN_MS) {
      return null;
    }
  }
  return mirrorFbStatusFromPageStatus(wire);
}

/**
 * Build the API view from a mirror row. The destination row is
 * resolved at request time (workspace + target platform + target
 * external id) and only refines the view: the live destination name
 * / avatar win when present, the stored target copies are the
 * fallback, and the resolved destination id feeds the Insights tab.
 * When the target row is gone the mirror still renders (Dashboard
 * works); Insights reports the target as unavailable.
 */
export function toMirrorView(
  mirror: MirrorRow,
  destination: DestinationRow | null,
  lastPost: MirrorPostRow | null,
  /**
   * Target page details for the detail header (Added date,
   * followers, category, account, starting followers). Null when
   * the destination row is gone or details were not loaded — the
   * header then degrades to the stored target copies and omits
   * the detail lines, exactly like the list card does.
   */
  details: TargetPageDetails | null = null
): MirrorView {
  return {
    id: mirror.id,
    sourcePlatform: mirror.source_platform,
    sourceUsername: mirror.source_username,
    sourceDisplayName: mirror.source_display_name,
    sourceAvatarUrl: mirror.source_avatar_url,
    targetPlatform: mirror.target_platform,
    targetExternalId: mirror.target_external_id,
    targetDisplayName: destination?.name ?? mirror.target_display_name,
    targetAvatarUrl: destination?.avatar_url ?? mirror.target_avatar_url,
    targetDestinationId: destination?.id ?? null,
    targetAddedAt: details?.addedAt ?? null,
    targetFollowers: details?.followers ?? null,
    targetCategory: details?.category ?? null,
    targetAccountDisplayName: details?.accountDisplayName ?? null,
    targetAccountAvatarUrl: details?.accountAvatarUrl ?? null,
    targetStartingFollowers: details?.startingFollowers ?? null,
    status: mirror.status as MirrorView['status'],
    lastPostedSourceId: mirror.last_posted_source_id,
    lastCheckedAt: mirror.last_checked_at,
    nextCheckAt: mirror.next_check_at,
    lastError: mirror.last_error,
    // Spec 155: the mirror's own Facebook detail + anchor, and the
    // target's detail as the display fallback.
    fbStatus: mirror.fb_status as MirrorFbStatus | null,
    fbRateLimitedAt: mirror.fb_rate_limited_at,
    targetFbStatus: targetFbStatusFor(mirror, destination),
    lastMirroredPost: lastPost
      ? {
          id: lastPost.id,
          sourcePostId: lastPost.source_post_id,
          caption: lastPost.caption,
          coverUrl: lastPost.cover_url,
          status: lastPost.status as 'posted' | 'failed' | 'skipped' | 'pending',
          publishedPostId: lastPost.published_post_id,
          createdAt: lastPost.created_at,
        }
      : null,
    createdAt: mirror.created_at,
  };
}

/**
 * Target page details for the Pages-style list card, resolved from
 * existing data only: the destination row's created_at (the page's
 * Added date, exactly as the Pages list uses it), metadata.category,
 * metadata.current_followers, and the owning account's display name.
 * No Graph fetch, no invented value: a field with no stored value
 * stays null (and the card omits that line), except Facebook
 * followers, which follow the Pages extract rule and default to 0.
 * Keyed by destination row id.
 */
export interface TargetPageDetails {
  addedAt: string | null;
  followers: number | null;
  category: string | null;
  accountDisplayName: string | null;
  /** Owning account's avatar (social_accounts.avatar_url); null when none stored. */
  accountAvatarUrl: string | null;
  /**
   * Starting followers (destinations.metadata.starting_followers)
   * for the detail header's guarded "+N gained": null when no
   * starting value was ever recorded, and the header must hide
   * the gain entirely in that case — never compute it against a
   * missing baseline (which would just echo current followers).
   */
  startingFollowers: number | null;
}

function parseStoredInt(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value !== ''
        ? Number(value)
        : null;
  return parsed !== null && Number.isFinite(parsed) && parsed >= 0
    ? Math.trunc(parsed)
    : null;
}

function parsePageDetailsRow(
  row: Record<string, unknown>,
  targetPlatform: string
): TargetPageDetails {
  const metadata = row.metadata;
  const meta =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as Record<string, unknown>)
      : {};
  const category = typeof meta.category === 'string' ? meta.category : null;
  const rawFollowers =
    typeof row.current_followers === 'number'
      ? row.current_followers
      : typeof meta.current_followers === 'number'
        ? meta.current_followers
        : typeof meta.current_followers === 'string'
          ? Number(meta.current_followers)
          : null;
  const followers =
    rawFollowers !== null && Number.isFinite(rawFollowers) && rawFollowers >= 0
      ? Math.trunc(rawFollowers)
      : targetPlatform === 'facebook'
        ? 0
        : null;
  return {
    addedAt: typeof row.created_at === 'string' ? row.created_at : null,
    followers,
    category,
    accountDisplayName:
      typeof row.account_display_name === 'string' ? row.account_display_name : null,
    accountAvatarUrl:
      typeof row.account_avatar_url === 'string' ? row.account_avatar_url : null,
    startingFollowers: parseStoredInt(meta.starting_followers),
  };
}

export async function loadTargetPageDetails(
  db: Db,
  targets: Array<{ destinationId: string; platform: string }>
): Promise<Map<string, TargetPageDetails>> {
  const details = new Map<string, TargetPageDetails>();
  if (targets.length === 0) return details;
  const platformById = new Map(targets.map((t) => [t.destinationId, t.platform]));
  const destinationIds = targets.map((t) => t.destinationId);
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT d.id, d.created_at,
              (d.metadata->>'category') AS category,
              (d.metadata->>'current_followers')::int AS current_followers,
              (d.metadata->>'starting_followers')::int AS starting_followers,
              a.display_name AS account_display_name,
              a.avatar_url AS account_avatar_url
       FROM destinations d
       LEFT JOIN social_accounts a ON a.id = d.account_id
       WHERE d.id = ANY($1::uuid[])`,
      [destinationIds]
    )) as Record<string, unknown>[];
    for (const row of rows) {
      if (typeof row.id !== 'string') continue;
      const platform = platformById.get(row.id) ?? '';
      details.set(row.id, {
        addedAt: typeof row.created_at === 'string' ? row.created_at : null,
        followers:
          typeof row.current_followers === 'number'
            ? row.current_followers
            : platform === 'facebook'
              ? 0
              : null,
        category: typeof row.category === 'string' ? row.category : null,
        accountDisplayName:
          typeof row.account_display_name === 'string' ? row.account_display_name : null,
        accountAvatarUrl:
          typeof row.account_avatar_url === 'string' ? row.account_avatar_url : null,
        startingFollowers: parseStoredInt(row.starting_followers),
      });
    }
    return details;
  }
  const supabase = db as SupabaseClient;
  const { data, error } = await supabase
    .from('destinations')
    .select('id, account_id, created_at, metadata')
    .in('id', destinationIds);
  if (error) throw new Error(`Failed to load target page details: ${error.message}`);
  const accountIds = Array.from(
    new Set(
      (data ?? [])
        .map((r) => (r as Record<string, unknown>).account_id)
        .filter((v): v is string => typeof v === 'string')
    )
  );
  const accountNames = new Map<string, string>();
  const accountAvatars = new Map<string, string>();
  if (accountIds.length > 0) {
    const { data: accounts, error: accountError } = await supabase
      .from('social_accounts')
      .select('id, display_name, avatar_url')
      .in('id', accountIds);
    if (accountError) {
      throw new Error(`Failed to load target accounts: ${accountError.message}`);
    }
    for (const account of accounts ?? []) {
      const row = account as Record<string, unknown>;
      if (typeof row.id === 'string' && typeof row.display_name === 'string') {
        accountNames.set(row.id, row.display_name);
      }
      if (typeof row.id === 'string' && typeof row.avatar_url === 'string') {
        accountAvatars.set(row.id, row.avatar_url);
      }
    }
  }
  for (const row of data ?? []) {
    const record = row as Record<string, unknown>;
    if (typeof record.id !== 'string') continue;
    const platform = platformById.get(record.id) ?? '';
    const parsed = parsePageDetailsRow(record, platform);
    parsed.accountDisplayName =
      typeof record.account_id === 'string'
        ? (accountNames.get(record.account_id) ?? null)
        : null;
    parsed.accountAvatarUrl =
      typeof record.account_id === 'string'
        ? (accountAvatars.get(record.account_id) ?? null)
        : null;
    details.set(record.id, parsed);
  }
  return details;
}

/**
 * All-time Posted/Failed counts for the page slice, in ONE grouped
 * query (SQL path) or one chunked two-column fetch aggregated in
 * code (Supabase path, the Pages pattern — PostgREST has no GROUP
 * BY). Never one query per mirror. On failure the caller must
 * render dashes, never zeros (Pages R6 rule).
 */
export interface MirrorPostCountsResult {
  counts: Map<string, { posted: number; failed: number }>;
  error: boolean;
}

function toMirrorCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

export async function fetchMirrorPostCounts(
  db: Db,
  mirrorIds: string[]
): Promise<MirrorPostCountsResult> {
  const counts = new Map<string, { posted: number; failed: number }>();
  if (mirrorIds.length === 0) return { counts, error: false };
  if (isLegacyClient(db)) {
    try {
      const rows = (await db.query(
        `SELECT mirror_id,
           COUNT(*) FILTER (WHERE status = 'posted')::int AS posted,
           COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
         FROM mirror_posts WHERE mirror_id = ANY($1::uuid[]) GROUP BY mirror_id`,
        [mirrorIds]
      )) as Record<string, unknown>[];
      for (const row of rows ?? []) {
        if (typeof row.mirror_id !== 'string') continue;
        counts.set(row.mirror_id, {
          posted: toMirrorCount(row.posted),
          failed: toMirrorCount(row.failed),
        });
      }
    } catch (err) {
      logServerError('[tiktok-mirrors] List post-count query failed', err, {
        source: 'tiktok-mirrors-list-counts',
      });
      return { counts: new Map(), error: true };
    }
    return { counts, error: false };
  }
  const supabase = db as SupabaseClient;
  try {
    const CHUNK_SIZE = 1000;
    let from = 0;
    for (;;) {
      const { data, error, count } = await supabase
        .from('mirror_posts')
        .select('mirror_id,status', { count: 'exact' })
        .in('mirror_id', mirrorIds)
        .in('status', ['posted', 'failed'])
        .range(from, from + CHUNK_SIZE - 1);
      if (error) throw new Error(error.message);
      const rows = (Array.isArray(data) ? data : []) as Array<{
        mirror_id?: unknown;
        status?: unknown;
      }>;
      for (const row of rows) {
        if (typeof row.mirror_id !== 'string' || typeof row.status !== 'string') continue;
        const current = counts.get(row.mirror_id) ?? { posted: 0, failed: 0 };
        if (row.status === 'posted') current.posted += 1;
        else if (row.status === 'failed') current.failed += 1;
        counts.set(row.mirror_id, current);
      }
      if (rows.length === 0) break;
      if (typeof count === 'number' && from + rows.length >= count) break;
      if (rows.length < CHUNK_SIZE) break;
      from += CHUNK_SIZE;
    }
  } catch (err) {
    logServerError('[tiktok-mirrors] List post-count query failed', err, {
      source: 'tiktok-mirrors-list-counts',
    });
    return { counts: new Map(), error: true };
  }
  return { counts, error: false };
}

/**
 * Build the LIST view from a mirror row. Unlike toMirrorView (the
 * detail view), this omits lastMirroredPost and nextCheckAt and
 * carries the target page details + post counts for the Pages-style
 * card. The detail route keeps using toMirrorView unchanged.
 */
export function toMirrorListView(
  mirror: MirrorRow,
  destination: DestinationRow | null,
  details: TargetPageDetails | null,
  postCounts: { posted: number; failed: number },
  postCountsError: boolean
): MirrorListView {
  return {
    id: mirror.id,
    sourcePlatform: mirror.source_platform,
    sourceUsername: mirror.source_username,
    sourceDisplayName: mirror.source_display_name,
    sourceAvatarUrl: mirror.source_avatar_url,
    targetPlatform: mirror.target_platform,
    targetExternalId: mirror.target_external_id,
    targetDisplayName: destination?.name ?? mirror.target_display_name,
    targetAvatarUrl: destination?.avatar_url ?? mirror.target_avatar_url,
    targetDestinationId: destination?.id ?? null,
    status: mirror.status as MirrorListView['status'],
    lastPostedSourceId: mirror.last_posted_source_id,
    lastCheckedAt: mirror.last_checked_at,
    lastError: mirror.last_error,
    // Spec 155: the mirror's own Facebook detail + anchor, and the
    // target's detail as the display fallback.
    fbStatus: mirror.fb_status as MirrorFbStatus | null,
    fbRateLimitedAt: mirror.fb_rate_limited_at,
    targetFbStatus: targetFbStatusFor(mirror, destination),
    createdAt: mirror.created_at,
    targetAddedAt: details?.addedAt ?? null,
    targetFollowers: details?.followers ?? null,
    targetCategory: details?.category ?? null,
    targetAccountDisplayName: details?.accountDisplayName ?? null,
    postCounts,
    postCountsError,
  };
}

/**
 * Resolve target destinations by (workspace, platform, external id)
 * — the generic target lookup. The mirror row carries no destination
 * foreign key; the destination row is found at request time from
 * the mirror's target_platform + target_external_id. When several
 * rows match (same page under two accounts), the first active one
 * wins; the map keeps the first match per key.
 */
export async function loadDestinationsByExternalIds(
  db: Db,
  workspaceId: string,
  platform: string,
  externalIds: string[]
): Promise<Map<string, DestinationRow>> {
  const map = new Map<string, DestinationRow>();
  if (externalIds.length === 0) return map;
  const key = (externalId: string) => `${platform}:${externalId}`;
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status, metadata
       FROM destinations WHERE workspace_id = $1 AND platform = $2 AND external_destination_id = ANY($3::text[])
       ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at ASC`,
      [workspaceId, platform, externalIds]
    )) as unknown[];
    for (const row of rows) {
      const dest = asDestinationRow(row);
      if (dest && !map.has(key(dest.external_destination_id))) {
        map.set(key(dest.external_destination_id), dest);
      }
    }
    return map;
  }
  const supabase = db as SupabaseClient;
  const { data, error } = await supabase
    .from('destinations')
    .select('id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status, metadata')
    .eq('workspace_id', workspaceId)
    .eq('platform', platform)
    .in('external_destination_id', externalIds);
  if (error) throw new Error(`Failed to load destinations: ${error.message}`);
  const ordered = (data ?? []).slice().sort((a, b) => {
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const sa = ra.status === 'active' ? 0 : 1;
    const sb = rb.status === 'active' ? 0 : 1;
    return sa - sb;
  });
  for (const row of ordered) {
    const dest = asDestinationRow(row);
    if (dest && !map.has(key(dest.external_destination_id))) {
      map.set(key(dest.external_destination_id), dest);
    }
  }
  return map;
}

export async function loadLastPostsByMirror(
  db: Db,
  mirrorIds: string[]
): Promise<Map<string, MirrorPostRow>> {
  const map = new Map<string, MirrorPostRow>();
  if (mirrorIds.length === 0) return map;
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT DISTINCT ON (mirror_id) id, mirror_id, source_post_id, caption, cover_url, status, published_post_id, created_at
       FROM mirror_posts WHERE mirror_id = ANY($1::uuid[]) ORDER BY mirror_id, created_at DESC`,
      [mirrorIds]
    )) as Record<string, unknown>[];
    for (const row of rows) {
      if (
        typeof row.mirror_id === 'string' &&
        typeof row.id === 'string' &&
        typeof row.source_post_id === 'string'
      ) {
        map.set(row.mirror_id, {
          id: row.id,
          source_post_id: row.source_post_id,
          caption: typeof row.caption === 'string' ? row.caption : '',
          cover_url: typeof row.cover_url === 'string' ? row.cover_url : null,
          status: typeof row.status === 'string' ? row.status : 'pending',
          published_post_id:
            typeof row.published_post_id === 'string' ? row.published_post_id : null,
          created_at: typeof row.created_at === 'string' ? row.created_at : '',
        });
      }
    }
    return map;
  }
  const supabase = db as SupabaseClient;
  const { data, error } = await supabase
    .from('mirror_posts')
    .select('id, mirror_id, source_post_id, caption, cover_url, status, published_post_id, created_at')
    .in('mirror_id', mirrorIds)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to load mirror posts: ${error.message}`);
  for (const row of data ?? []) {
    const mirrorId = (row as Record<string, unknown>).mirror_id;
    if (typeof mirrorId === 'string' && !map.has(mirrorId)) {
      const post = row as unknown as Record<string, unknown>;
      if (typeof post.id === 'string' && typeof post.source_post_id === 'string') {
        map.set(mirrorId, {
          id: post.id,
          source_post_id: post.source_post_id,
          caption: typeof post.caption === 'string' ? post.caption : '',
          cover_url: typeof post.cover_url === 'string' ? post.cover_url : null,
          status: typeof post.status === 'string' ? post.status : 'pending',
          published_post_id:
            typeof post.published_post_id === 'string' ? post.published_post_id : null,
          created_at: typeof post.created_at === 'string' ? post.created_at : '',
        });
      }
    }
  }
  return map;
}

export async function handleListMirrors(
  request: NextRequest,
  subdomain: string,
  dbClient?: Db
): Promise<NextResponse> {
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const session = auth.session;

  const db = dbClient ?? getRouteSupabase();
  if (!db) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }
  const workspaceId = await resolveWorkspaceIdFromSession(session, subdomain, db, session.role);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  try {
    // Paginated exactly like the Pages list: the count is taken first
    // so an out-of-range ?page= clamps to the last page (never an
    // empty grid with no explanation), then only the page slice is
    // fetched. The destination + page-details + post-count batch
    // lookups below run over this slice only, so no query on the
    // list path is unbounded
    // (PostgREST silently truncates at 1,000 rows — an unbounded list
    // would render silently incomplete past that point).
    const { page: requestedPage, limit } = parsePaginationParams(
      new URL(request.url).searchParams
    );
    // Instagram Auto Repost lists only its own mirrors: an optional
    // ?targetPlatform= filter (facebook | instagram). Absent, the
    // list is unchanged (all platforms, as Facebook uses it).
    const rawTargetPlatform = new URL(request.url).searchParams.get('targetPlatform');
    if (rawTargetPlatform !== null && rawTargetPlatform !== 'facebook' && rawTargetPlatform !== 'instagram') {
      return NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'targetPlatform must be facebook or instagram' },
        { status: 400 }
      );
    }
    const targetPlatformFilter = rawTargetPlatform as 'facebook' | 'instagram' | null;
    // Spec 155: ?fbStatus= filters by stored state (the mirror's own
    // fb_status, or the target destination's stored detail) — not by
    // the resolved display status; see buildMirrorFbStatusSqlCondition.
    // Unknown values mean "no filter" (see normalizeMirrorFbStatus).
    const fbStatusFilter = normalizeMirrorFbStatus(
      new URL(request.url).searchParams.get('fbStatus')
    );
    let meta: PaginationMeta;
    const mirrors: MirrorRow[] = [];
    if (isLegacyClient(db)) {
      // Build the WHERE clause once: the count and the page slice
      // must filter identically, and the positional params are
      // numbered from the shared array.
      const whereParams: unknown[] = [workspaceId];
      const pushParam = (value: unknown): string => {
        whereParams.push(value);
        return `$${whereParams.length}`;
      };
      const whereParts = ['workspace_id = $1'];
      if (targetPlatformFilter) {
        whereParts.push(`target_platform = ${pushParam(targetPlatformFilter)}`);
      }
      const fbStatusCondition = buildMirrorFbStatusSqlCondition(fbStatusFilter, pushParam);
      if (fbStatusCondition) whereParts.push(fbStatusCondition);
      const whereSql = whereParts.join(' AND ');
      const countRows = (await db.query(
        `SELECT COUNT(*)::int AS total FROM mirrors WHERE ${whereSql}`,
        whereParams
      )) as Record<string, unknown>[];
      const total =
        typeof countRows[0]?.total === 'number' ? countRows[0].total : 0;
      meta = paginateMeta(total, requestedPage, limit);
      const offset = (meta.page - 1) * limit;
      const rows = (await db.query(
        `SELECT id, workspace_id, source_platform, source_username, source_display_name,
                source_avatar_url, target_platform, target_external_id, target_display_name,
                target_avatar_url, status, catch_up_pending, last_posted_source_id, last_posted_create_time,
                last_checked_at, next_check_at, last_error, fb_status, fb_rate_limited_at, created_at, updated_at
         FROM mirrors WHERE ${whereSql} ORDER BY created_at DESC LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}`,
        [...whereParams, limit, offset]
      )) as unknown[];
      for (const row of rows) {
        const mirror = asMirrorRow(row);
        if (mirror) mirrors.push(mirror);
      }
    } else {
      const supabase = db as SupabaseClient;
      const countQuery = supabase
        .from('mirrors')
        .select('*', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId);
      if (targetPlatformFilter) countQuery.eq('target_platform', targetPlatformFilter);
      if (fbStatusFilter === 'active' || fbStatusFilter === 'paused' || fbStatusFilter === 'error') {
        countQuery.eq('status', fbStatusFilter);
      } else if (fbStatusFilter !== null) {
        countQuery.eq('status', 'error').eq('fb_status', fbStatusFilter);
      }
      const { count, error: countError } = await countQuery;
      if (countError) {
        throw new Error(`Failed to count mirrors: ${countError.message}`);
      }
      const total = typeof count === 'number' ? count : 0;
      meta = paginateMeta(total, requestedPage, limit);
      const offset = (meta.page - 1) * limit;
      const listQuery = supabase
        .from('mirrors')
        .select(
          'id, workspace_id, source_platform, source_username, source_display_name, source_avatar_url, target_platform, target_external_id, target_display_name, target_avatar_url, status, catch_up_pending, last_posted_source_id, last_posted_create_time, last_checked_at, next_check_at, last_error, fb_status, fb_rate_limited_at, created_at, updated_at'
        )
        .eq('workspace_id', workspaceId);
      if (targetPlatformFilter) listQuery.eq('target_platform', targetPlatformFilter);
      if (fbStatusFilter === 'active' || fbStatusFilter === 'paused' || fbStatusFilter === 'error') {
        listQuery.eq('status', fbStatusFilter);
      } else if (fbStatusFilter !== null) {
        listQuery.eq('status', 'error').eq('fb_status', fbStatusFilter);
      }
      const { data, error } = await listQuery
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw new Error(`Failed to list mirrors: ${error.message}`);
      for (const row of data ?? []) {
        const mirror = asMirrorRow(row);
        if (mirror) mirrors.push(mirror);
      }
    }

    // Group mirrors by target platform for the batch resolution. Both
    // lookups below run over the page slice only: their ids come from
    // `mirrors`, which holds at most one page (30 rows), never the
    // full set.
    const byPlatform = new Map<string, string[]>();
    for (const mirror of mirrors) {
      const list = byPlatform.get(mirror.target_platform) ?? [];
      if (!list.includes(mirror.target_external_id)) list.push(mirror.target_external_id);
      byPlatform.set(mirror.target_platform, list);
    }
    const destinations = new Map<string, DestinationRow>();
    for (const [platform, externalIds] of byPlatform) {
      const resolved = await loadDestinationsByExternalIds(
        db,
        workspaceId,
        platform,
        externalIds
      );
      for (const [key, dest] of resolved) destinations.set(key, dest);
    }
    // List card data only: target page details + all-time post
    // counts, both batched over the page slice. The list view
    // deliberately carries NO lastMirroredPost and NO nextCheckAt —
    // those live on the detail view only. A mirror whose target
    // row is gone still renders from its stored target copies
    // (Insights reports it unavailable); its page details are
    // simply null and the card omits those lines.
    const resolvedDestinations = mirrors.map((mirror) => ({
      mirror,
      dest:
        destinations.get(`${mirror.target_platform}:${mirror.target_external_id}`) ?? null,
    }));
    const pageDetails = await loadTargetPageDetails(
      db,
      resolvedDestinations
        .filter((entry) => entry.dest !== null)
        .map((entry) => ({
          destinationId: entry.dest!.id,
          platform: entry.mirror.target_platform,
        }))
    );
    const postCountsResult = await fetchMirrorPostCounts(
      db,
      mirrors.map((m) => m.id)
    );
    const views: MirrorListView[] = [];
    for (const { mirror, dest } of resolvedDestinations) {
      views.push(
        toMirrorListView(
          mirror,
          dest,
          dest ? (pageDetails.get(dest.id) ?? null) : null,
          postCountsResult.counts.get(mirror.id) ?? { posted: 0, failed: 0 },
          postCountsResult.error
        )
      );
    }
    const parsed = MirrorListResponseSchema.safeParse({
      mirrors: views,
      total: meta.total,
      page: meta.page,
      limit: meta.limit,
      totalPages: meta.totalPages,
    });
    if (!parsed.success) {
      logServerError('[tiktok-mirrors] List response failed validation', parsed.error, {
        source: 'tiktok-mirrors-list',
        subdomain,
      });
      return NextResponse.json({ error: 'Failed to load TikTok mirrors' }, { status: 500 });
    }
    return NextResponse.json(parsed.data);
  } catch (err) {
    logServerError('[tiktok-mirrors] List failed', err, {
      source: 'tiktok-mirrors-list',
      subdomain,
    });
    return NextResponse.json({ error: 'Failed to load TikTok mirrors' }, { status: 500 });
  }
}

/**
 * Resolve the destination for a create request. Either an existing
 * destination id, or an account + Facebook page id (discovered page):
 * the page is re-fetched from Graph with the decrypted account token
 * (same pattern as the pages import route) and its destination row
 * is created (or refreshed) — identity + token only, NO slots, NO timezone steps.
 */
async function resolveDestination(
  db: Db,
  workspaceId: string,
  input: {
    targetDestinationId?: string | undefined;
    accountId?: string | undefined;
    targetExternalId?: string | undefined;
  },
  deps: CreateMirrorDeps
): Promise<{ destination: DestinationRow } | { error: NextResponse }> {
  const encryptionKey = getTokenEncryptionKey();
  if (input.targetDestinationId) {
    const dest = await loadDestinationById(db, input.targetDestinationId, workspaceId);
    if (!dest) {
      return {
        error: NextResponse.json({ error: 'Facebook page not found' }, { status: 404 }),
      };
    }
    return { destination: dest };
  }

  const accountId = input.accountId as string;
  const targetExternalId = input.targetExternalId as string;

  // Load the account's encrypted token (workspace + facebook only).
  let encryptedAccountToken: string | null = null;
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT encrypted_access_token FROM social_accounts
       WHERE id = $1 AND workspace_id = $2 AND platform = 'facebook' LIMIT 1`,
      [accountId, workspaceId]
    )) as Record<string, unknown>[];
    const token = rows[0]?.encrypted_access_token;
    encryptedAccountToken = typeof token === 'string' ? token : null;
  } else {
    const supabase = db as SupabaseClient;
    const { data, error } = await supabase
      .from('social_accounts')
      .select('encrypted_access_token')
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'facebook')
      .maybeSingle();
    if (error) throw new Error(`Failed to load account: ${error.message}`);
    const token = (data as Record<string, unknown> | null)?.encrypted_access_token;
    encryptedAccountToken = typeof token === 'string' ? token : null;
  }
  if (!encryptedAccountToken) {
    return {
      error: NextResponse.json({ error: 'Facebook account not found' }, { status: 404 }),
    };
  }
  const rawAccountToken = await decryptToken(encryptedAccountToken, encryptionKey);
  const fetchGraphPages = deps.fetchGraphPages ?? fetchAllFacebookPages;
  const fetched = await fetchGraphPages(
    rawAccountToken,
    'id,name,category,tasks,access_token,followers_count,picture{url}'
  );
  const page = fetched.pages.find((p) => String(p.id) === targetExternalId);
  if (!page) {
    return {
      error: NextResponse.json({ error: 'Facebook page not found' }, { status: 404 }),
    };
  }
  const rawPageToken = page.access_token || rawAccountToken;
  const encryptedPageToken = await encryptToken(rawPageToken, encryptionKey);
  const pictureUrl = page.picture?.data?.url ?? null;

  // If the destination already exists, refresh only identity + token:
  // creating a mirror must NEVER flip a paused/disconnected page
  // back to active for the queue (mirrors bypass queue entirely).
  let existing: DestinationRow | null = null;
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status
       FROM destinations WHERE account_id = $1 AND external_destination_id = $2 LIMIT 1`,
      [accountId, String(page.id)]
    )) as unknown[];
    existing = asDestinationRow(rows[0]);
  } else {
    const supabase = db as SupabaseClient;
    const { data, error } = await supabase
      .from('destinations')
      .select('id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status')
      .eq('account_id', accountId)
      .eq('external_destination_id', String(page.id))
      .maybeSingle();
    if (error) throw new Error(`Failed to load destination: ${error.message}`);
    existing = asDestinationRow(data);
  }
  if (existing) {
    if (isLegacyClient(db)) {
      await db.query(
        `UPDATE destinations SET name = $2, avatar_url = $3, encrypted_destination_token = $4, updated_at = now() WHERE id = $1`,
        [existing.id, String(page.name), pictureUrl, encryptedPageToken]
      );
    } else {
      const supabase = db as SupabaseClient;
      const { error } = await supabase
        .from('destinations')
        .update({
          name: String(page.name),
          avatar_url: pictureUrl,
          encrypted_destination_token: encryptedPageToken,
        })
        .eq('id', existing.id);
      if (error) throw new Error(`Failed to refresh destination: ${error.message}`);
    }
    return {
      destination: {
        ...existing,
        name: String(page.name),
        avatar_url: pictureUrl,
        encrypted_destination_token: encryptedPageToken,
      },
    };
  }

  // New destination row (identity + token only, NO slots).
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `INSERT INTO destinations (
         workspace_id, account_id, platform, external_destination_id, name, avatar_url,
         encrypted_destination_token, status, metadata, updated_at
       ) VALUES ($1, $2, 'facebook', $3, $4, $5, $6, 'active',
         jsonb_build_object('category', $7::text), now())
       ON CONFLICT (account_id, external_destination_id) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id,
         name = EXCLUDED.name,
         avatar_url = EXCLUDED.avatar_url,
         encrypted_destination_token = EXCLUDED.encrypted_destination_token,
         updated_at = now()
       RETURNING id, account_id, external_destination_id, name, avatar_url,
         encrypted_destination_token, status`,
      [
        workspaceId,
        accountId,
        String(page.id),
        String(page.name),
        pictureUrl,
        encryptedPageToken,
        page.category ?? null,
      ]
    )) as unknown[];
    const dest = asDestinationRow(rows[0]);
    if (!dest) throw new Error('Failed to create destination for page');
    return { destination: dest };
  }
  const supabase = db as SupabaseClient;
  const { data, error } = await supabase
    .from('destinations')
    .insert({
        workspace_id: workspaceId,
        account_id: accountId,
        platform: 'facebook',
        external_destination_id: String(page.id),
        name: String(page.name),
        avatar_url: pictureUrl,
        encrypted_destination_token: encryptedPageToken,
        status: 'active',
        metadata: { category: page.category ?? null },
      })
    .select(
      'id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status'
    )
    .single();
  // Insert first; on a concurrent-insert conflict (23505) fall back
  // to the refresh path so an existing destination's status is
  // never flipped by a mirror creation (an upsert would overwrite
  // status with 'active').
  if (error && error.code === '23505') {
    const { data: raced, error: racedError } = await supabase
      .from('destinations')
      .select('id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status')
      .eq('account_id', accountId)
      .eq('external_destination_id', String(page.id))
      .maybeSingle();
    if (racedError) throw new Error(`Failed to load destination: ${racedError.message}`);
    const racedDest = asDestinationRow(raced);
    if (!racedDest) throw new Error('Failed to create destination for page');
    const { error: refreshError } = await supabase
      .from('destinations')
      .update({
        name: String(page.name),
        avatar_url: pictureUrl,
        encrypted_destination_token: encryptedPageToken,
      })
      .eq('id', racedDest.id);
    if (refreshError) throw new Error(`Failed to refresh destination: ${refreshError.message}`);
    return {
      destination: {
        ...racedDest,
        name: String(page.name),
        avatar_url: pictureUrl,
        encrypted_destination_token: encryptedPageToken,
      },
    };
  }
  if (error) throw new Error(`Failed to create destination for page: ${error.message}`);
  const dest = asDestinationRow(data);
  if (!dest) throw new Error('Failed to create destination for page');
  return { destination: dest };
}

/**
 * Resolve the Instagram destination for a create request.
 *
 * Unlike Facebook, there is no linked-pages discovery: the Instagram
 * account IS the destination, and its external id is the account's
 * own external id. Either an existing Instagram destination id is
 * named, or an account + its external id is named. The account row
 * must be active — an expired account fails loudly here (reconnect
 * first) instead of creating a mirror that can never post. A missing
 * destination row is created identity-only from the account: the
 * publishing token lives on the account row, so the destination row
 * deliberately carries no token (the worker's Instagram fallback
 * and this route's immediate post both read the account token).
 * The returned accountToken is decrypted in memory only, exactly
 * as the Facebook path decrypts the page token in memory.
 */
async function resolveInstagramDestination(
  db: Db,
  workspaceId: string,
  input: {
    targetDestinationId?: string | undefined;
    accountId?: string | undefined;
    targetExternalId?: string | undefined;
  }
): Promise<
  | { destination: DestinationRow; accountToken: string | null }
  | { error: NextResponse }
> {
  const encryptionKey = getTokenEncryptionKey();

  if (input.targetDestinationId) {
    let dest: DestinationRow | null = null;
    if (isLegacyClient(db)) {
      const rows = (await db.query(
        `SELECT id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status
         FROM destinations WHERE id = $1 AND workspace_id = $2 AND platform = 'instagram' LIMIT 1`,
        [input.targetDestinationId, workspaceId]
      )) as unknown[];
      dest = asDestinationRow(rows[0]);
    } else {
      const supabase = db as SupabaseClient;
      const { data, error } = await supabase
        .from('destinations')
        .select('id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status')
        .eq('id', input.targetDestinationId)
        .eq('workspace_id', workspaceId)
        .eq('platform', 'instagram')
        .maybeSingle();
      if (error) throw new Error(`Failed to load destination: ${error.message}`);
      dest = asDestinationRow(data);
    }
    if (!dest) {
      return {
        error: NextResponse.json({ error: 'Instagram account not found' }, { status: 404 }),
      };
    }
    const accountToken = await loadInstagramAccountToken(db, workspaceId, dest.account_id);
    return { destination: dest, accountToken };
  }

  const accountId = input.accountId as string;
  const targetExternalId = input.targetExternalId as string;
  interface InstagramAccountRow {
    id: string;
    external_account_id: string;
    display_name: string;
    avatar_url: string | null;
    status: string;
    encrypted_access_token: string | null;
  }
  let account: InstagramAccountRow | null = null;
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT id, external_account_id, display_name, avatar_url, status, encrypted_access_token
       FROM social_accounts WHERE id = $1 AND workspace_id = $2 AND platform = 'instagram' LIMIT 1`,
      [accountId, workspaceId]
    )) as Record<string, unknown>[];
    const row = rows[0];
    if (row && typeof row.id === 'string' && typeof row.external_account_id === 'string') {
      account = {
        id: row.id,
        external_account_id: row.external_account_id,
        display_name: typeof row.display_name === 'string' ? row.display_name : '',
        avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
        status: typeof row.status === 'string' ? row.status : '',
        encrypted_access_token:
          typeof row.encrypted_access_token === 'string' ? row.encrypted_access_token : null,
      };
    }
  } else {
    const supabase = db as SupabaseClient;
    const { data, error } = await supabase
      .from('social_accounts')
      .select('id, external_account_id, display_name, avatar_url, status, encrypted_access_token')
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'instagram')
      .maybeSingle();
    if (error) throw new Error(`Failed to load account: ${error.message}`);
    const row = data as Record<string, unknown> | null;
    if (row && typeof row.id === 'string' && typeof row.external_account_id === 'string') {
      account = {
        id: row.id,
        external_account_id: row.external_account_id,
        display_name: typeof row.display_name === 'string' ? row.display_name : '',
        avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
        status: typeof row.status === 'string' ? row.status : '',
        encrypted_access_token:
          typeof row.encrypted_access_token === 'string' ? row.encrypted_access_token : null,
      };
    }
  }
  if (!account || account.external_account_id !== targetExternalId) {
    return {
      error: NextResponse.json({ error: 'Instagram account not found' }, { status: 404 }),
    };
  }
  if (account.status !== 'active') {
    return {
      error: NextResponse.json(
        { error: 'ACCOUNT_EXPIRED', message: 'This Instagram account is expired. Reconnect it and try again.' },
        { status: 400 }
      ),
    };
  }

  let existing: DestinationRow | null = null;
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status
       FROM destinations WHERE account_id = $1 AND external_destination_id = $2 AND platform = 'instagram' LIMIT 1`,
      [accountId, targetExternalId]
    )) as unknown[];
    existing = asDestinationRow(rows[0]);
  } else {
    const supabase = db as SupabaseClient;
    const { data, error } = await supabase
      .from('destinations')
      .select('id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status')
      .eq('account_id', accountId)
      .eq('external_destination_id', targetExternalId)
      .eq('platform', 'instagram')
      .maybeSingle();
    if (error) throw new Error(`Failed to load destination: ${error.message}`);
    existing = asDestinationRow(data);
  }
  const accountToken = account.encrypted_access_token
    ? await decryptToken(account.encrypted_access_token, encryptionKey)
    : null;
  if (existing) return { destination: existing, accountToken };

  // Identity-only destination row (no token — see the header comment).
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `INSERT INTO destinations (
         workspace_id, account_id, platform, external_destination_id, name, avatar_url, status, metadata, updated_at
       ) VALUES ($1, $2, 'instagram', $3, $4, $5, 'active', '{}'::jsonb, now())
       ON CONFLICT (account_id, external_destination_id) DO NOTHING
       RETURNING id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status`,
      [workspaceId, accountId, targetExternalId, account.display_name, account.avatar_url]
    )) as unknown[];
    const created = asDestinationRow(rows[0]);
    if (created) return { destination: created, accountToken };
    const raced = (await db.query(
      `SELECT id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status
       FROM destinations WHERE account_id = $1 AND external_destination_id = $2 AND platform = 'instagram' LIMIT 1`,
      [accountId, targetExternalId]
    )) as unknown[];
    const racedDest = asDestinationRow(raced[0]);
    if (!racedDest) throw new Error('Failed to create destination for Instagram account');
    return { destination: racedDest, accountToken };
  }
  const supabase = db as SupabaseClient;
  const { data, error } = await supabase
    .from('destinations')
    .insert({
      workspace_id: workspaceId,
      account_id: accountId,
      platform: 'instagram',
      external_destination_id: targetExternalId,
      name: account.display_name,
      avatar_url: account.avatar_url,
      status: 'active',
      metadata: {},
    })
    .select('id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status')
    .single();
  if (error && error.code === '23505') {
    const { data: raced, error: racedError } = await supabase
      .from('destinations')
      .select('id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status')
      .eq('account_id', accountId)
      .eq('external_destination_id', targetExternalId)
      .eq('platform', 'instagram')
      .maybeSingle();
    if (racedError) throw new Error(`Failed to load destination: ${racedError.message}`);
    const racedDest = asDestinationRow(raced);
    if (!racedDest) throw new Error('Failed to create destination for Instagram account');
    return { destination: racedDest, accountToken };
  }
  if (error) throw new Error(`Failed to create destination: ${error.message}`);
  const created = asDestinationRow(data);
  if (!created) throw new Error('Failed to create destination for Instagram account');
  return { destination: created, accountToken };
}

/** Decrypted Instagram account token for one account id (in memory only). */
/**
 * Whether an Instagram account row is a Unified Login (BISU)
 * account: metadata.token_kind === 'bisu' exactly. Anything else
 * (absent metadata, absent token_kind, any other value) is legacy
 * and must never be guessed as BISU. Mirrors the worker and
 * Publish Now rule.
 */
async function loadInstagramAccountIsBisu(
  db: Db,
  workspaceId: string,
  accountId: string
): Promise<boolean> {
  let metadata: unknown = null;
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT metadata FROM social_accounts WHERE id = $1 AND workspace_id = $2 AND platform = 'instagram' LIMIT 1`,
      [accountId, workspaceId]
    )) as Record<string, unknown>[];
    metadata = rows[0]?.metadata ?? null;
  } else {
    const supabase = db as SupabaseClient;
    const { data, error } = await supabase
      .from('social_accounts')
      .select('metadata')
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'instagram')
      .maybeSingle();
    if (error) throw new Error(`Failed to load Instagram account: ${error.message}`);
    metadata = (data as Record<string, unknown> | null)?.metadata ?? null;
  }
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    (metadata as Record<string, unknown>).token_kind === 'bisu'
  );
}

async function loadInstagramAccountToken(
  db: Db,
  workspaceId: string,
  accountId: string
): Promise<string | null> {
  const encryptionKey = getTokenEncryptionKey();
  let encrypted: string | null = null;
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT encrypted_access_token FROM social_accounts WHERE id = $1 AND workspace_id = $2 AND platform = 'instagram' LIMIT 1`,
      [accountId, workspaceId]
    )) as Record<string, unknown>[];
    const token = rows[0]?.encrypted_access_token;
    encrypted = typeof token === 'string' ? token : null;
  } else {
    const supabase = db as SupabaseClient;
    const { data, error } = await supabase
      .from('social_accounts')
      .select('encrypted_access_token')
      .eq('id', accountId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'instagram')
      .maybeSingle();
    if (error) throw new Error(`Failed to load account: ${error.message}`);
    const token = (data as Record<string, unknown> | null)?.encrypted_access_token;
    encrypted = typeof token === 'string' ? token : null;
  }
  return encrypted ? decryptToken(encrypted, encryptionKey) : null;
}

/**
 * Load one destination row by id, scoped to the caller's workspace
 * (used when the create request names an existing destination; the
 * mirror itself never stores this id — it stores the target platform
 * + external id). A foreign-workspace id must read as not found, so a
 * mirror can never be created against another workspace's page.
 */
export async function loadDestinationById(
  db: Db,
  id: string,
  workspaceId: string
): Promise<DestinationRow | null> {
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status
       FROM destinations WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [id, workspaceId]
    )) as unknown[];
    return asDestinationRow(rows[0]);
  }
  const supabase = db as SupabaseClient;
  const { data, error } = await supabase
    .from('destinations')
    .select('id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load destination: ${error.message}`);
  return asDestinationRow(data);
}

async function findDuplicateMirror(
  db: Db,
  workspaceId: string,
  targetPlatform: string,
  targetExternalId: string,
  username: string
): Promise<boolean> {
  // Exact pair (source platform + username + target platform +
  // target id) — the DB unique index is the backstop; this check
  // gives the friendly 409. Same username feeding a different
  // target stays allowed.
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT 1 FROM mirrors
       WHERE workspace_id = $1
         AND source_platform = 'tiktok'
         AND source_username = $2
         AND target_platform = $3
         AND target_external_id = $4
       LIMIT 1`,
      [workspaceId, username, targetPlatform, targetExternalId]
    )) as unknown[];
    return rows.length > 0;
  }
  const supabase = db as SupabaseClient;
  const { data, error } = await supabase
    .from('mirrors')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('source_platform', 'tiktok')
    .eq('source_username', username)
    .eq('target_platform', targetPlatform)
    .eq('target_external_id', targetExternalId)
    .limit(1);
  if (error) throw new Error(`Failed to check duplicates: ${error.message}`);
  return (data ?? []).length > 0;
}

export async function handleCreateMirror(
  request: NextRequest,
  subdomain: string,
  dbClient?: Db,
  deps: CreateMirrorDeps = {}
): Promise<NextResponse> {
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  const session = auth.session;

  const db = dbClient ?? getRouteSupabase();
  if (!db) {
    return NextResponse.json({ error: 'Database service unavailable' }, { status: 500 });
  }
  const workspaceId = await resolveWorkspaceIdFromSession(session, subdomain, db, session.role);
  if (!workspaceId) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON payload' },
      { status: 400 }
    );
  }
  const parsed = CreateMirrorRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const username = parsed.data.sourceUsername;

  try {
    // 1. Verify the feed with the PAID tikwmapi feed endpoint
    //    BEFORE resolving or creating anything: a failed feed
    //    must leave no destination row behind. Key rotation
    //    pauses live in tikwmapi_key_pauses; the store is built
    //    from this request's database handle (both client shapes).
    const apiKeys = getTikwmApiKeys();
    const pauseStore = buildTikwmPauseStore(db, isLegacyClient(db));
    const fetchPosts = deps.fetchTikwmPosts ?? fetchTikwmUserPosts;
    let videos;
    try {
      videos = await fetchPosts(username, { count: 30, apiKeys, pauseStore });
    } catch (err) {
      if (err instanceof TikwmError) {
        return NextResponse.json(
          { error: 'TIKTOK_FEED_UNAVAILABLE', message: err.message },
          { status: 400 }
        );
      }
      throw err;
    }

    // 2. Resolve (or create) the destination row. Instagram targets
    //    take the Instagram branch (account IS the destination);
    //    Facebook targets take the existing Graph-discovery branch.
    //    The branches are written out (not a ternary over the two
    //    resolvers) so the Instagram account token stays typed as
    //    string | null instead of collapsing through a union.
    const targetPlatform = parsed.data.targetPlatform ?? 'facebook';
    let destination: DestinationRow;
    let instagramAccountToken: string | null = null;
    if (targetPlatform === 'instagram') {
      const resolved = await resolveInstagramDestination(db, workspaceId, {
        targetDestinationId: parsed.data.targetDestinationId,
        accountId: parsed.data.accountId,
        targetExternalId: parsed.data.targetExternalId,
      });
      if ('error' in resolved) return resolved.error;
      destination = resolved.destination;
      instagramAccountToken = resolved.accountToken;
    } else {
      const resolved = await resolveDestination(
        db,
        workspaceId,
        {
          targetDestinationId: parsed.data.targetDestinationId,
          accountId: parsed.data.accountId,
          targetExternalId: parsed.data.targetExternalId,
        },
        deps
      );
      if ('error' in resolved) return resolved.error;
      destination = resolved.destination;
    }

    // 2b. Plan cap gate: the gate CHECKS the target page /
    // account against that platform's cap, so an over-cap mirror is
    // rejected here, before any mirror row is created. Creation
    // registers the unit (step 5b). Admins are never gated, and a
    // missing billing client skips the gate (same rule as the
    // destination-queue gate) — but the skip is logged loudly
    // (audit fix 2026-11-01): a silent skip is a fail-open.
    // R3: the entitlement is read once here and shared with the
    // register at step 5b — the only write between the two reads
    // is the mirror row itself, so the shared answer is exact.
    // Undefined when the gate is skipped (admin / no client);
    // registerUsage re-reads on its own then, as before.
    let sharedEntitlement: Entitlement | undefined;
    if (session.role !== 'admin') {
      const billingClient = getBillingAdminClient();
      if (!billingClient) {
        logServerError('[billing] mirror cap gate skipped: no billing client', null, {
          source: 'billing',
        });
      }
      if (billingClient) {
        try {
          sharedEntitlement = await getEntitlement(billingClient, session.userId);
          await assertFeatureAddWithinCap(
            billingClient,
            session.userId,
            targetPlatform,
            [destination.external_destination_id ?? destination.id],
            undefined,
            sharedEntitlement
          );
        } catch (err) {
          const gateResponse = subscriptionGateResponse(err);
          if (gateResponse) return gateResponse;
          throw err;
        }
      }
    }

    // 3. Exact-duplicate block (same source username + same target).
    if (
      await findDuplicateMirror(
        db,
        workspaceId,
        targetPlatform,
        destination.external_destination_id,
        username
      )
    ) {
      return NextResponse.json(
        {
          error: 'DUPLICATE_MIRROR',
          message:
            targetPlatform === 'instagram'
              ? 'This TikTok account is already reposted to this Instagram account.'
              : 'This TikTok account is already mirrored to this Facebook page.',
        },
        { status: 409 }
      );
    }

    // 4. Display info (best effort; feed author fields are fallback).
    const fetchInfo = deps.fetchTikwmInfo ?? fetchTikwmUserInfo;
    const info = await fetchInfo(username, { apiKeys, pauseStore });
    const firstAuthor = videos[0]?.author;
    const displayName = info?.nickname ?? firstAuthor?.nickname ?? null;
    const avatarUrl = info?.avatar ?? firstAuthor?.avatar ?? null;

    // 5. Create the mirror row (generic target reference: platform
    //    + external id + display copies; no destination foreign key).
    let mirror: MirrorRow;
    if (isLegacyClient(db)) {
      const rows = (await db.query(
        `INSERT INTO mirrors (
           workspace_id, source_platform, source_username, source_display_name,
           source_avatar_url, target_platform, target_external_id, target_display_name,
           target_avatar_url, status, last_checked_at, next_check_at, created_at, updated_at
         ) VALUES ($1, 'tiktok', $2, $3, $4, $9, $5, $6, $7, 'active', now(), $8, now(), now())
         RETURNING id, workspace_id, source_platform, source_username, source_display_name,
           source_avatar_url, target_platform, target_external_id, target_display_name,
           target_avatar_url, status, catch_up_pending, last_posted_source_id, last_posted_create_time,
           last_checked_at, next_check_at, last_error, fb_status, fb_rate_limited_at, created_at, updated_at`,
        [
          workspaceId,
          username,
          displayName,
          avatarUrl,
          destination.external_destination_id,
          destination.name,
          destination.avatar_url,
          new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          targetPlatform,
        ]
      )) as unknown[];
      const created = asMirrorRow(rows[0]);
      if (!created) throw new Error('Failed to create mirror');
      mirror = created;
    } else {
      const supabase = db as SupabaseClient;
      const { data, error } = await supabase
        .from('mirrors')
        .insert({
          workspace_id: workspaceId,
          source_platform: 'tiktok',
          source_username: username,
          source_display_name: displayName,
          source_avatar_url: avatarUrl,
          target_platform: targetPlatform,
          target_external_id: destination.external_destination_id,
          target_display_name: destination.name,
          target_avatar_url: destination.avatar_url,
          status: 'active',
          // Setup verified the feed, so setup counts as the last
          // successful check: the tick's 2-hour gap rule measures
          // from here until the first hourly tick stamps it.
          last_checked_at: new Date().toISOString(),
          next_check_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })
        .select(
          'id, workspace_id, source_platform, source_username, source_display_name, source_avatar_url, target_platform, target_external_id, target_display_name, target_avatar_url, status, catch_up_pending, last_posted_source_id, last_posted_create_time, last_checked_at, next_check_at, last_error, fb_status, fb_rate_limited_at, created_at, updated_at'
        )
        .single();
      if (error) {
        // Unique-violation race: another create landed first.
        if (error.code === '23505') {
          return NextResponse.json(
            {
              error: 'DUPLICATE_MIRROR',
              message:
                targetPlatform === 'instagram'
                  ? 'This TikTok account is already reposted to this Instagram account.'
                  : 'This TikTok account is already mirrored to this Facebook page.',
            },
            { status: 409 }
          );
        }
        throw new Error(`Failed to create mirror: ${error.message}`);
      }
      const created = asMirrorRow(data);
      if (!created) throw new Error('Failed to create mirror');
      mirror = created;
    }

    // 5b. Cap at add (audit fix 2026-11-01): creation registers
    // the target's unit. A registration failure rolls the mirror
    // back and fails the add — a mirror must never exist without
    // its unit. Admins never register; a missing billing client
    // skips with a loud log (same rule as the gate).
    if (session.role !== 'admin') {
      const billingClient = getBillingAdminClient();
      if (!billingClient) {
        logServerError('[billing] mirror usage registration skipped: no billing client', null, {
          source: 'billing',
        });
      } else {
        try {
          await registerUsage(
            billingClient,
            session.userId,
            targetPlatform,
            destination.external_destination_id ?? destination.id,
            'tiktok-mirror',
            destination.id,
            undefined,
            sharedEntitlement
          );
        } catch (regError) {
          if (isLegacyClient(db)) {
            await db.query(`DELETE FROM mirrors WHERE id = $1 AND workspace_id = $2`, [
              mirror.id,
              workspaceId,
            ]);
          } else {
            await (db as SupabaseClient)
              .from('mirrors')
              .delete()
              .eq('id', mirror.id)
              .eq('workspace_id', workspaceId);
          }
          const gateResponse =
            regError instanceof SubscriptionGateError
              ? subscriptionGateResponse(regError)
              : null;
          if (gateResponse) return gateResponse;
          logServerError('[billing] mirror usage registration failed', regError, {
            source: 'billing',
          });
          return NextResponse.json(
            { error: 'The plan limit could not be registered. Please try again.' },
            { status: 500 }
          );
        }
      }
    }

    // 6. Immediate post of the current latest reel: resolve it
    //    via the FREE tikwm POST endpoint (no-watermark URL +
    //    verbatim title), then claim, then post, then update —
    //    the same claim discipline as the hourly tick, so a
    //    failure is recorded as `failed` with the error (mirror
    //    error) and stays manually retryable — the next tick does
    //    not auto-retry the post. A resolve failure claims a
    //    failed row with the error, never silently skipped.
    const latest = selectLatestReel(videos);
    let immediatePost: {
      attempted: boolean;
      status: 'posted' | 'failed' | 'skipped' | 'pending' | null;
      sourcePostId: string | null;
      publishedPostId: string | null;
      error: string | null;
    } | null = null;
    if (latest && latest.play) {
      const resolveVideo = deps.resolveTikwmVideo ?? resolveTikwmVideo;
      let caption = latest.title ?? '';
      let resolvedUrl: string | null = null;
      let resolveError: string | null = null;
      try {
        const resolved = await resolveVideo(
          `https://www.tiktok.com/@${username}/video/${latest.video_id}`
        );
        resolvedUrl = resolved.playUrl;
        caption = resolved.title || caption;
      } catch (err) {
        resolveError =
          err instanceof Error ? err.message : 'The latest reel could not be resolved.';
      }
      const coverUrl = latest.cover ?? null;
      const sourceCreatedAt =
        typeof latest.create_time === 'number'
          ? new Date(latest.create_time * 1000).toISOString()
          : null;
      let postRowId: string | null = null;
      if (isLegacyClient(db)) {
        const rows = (await db.query(
          `INSERT INTO mirror_posts (
             mirror_id, source_post_id, caption, video_url, cover_url,
             source_created_at, status, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', now())
           ON CONFLICT (mirror_id, source_post_id) DO NOTHING
           RETURNING id`,
          [mirror.id, latest.video_id, caption, resolvedUrl, coverUrl, sourceCreatedAt]
        )) as Record<string, unknown>[];
        postRowId = typeof rows[0]?.id === 'string' ? (rows[0].id as string) : null;
      } else {
        const supabase = db as SupabaseClient;
        const { data, error } = await supabase
          .from('mirror_posts')
          .insert({
            mirror_id: mirror.id,
            source_post_id: latest.video_id,
            caption,
            video_url: resolvedUrl,
            cover_url: coverUrl,
            source_created_at: sourceCreatedAt,
            status: 'pending',
          })
          .select('id')
          .single();
        if (error && error.code !== '23505') {
          throw new Error(`Failed to claim latest reel: ${error.message}`);
        }
        postRowId = data ? (data as Record<string, unknown>).id as string : null;
      }

      if (postRowId && resolveError) {
        await updatePostAndMirror(db, mirror.id, postRowId, {
          status: 'failed',
          error: resolveError,
          mirrorStatus: 'error',
        });
        immediatePost = {
          attempted: true,
          status: 'failed',
          sourcePostId: latest.video_id,
          publishedPostId: null,
          error: resolveError,
        };
      } else if (postRowId) {
        if (!resolvedUrl) throw new Error('Resolved video URL is missing.');
        const videoUrl = resolvedUrl;
        const encryptionKey = getTokenEncryptionKey();
        // Instagram publishes with the account token (destination rows
        // carry none); Facebook publishes with the page token.
        const publishToken =
          targetPlatform === 'instagram'
            ? instagramAccountToken
            : destination.encrypted_destination_token
              ? await decryptToken(destination.encrypted_destination_token, encryptionKey)
              : null;
        if (!publishToken) {
          // Failed, not pending: the row stays manually retryable,
          // and reconnecting the target restores the token for a retry.
          const missingTokenMessage =
            targetPlatform === 'instagram'
              ? 'This Instagram account has no posting token. Reconnect the account and try again.'
              : 'This page has no posting token. Reconnect the page and try again.';
          await updatePostAndMirror(db, mirror.id, postRowId, {
            status: 'failed',
            error: missingTokenMessage,
            mirrorStatus: 'error',
          });
          immediatePost = {
            attempted: true,
            status: 'failed',
            sourcePostId: latest.video_id,
            publishedPostId: null,
            error: missingTokenMessage,
          };
        } else if (targetPlatform === 'instagram') {
          const publishIgReel = deps.publishInstagramReel ?? publishInstagramReel;
          try {
            const postId = await publishIgReel({
              igUserId: destination.external_destination_id,
              accessToken: publishToken,
              // accountId is optional in the schema; without it
              // there is no account row to be BISU, so default to
              // the legacy host rather than guessing.
              isBisu: parsed.data.accountId
                ? await loadInstagramAccountIsBisu(
                    db,
                    workspaceId,
                    parsed.data.accountId
                  )
                : false,
              videoUrl,
              caption,
            });
            await updatePostAndMirror(db, mirror.id, postRowId, {
              status: 'posted',
              publishedPostId: postId,
              lastPostedSourceId: latest.video_id,
              lastPostedCreateTime:
                typeof latest.create_time === 'number' ? latest.create_time : null,
              mirrorStatus: 'active',
            });
            immediatePost = {
              attempted: true,
              status: 'posted',
              sourcePostId: latest.video_id,
              publishedPostId: postId,
              error: null,
            };
          } catch (err) {
            // Instagram helpers already throw plain-language messages
            // (auth → expired); no Facebook restriction rewrite here.
            const message =
              err instanceof InstagramReelError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : 'The latest reel could not be posted.';
            await updatePostAndMirror(db, mirror.id, postRowId, {
              status: 'failed',
              error: message,
              mirrorStatus: 'error',
            });
            immediatePost = {
              attempted: true,
              status: 'failed',
              sourcePostId: latest.video_id,
              publishedPostId: null,
              error: message,
            };
          }
        } else {
          const publishReel = deps.publishReel ?? publishFacebookReel;
          try {
            const postId = await publishReel({
              pageId: destination.external_destination_id,
              pageToken: publishToken,
              videoUrl,
              caption,
            });
            await updatePostAndMirror(db, mirror.id, postRowId, {
              status: 'posted',
              publishedPostId: postId,
              lastPostedSourceId: latest.video_id,
              lastPostedCreateTime:
                typeof latest.create_time === 'number' ? latest.create_time : null,
              mirrorStatus: 'active',
            });
            immediatePost = {
              attempted: true,
              status: 'posted',
              sourcePostId: latest.video_id,
              publishedPostId: postId,
              error: null,
            };
          } catch (err) {
            const rawMessage =
              err instanceof FacebookReelError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : 'The latest reel could not be posted.';
            // A Facebook account restriction must never surface as
            // Facebook's raw text (it reads like our tool broke). Show
            // the approved plain-language message; the raw detail stays
            // in server logs for debugging.
            const message = isFacebookAccountRestricted(err)
              ? MIRROR_FACEBOOK_RESTRICTED_MESSAGE
              : rawMessage;
            if (message !== rawMessage) {
              logServerError('[tiktok-mirrors] Immediate post restricted by Facebook', err, {
                source: 'tiktok-mirrors-create',
                subdomain,
                mirrorId: mirror.id,
              });
            }
            await updatePostAndMirror(db, mirror.id, postRowId, {
              status: 'failed',
              error: message,
              mirrorStatus: 'error',
            });
            immediatePost = {
              attempted: true,
              status: 'failed',
              sourcePostId: latest.video_id,
              publishedPostId: null,
              error: message,
            };
          }
        }
      } else {
        // Claimed by a concurrent create: nothing to post here.
        immediatePost = {
          attempted: false,
          status: null,
          sourcePostId: latest.video_id,
          publishedPostId: null,
          error: null,
        };
      }
    }

    // The immediate post may have flipped the mirror status and the
    // last-post row; reload both so the response reflects the outcome.
    const reloaded = await reloadMirror(db, mirror.id);
    const finalPosts = await loadLastPostsByMirror(db, [mirror.id]);
    const finalViewWithPost = toMirrorView(
      reloaded ?? mirror,
      destination,
      finalPosts.get(mirror.id) ?? null
    );
    const responseParsed = CreateMirrorResponseSchema.safeParse({
      mirror: finalViewWithPost,
      immediatePost,
    });
    if (!responseParsed.success) {
      logServerError('[tiktok-mirrors] Create response failed validation', responseParsed.error, {
        source: 'tiktok-mirrors-create',
        subdomain,
      });
      return NextResponse.json({ error: 'Failed to create TikTok mirror' }, { status: 500 });
    }
    // Analytics: the mirror row landed (the immediate post may still
    // have failed — that outcome lives on the mirror, not here).
    // Fire-and-forget — never blocks the response.
    void trackServerEvent('mirror_created', session.userId, {
      source_platform: 'tiktok',
      target_platform: 'facebook',
    });

    return NextResponse.json(responseParsed.data, { status: 201 });
  } catch (err) {
    logServerError('[tiktok-mirrors] Create failed', err, {
      source: 'tiktok-mirrors-create',
      subdomain,
    });
    return NextResponse.json({ error: 'Failed to create TikTok mirror' }, { status: 500 });
  }
}

export async function updatePostAndMirror(
  db: Db,
  mirrorId: string,
  postRowId: string,
  update: {
    status: string;
    publishedPostId?: string;
    error?: string;
    lastPostedSourceId?: string;
    lastPostedCreateTime?: number | null;
    mirrorStatus: string;
  }
): Promise<void> {
  if (isLegacyClient(db)) {
    await db.query(
      `UPDATE mirror_posts SET status = $2, published_post_id = $3, error = $4 WHERE id = $1`,
      [postRowId, update.status, update.publishedPostId ?? null, update.error ?? null]
    );
    if (update.lastPostedSourceId) {
      await db.query(
        `UPDATE mirrors SET status = $2, last_posted_source_id = $3,
           last_posted_create_time = $4, last_error = $5, updated_at = now() WHERE id = $1`,
        [
          mirrorId,
          update.mirrorStatus,
          update.lastPostedSourceId,
          update.lastPostedCreateTime ?? null,
          update.mirrorStatus === 'error' ? (update.error ?? null) : null,
        ]
      );
    } else {
      await db.query(
        `UPDATE mirrors SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`,
        [mirrorId, update.mirrorStatus, update.mirrorStatus === 'error' ? (update.error ?? null) : null]
      );
    }
    return;
  }
  const supabase = db as SupabaseClient;
  const { error: postError } = await supabase
    .from('mirror_posts')
    .update({
      status: update.status,
      published_post_id: update.publishedPostId ?? null,
      error: update.error ?? null,
    })
    .eq('id', postRowId);
  if (postError) throw new Error(`Failed to update mirror post: ${postError.message}`);
  const mirrorUpdate: Record<string, unknown> = {
    status: update.mirrorStatus,
    last_error: update.mirrorStatus === 'error' ? (update.error ?? null) : null,
  };
  if (update.lastPostedSourceId) {
    mirrorUpdate.last_posted_source_id = update.lastPostedSourceId;
    mirrorUpdate.last_posted_create_time = update.lastPostedCreateTime ?? null;
  }
  const { error: mirrorError } = await supabase
    .from('mirrors')
    .update(mirrorUpdate)
    .eq('id', mirrorId);
  if (mirrorError) throw new Error(`Failed to update mirror: ${mirrorError.message}`);
}

export async function reloadMirror(db: Db, mirrorId: string): Promise<MirrorRow | null> {
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT id, workspace_id, source_platform, source_username, source_display_name,
              source_avatar_url, target_platform, target_external_id, target_display_name,
              target_avatar_url, status, catch_up_pending, last_posted_source_id, last_posted_create_time,
              last_checked_at, next_check_at, last_error, fb_status, fb_rate_limited_at, created_at, updated_at
       FROM mirrors WHERE id = $1 LIMIT 1`,
      [mirrorId]
    )) as unknown[];
    return asMirrorRow(rows[0]);
  }
  const supabase = db as SupabaseClient;
  const { data, error } = await supabase
    .from('mirrors')
    .select(
      'id, workspace_id, source_platform, source_username, source_display_name, source_avatar_url, target_platform, target_external_id, target_display_name, target_avatar_url, status, catch_up_pending, last_posted_source_id, last_posted_create_time, last_checked_at, next_check_at, last_error, fb_status, fb_rate_limited_at, created_at, updated_at'
    )
    .eq('id', mirrorId)
    .maybeSingle();
  if (error) throw new Error(`Failed to reload mirror: ${error.message}`);
  return asMirrorRow(data);
}

export type MirrorFbStatusFilter = 'active' | 'paused' | 'error' | MirrorFbStatus;

/**
 * Spec 155: normalizes the ?fbStatus= list filter. Valid values are
 * the three coarse mirror statuses plus the nine Facebook detail
 * statuses; anything else (including the empty string) means "no
 * filter" — the Pages detail-filter pattern (unknown -> null).
 * Instagram-target mirrors are NOT filtered out by a detail value:
 * they simply never match it (their fb_status is always null).
 */
export function normalizeMirrorFbStatus(value: string | null): MirrorFbStatusFilter | null {
  if (value === 'active' || value === 'paused' || value === 'error') return value;
  if (value !== null && (MIRROR_FB_STATUSES as readonly string[]).includes(value)) {
    return value as MirrorFbStatus;
  }
  return null;
}

/**
 * Spec 155: the legacy-SQL fragment for the fbStatus filter.
 * Coarse values match `mirrors.status`; a detail value matches an
 * error mirror carrying exactly that `fb_status`. The filter matches
 * the STORED state: a rate-limited mirror whose anchor just went
 * stale still filters as rate-limited until the tick clears it
 * (hourly) — the display applies the stale-anchor rule, the filter
 * does not. Mirrors showing a target-inherited detail (error, no
 * own fb_status) match `error`, not the inherited detail value —
 * the inheritance is a display rule, not a stored one.
 */
export function buildMirrorFbStatusSqlCondition(
  filter: MirrorFbStatusFilter | null,
  pushParam: (value: unknown) => string
): string | null {
  if (filter === null) return null;
  if (filter === 'active' || filter === 'paused' || filter === 'error') {
    return `status = ${pushParam(filter)}`;
  }
  return `status = 'error' AND fb_status = ${pushParam(filter)}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await params;
  return handleListMirrors(request, subdomain);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await params;
  return handleCreateMirror(request, subdomain);
}
