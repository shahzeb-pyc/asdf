import { type NextRequest, NextResponse } from 'next/server';
import {
  CreateMirrorRequestSchema,
  CreateMirrorResponseSchema,
  decryptToken,
  getTokenEncryptionKey,
  ListMirrorsResponseSchema,
  selectLatestReel,
  validateThreadsText,
  type MirrorView,
} from '@fbuploadpro/contracts';
import {
  authenticateTenantRoute,
  getRouteSupabase,
  isLegacyClient,
} from '@/lib/route-auth';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import {
  paginateMeta,
  parsePaginationParams,
  type PaginationMeta,
} from '@/lib/server/pagination';
import { logServerError } from '@/lib/server-analytics';
import {
  buildTikwmPauseStore,
  fetchTikwmUserInfo,
  fetchTikwmUserPosts,
  getTikwmApiKeys,
  resolveTikwmVideo,
  TikwmError,
} from '@/lib/server/tikwm';
import {
  publishThreadsVideo,
  ThreadsVideoError,
} from '@/lib/server/threads-video';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Threads Auto Repost — list + create (TikTok → Threads).
 *
 * Same mirror semantics as Facebook Auto Repost, with a Threads
 * target: one mirror row per (TikTok username, Threads account),
 * feed verified before anything is created, the current latest reel
 * posted immediately on setup, and hourly ticks thereafter (the
 * worker's existing dispatcher + mirror_check_jobs queue, which
 * already scans every mirror and now dispatches Threads targets to
 * the Threads publisher).
 *
 * The target is a connected Threads account from the Threads
 * Accounts section: its `destinations` row (platform='threads')
 * already exists from the connect flow. Creating a mirror NEVER
 * creates a destination row and NEVER adds anything to Schedule —
 * Schedule is a separate section the user manages themselves.
 * No migration is needed: `mirrors` / `mirror_posts` /
 * `mirror_check_jobs` are platform-agnostic (target_platform is
 * plain text), and this route only ever reads or writes rows with
 * target_platform='threads'.
 *
 * Supabase path only (the same precedent as the Threads accounts
 * route): a legacy client is rejected loudly rather than served
 * by a second, untested code path.
 */

type Db = SupabaseClient;

export interface ThreadsDestinationRow {
  id: string;
  account_id: string;
  external_destination_id: string;
  name: string;
  avatar_url: string | null;
  encrypted_destination_token: string | null;
  status: string;
}

interface MirrorRow {
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
  last_checked_at: string | null;
  next_check_at: string | null;
  last_error: string | null;
  created_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asMirrorRow(row: unknown): MirrorRow | null {
  if (!isRecord(row)) return null;
  const id = row.id;
  const workspaceId = row.workspace_id;
  const sourceUsername = row.source_username;
  const targetExternalId = row.target_external_id;
  const targetDisplayName = row.target_display_name;
  if (
    typeof id !== 'string' ||
    typeof workspaceId !== 'string' ||
    typeof sourceUsername !== 'string' ||
    typeof targetExternalId !== 'string' ||
    typeof targetDisplayName !== 'string'
  ) {
    return null;
  }
  return {
    id,
    workspace_id: workspaceId,
    source_platform: typeof row.source_platform === 'string' ? row.source_platform : 'tiktok',
    source_username: sourceUsername,
    source_display_name: typeof row.source_display_name === 'string' ? row.source_display_name : null,
    source_avatar_url: typeof row.source_avatar_url === 'string' ? row.source_avatar_url : null,
    target_platform: typeof row.target_platform === 'string' ? row.target_platform : 'threads',
    target_external_id: targetExternalId,
    target_display_name: targetDisplayName,
    target_avatar_url: typeof row.target_avatar_url === 'string' ? row.target_avatar_url : null,
    status: typeof row.status === 'string' ? row.status : 'active',
    last_posted_source_id: typeof row.last_posted_source_id === 'string' ? row.last_posted_source_id : null,
    last_checked_at: typeof row.last_checked_at === 'string' ? row.last_checked_at : null,
    next_check_at: typeof row.next_check_at === 'string' ? row.next_check_at : null,
    last_error: typeof row.last_error === 'string' ? row.last_error : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : '',
  };
}

function asDestinationRow(row: unknown): ThreadsDestinationRow | null {
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
      typeof row.encrypted_destination_token === 'string' ? row.encrypted_destination_token : null,
    status: typeof row.status === 'string' ? row.status : 'active',
  };
}

function toMirrorView(
  mirror: MirrorRow,
  destination: ThreadsDestinationRow | null,
  lastPost: {
    id: string;
    source_post_id: string;
    caption: string;
    cover_url: string | null;
    status: string;
    published_post_id: string | null;
    created_at: string;
  } | null
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
    status: mirror.status as MirrorView['status'],
    lastPostedSourceId: mirror.last_posted_source_id,
    lastCheckedAt: mirror.last_checked_at,
    nextCheckAt: mirror.next_check_at,
    lastError: mirror.last_error,
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

async function authenticate(
  request: NextRequest,
  subdomain: string,
  dbClient?: Db
): Promise<
  | { db: Db; workspaceId: string; errorResponse?: never }
  | { db?: never; workspaceId?: never; errorResponse: NextResponse }
> {
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return { errorResponse: auth.errorResponse };
  const session = auth.session;
  const db = dbClient ?? getRouteSupabase();
  if (!db) {
    return {
      errorResponse: NextResponse.json({ error: 'Database service unavailable' }, { status: 500 }),
    };
  }
  if (isLegacyClient(db as never)) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Threads Auto Repost requires the current database client' },
        { status: 500 }
      ),
    };
  }
  const workspaceId = await resolveTenantWorkspaceId(db, subdomain, session.userId, session.role);
  if (!workspaceId) {
    return { errorResponse: NextResponse.json({ error: 'Workspace not found' }, { status: 404 }) };
  }
  return { db: db as Db, workspaceId };
}

const MIRROR_COLUMNS =
  'id, workspace_id, source_platform, source_username, source_display_name, source_avatar_url, target_platform, target_external_id, target_display_name, target_avatar_url, status, catch_up_pending, last_posted_source_id, last_posted_create_time, last_checked_at, next_check_at, last_error, created_at, updated_at';

export async function handleListThreadsMirrors(
  request: NextRequest,
  subdomain: string,
  dbClient?: Db
): Promise<NextResponse> {
  const auth = await authenticate(request, subdomain, dbClient);
  if (auth.errorResponse) return auth.errorResponse;
  const { db, workspaceId } = auth;

  try {
    const { page: requestedPage, limit } = parsePaginationParams(
      new URL(request.url).searchParams
    );
    const { count, error: countError } = await db
      .from('mirrors')
      .select('*', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('source_platform', 'tiktok')
      .eq('target_platform', 'threads');
    if (countError) throw new Error(`Failed to count mirrors: ${countError.message}`);
    const meta: PaginationMeta = paginateMeta(typeof count === 'number' ? count : 0, requestedPage, limit);
    const offset = (meta.page - 1) * limit;
    const { data, error } = await db
      .from('mirrors')
      .select(MIRROR_COLUMNS)
      .eq('workspace_id', workspaceId)
      .eq('source_platform', 'tiktok')
      .eq('target_platform', 'threads')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw new Error(`Failed to list mirrors: ${error.message}`);
    const mirrors: MirrorRow[] = [];
    for (const row of data ?? []) {
      const mirror = asMirrorRow(row);
      if (mirror) mirrors.push(mirror);
    }

    // Batch lookups run over the page slice only (at most one page
    // of mirrors), never the full set — PostgREST silently truncates
    // an unbounded select at 1,000 rows.
    const externalIds = [...new Set(mirrors.map((m) => m.target_external_id))];
    const destinations = new Map<string, ThreadsDestinationRow>();
    if (externalIds.length > 0) {
      const { data: destData, error: destError } = await db
        .from('destinations')
        .select('id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status')
        .eq('workspace_id', workspaceId)
        .eq('platform', 'threads')
        .in('external_destination_id', externalIds);
      if (destError) throw new Error(`Failed to load destinations: ${destError.message}`);
      const ordered = (destData ?? []).slice().sort((a, b) => {
        const ra = a as Record<string, unknown>;
        const rb = b as Record<string, unknown>;
        return (ra.status === 'active' ? 0 : 1) - (rb.status === 'active' ? 0 : 1);
      });
      for (const row of ordered) {
        const dest = asDestinationRow(row);
        if (dest && !destinations.has(dest.external_destination_id)) {
          destinations.set(dest.external_destination_id, dest);
        }
      }
    }

    const views: MirrorView[] = [];
    for (const mirror of mirrors) {
      const { data: postData, error: postError } = await db
        .from('mirror_posts')
        .select('id, source_post_id, caption, cover_url, status, published_post_id, created_at')
        .eq('mirror_id', mirror.id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (postError) throw new Error(`Failed to load mirror posts: ${postError.message}`);
      const first = (postData ?? [])[0] as Record<string, unknown> | undefined;
      const lastPost =
        first && typeof first.id === 'string' && typeof first.source_post_id === 'string'
          ? {
              id: first.id,
              source_post_id: first.source_post_id,
              caption: typeof first.caption === 'string' ? first.caption : '',
              cover_url: typeof first.cover_url === 'string' ? first.cover_url : null,
              status: typeof first.status === 'string' ? first.status : 'pending',
              published_post_id:
                typeof first.published_post_id === 'string' ? first.published_post_id : null,
              created_at: typeof first.created_at === 'string' ? first.created_at : '',
            }
          : null;
      views.push(toMirrorView(mirror, destinations.get(mirror.target_external_id) ?? null, lastPost));
    }

    const parsed = ListMirrorsResponseSchema.safeParse({
      mirrors: views,
      total: meta.total,
      page: meta.page,
      limit: meta.limit,
      totalPages: meta.totalPages,
    });
    if (!parsed.success) {
      logServerError('[threads-auto-repost] List response failed validation', parsed.error, {
        source: 'threads-auto-repost-list',
        subdomain,
      });
      return NextResponse.json({ error: 'Failed to load Threads mirrors' }, { status: 500 });
    }
    return NextResponse.json(parsed.data);
  } catch (err) {
    logServerError('[threads-auto-repost] List failed', err, {
      source: 'threads-auto-repost-list',
      subdomain,
    });
    return NextResponse.json({ error: 'Failed to load Threads mirrors' }, { status: 500 });
  }
}

export interface CreateThreadsMirrorDeps {
  fetchTikwmPosts?: typeof fetchTikwmUserPosts;
  fetchTikwmInfo?: typeof fetchTikwmUserInfo;
  resolveTikwmVideo?: typeof resolveTikwmVideo;
  publishThreadsVideo?: typeof publishThreadsVideo;
}

async function resolveThreadsDestination(
  db: Db,
  workspaceId: string,
  input: {
    targetDestinationId?: string | undefined;
    accountId?: string | undefined;
    targetExternalId?: string | undefined;
  }
): Promise<{ destination: ThreadsDestinationRow } | { error: NextResponse }> {
  const notReady = NextResponse.json(
    {
      error: 'THREADS_TARGET_NOT_READY',
      message: 'That Threads account is not ready for posting. Reconnect it in Accounts.',
    },
    { status: 404 }
  );
  if (input.targetDestinationId) {
    const { data, error } = await db
      .from('destinations')
      .select('id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status')
      .eq('id', input.targetDestinationId)
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .maybeSingle();
    if (error) throw new Error(`Failed to load destination: ${error.message}`);
    const dest = asDestinationRow(data);
    if (!dest) return { error: notReady };
    return { destination: dest };
  }
  const accountId = input.accountId as string;
  const targetExternalId = input.targetExternalId as string;
  // The account must be a connected Threads account in this workspace.
  const { data: account, error: accountError } = await db
    .from('social_accounts')
    .select('id')
    .eq('id', accountId)
    .eq('workspace_id', workspaceId)
    .eq('platform', 'threads')
    .maybeSingle();
  if (accountError) throw new Error(`Failed to load account: ${accountError.message}`);
  if (!account) return { error: notReady };
  const { data, error } = await db
    .from('destinations')
    .select('id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status')
    .eq('account_id', accountId)
    .eq('external_destination_id', targetExternalId)
    .eq('platform', 'threads')
    .maybeSingle();
  if (error) throw new Error(`Failed to load destination: ${error.message}`);
  const dest = asDestinationRow(data);
  if (!dest) return { error: notReady };
  return { destination: dest };
}

export async function handleCreateThreadsMirror(
  request: NextRequest,
  subdomain: string,
  dbClient?: Db,
  deps: CreateThreadsMirrorDeps = {}
): Promise<NextResponse> {
  const auth = await authenticate(request, subdomain, dbClient);
  if (auth.errorResponse) return auth.errorResponse;
  const { db, workspaceId } = auth;

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
    // 1. Verify the feed with the PAID tikwmapi endpoint BEFORE
    //    creating anything: a failed feed must leave nothing behind.
    const apiKeys = getTikwmApiKeys();
    const pauseStore = buildTikwmPauseStore(db, false);
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

    // 2. Resolve the already-connected Threads target. This step
    //    never creates a destination row and never touches Schedule.
    const resolved = await resolveThreadsDestination(db, workspaceId, {
      targetDestinationId: parsed.data.targetDestinationId,
      accountId: parsed.data.accountId,
      targetExternalId: parsed.data.targetExternalId,
    });
    if ('error' in resolved) return resolved.error;
    const destination = resolved.destination;

    // 3. Exact-duplicate block (same username + same Threads account).
    const { data: dupData, error: dupError } = await db
      .from('mirrors')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('source_platform', 'tiktok')
      .eq('source_username', username)
      .eq('target_platform', 'threads')
      .eq('target_external_id', destination.external_destination_id)
      .limit(1);
    if (dupError) throw new Error(`Failed to check duplicates: ${dupError.message}`);
    if ((dupData ?? []).length > 0) {
      return NextResponse.json(
        {
          error: 'DUPLICATE_MIRROR',
          message: 'This TikTok account is already reposted to this Threads account.',
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

    // 5. Create the mirror row (generic target reference: platform +
    //    external id + display copies; no destination foreign key).
    const { data: mirrorData, error: mirrorError } = await db
      .from('mirrors')
      .insert({
        workspace_id: workspaceId,
        source_platform: 'tiktok',
        source_username: username,
        source_display_name: displayName,
        source_avatar_url: avatarUrl,
        target_platform: 'threads',
        target_external_id: destination.external_destination_id,
        target_display_name: destination.name,
        target_avatar_url: destination.avatar_url,
        status: 'active',
        last_checked_at: new Date().toISOString(),
        next_check_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .select(MIRROR_COLUMNS)
      .single();
    if (mirrorError) throw new Error(`Failed to create mirror: ${mirrorError.message}`);
    const mirror = asMirrorRow(mirrorData);
    if (!mirror) throw new Error('Failed to create mirror');

    // 6. Immediate post of the current latest reel: resolve it via
    //    the FREE tikwm endpoint, then publish to Threads. Any
    //    failure leaves the post pending and the mirror in error —
    //    never silently dropped, and the mirror is not deleted.
    const latest = selectLatestReel(videos);
    let immediatePost: {
      attempted: boolean;
      status: 'posted' | 'failed' | 'skipped' | 'pending' | null;
      sourcePostId: string | null;
      publishedPostId: string | null;
      error: string | null;
    } = { attempted: false, status: null, sourcePostId: null, publishedPostId: null, error: null };

    if (latest && latest.play) {
      let caption = latest.title ?? '';
      const sourceCreatedAt =
        typeof latest.create_time === 'number'
          ? new Date(latest.create_time * 1000).toISOString()
          : null;
      const captionError = validateThreadsText(caption);
      if (captionError) {
        // Over-long Threads caption: skipped with the plain reason,
        // never truncated. Later reels are still tried by the tick.
        const { error: skipError } = await db.from('mirror_posts').insert({
          mirror_id: mirror.id,
          source_post_id: latest.video_id,
          caption,
          video_url: null,
          cover_url: latest.cover ?? null,
          source_created_at: sourceCreatedAt,
          status: 'skipped',
          error: captionError,
        });
        if (skipError && skipError.code !== '23505') {
          throw new Error(`Failed to record skipped reel: ${skipError.message}`);
        }
        await db
          .from('mirrors')
          .update({ status: 'error', last_error: captionError })
          .eq('id', mirror.id);
        immediatePost = {
          attempted: true,
          status: 'skipped',
          sourcePostId: latest.video_id,
          publishedPostId: null,
          error: captionError,
        };
      } else {
        let resolvedUrl: string | null = null;
        let resolveError: string | null = null;
        try {
          const resolveVideo = deps.resolveTikwmVideo ?? resolveTikwmVideo;
          const resolved = await resolveVideo(
            `https://www.tiktok.com/@${username}/video/${latest.video_id}`
          );
          resolvedUrl = resolved.playUrl;
          // Resolved title is verbatim; fall back to the feed title.
          if (resolved.title) caption = resolved.title;
        } catch (err) {
          resolveError = err instanceof Error ? err.message : 'The latest reel could not be resolved.';
        }
        if (!resolvedUrl) {
          const { error: claimError } = await db.from('mirror_posts').insert({
            mirror_id: mirror.id,
            source_post_id: latest.video_id,
            caption,
            video_url: null,
            cover_url: latest.cover ?? null,
            source_created_at: sourceCreatedAt,
            status: 'pending',
            error: resolveError,
          });
          if (claimError && claimError.code !== '23505') {
            throw new Error(`Failed to claim latest reel: ${claimError.message}`);
          }
          await db
            .from('mirrors')
            .update({ status: 'error', last_error: resolveError })
            .eq('id', mirror.id);
          immediatePost = {
            attempted: true,
            status: 'pending',
            sourcePostId: latest.video_id,
            publishedPostId: null,
            error: resolveError,
          };
        } else {
          // Claim BEFORE publishing: the unique constraint means an
          // overlapping tick can never double-post this reel.
          const { data: postData, error: claimError } = await db
            .from('mirror_posts')
            .insert({
              mirror_id: mirror.id,
              source_post_id: latest.video_id,
              caption,
              video_url: resolvedUrl,
              cover_url: latest.cover ?? null,
              source_created_at: sourceCreatedAt,
              status: 'pending',
            })
            .select('id')
            .single();
          if (claimError && claimError.code !== '23505') {
            throw new Error(`Failed to claim latest reel: ${claimError.message}`);
          }
          const postId = (postData as { id?: unknown } | null)?.id;
          if (typeof postId === 'string') {
            const encryptionKey = getTokenEncryptionKey();
            const accessToken = destination.encrypted_destination_token
              ? await decryptToken(destination.encrypted_destination_token, encryptionKey)
              : null;
            if (!accessToken) {
              const message = 'This Threads account has no posting token. Reconnect it in Accounts.';
              await db
                .from('mirror_posts')
                .update({ error: message })
                .eq('id', postId);
              await db
                .from('mirrors')
                .update({ status: 'error', last_error: message })
                .eq('id', mirror.id);
              immediatePost = {
                attempted: true,
                status: 'pending',
                sourcePostId: latest.video_id,
                publishedPostId: null,
                error: message,
              };
            } else {
              try {
                const publish = deps.publishThreadsVideo ?? publishThreadsVideo;
                const publishedId = await publish({
                  threadsUserId: destination.external_destination_id,
                  accessToken,
                  videoUrl: resolvedUrl,
                  caption,
                });
                await db
                  .from('mirror_posts')
                  .update({ status: 'posted', published_post_id: publishedId, error: null })
                  .eq('id', postId);
                await db
                  .from('mirrors')
                  .update({
                    last_posted_source_id: latest.video_id,
                    last_posted_create_time:
                      typeof latest.create_time === 'number' ? latest.create_time : null,
                    last_error: null,
                  })
                  .eq('id', mirror.id);
                immediatePost = {
                  attempted: true,
                  status: 'posted',
                  sourcePostId: latest.video_id,
                  publishedPostId: publishedId,
                  error: null,
                };
              } catch (err) {
                const message =
                  err instanceof ThreadsVideoError
                    ? err.message
                    : err instanceof Error
                      ? err.message
                      : 'The latest reel could not be posted to Threads.';
                // A resolved title that exceeds Threads' caption cap
                // is a skip (never a truncation), not a retryable
                // pending post — the tick applies the same rule.
                const isCaptionSkip =
                  err instanceof ThreadsVideoError && err.step === 'caption';
                if (isCaptionSkip) {
                  await db
                    .from('mirror_posts')
                    .update({ status: 'skipped', error: message })
                    .eq('id', postId);
                } else {
                  await db
                    .from('mirror_posts')
                    .update({ error: message })
                    .eq('id', postId);
                }
                await db
                  .from('mirrors')
                  .update({ status: 'error', last_error: message })
                  .eq('id', mirror.id);
                immediatePost = {
                  attempted: true,
                  status: isCaptionSkip ? 'skipped' : 'pending',
                  sourcePostId: latest.video_id,
                  publishedPostId: null,
                  error: message,
                };
              }
            }
          }
        }
      }
    }

    const view = toMirrorView(mirror, destination, null);
    const parsedResponse = CreateMirrorResponseSchema.safeParse({ mirror: view, immediatePost });
    if (!parsedResponse.success) {
      logServerError('[threads-auto-repost] Create response failed validation', parsedResponse.error, {
        source: 'threads-auto-repost-create',
        subdomain,
      });
      return NextResponse.json({ error: 'Failed to add Threads mirror' }, { status: 500 });
    }
    return NextResponse.json(parsedResponse.data);
  } catch (err) {
    logServerError('[threads-auto-repost] Create failed', err, {
      source: 'threads-auto-repost-create',
      subdomain,
    });
    return NextResponse.json({ error: 'Failed to add Threads mirror' }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await params;
  return handleListThreadsMirrors(request, subdomain);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await params;
  return handleCreateThreadsMirror(request, subdomain);
}
