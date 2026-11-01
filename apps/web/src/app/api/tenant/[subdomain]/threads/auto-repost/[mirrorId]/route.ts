import { type NextRequest, NextResponse } from 'next/server';
import {
  DeleteMirrorResponseSchema,
  MirrorDetailResponseSchema,
  UpdateMirrorRequestSchema,
  type MirrorView,
} from '@fbuploadpro/contracts';
import {
  authenticateTenantRoute,
  getRouteSupabase,
  isLegacyClient,
} from '@/lib/route-auth';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { releaseUsageForFeature } from '@/lib/billing/entitlement';
import { logServerError } from '@/lib/server-analytics';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Threads Auto Repost detail — GET (mirror + recent posts), PATCH
 * (pause / resume), DELETE (mirror + its posts). Threads-only: a
 * mirror whose target_platform is not 'threads' 404s here, exactly
 * as a Facebook mirror 404s in the Facebook detail route.
 *
 * Supabase path only (same precedent as the Threads accounts route).
 * Pause stops new posts; resume re-arms the next hourly check and
 * arms the tick's catch-up rule (first tick after resume posts only
 * the newest reel). Delete removes posts first, then the mirror.
 */

type Db = SupabaseClient;

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

const MIRROR_COLUMNS =
  'id, workspace_id, source_platform, source_username, source_display_name, source_avatar_url, target_platform, target_external_id, target_display_name, target_avatar_url, status, catch_up_pending, last_posted_source_id, last_posted_create_time, last_checked_at, next_check_at, last_error, created_at, updated_at';

async function authenticate(
  request: NextRequest,
  subdomain: string,
  dbClient?: Db
): Promise<
  | { db: Db; workspaceId: string; session: { userId: string; role: string }; errorResponse?: never }
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
  return { db: db as Db, workspaceId, session };
}

async function loadMirror(
  db: Db,
  workspaceId: string,
  mirrorId: string
): Promise<MirrorRow | null> {
  const { data, error } = await db
    .from('mirrors')
    .select(MIRROR_COLUMNS)
    .eq('id', mirrorId)
    .eq('workspace_id', workspaceId)
    .eq('target_platform', 'threads')
    .maybeSingle();
  if (error) throw new Error(`Failed to load mirror: ${error.message}`);
  return asMirrorRow(data);
}

export async function handleGetThreadsMirror(
  request: NextRequest,
  subdomain: string,
  mirrorId: string,
  dbClient?: Db
): Promise<NextResponse> {
  const auth = await authenticate(request, subdomain, dbClient);
  if (auth.errorResponse) return auth.errorResponse;
  const { db, workspaceId } = auth;

  try {
    const mirror = await loadMirror(db, workspaceId, mirrorId);
    if (!mirror) {
      return NextResponse.json({ error: 'TikTok mirror not found' }, { status: 404 });
    }
    const { data: destData, error: destError } = await db
      .from('destinations')
      .select('id, account_id, external_destination_id, name, avatar_url, encrypted_destination_token, status')
      .eq('workspace_id', workspaceId)
      .eq('platform', 'threads')
      .eq('external_destination_id', mirror.target_external_id)
      .maybeSingle();
    if (destError) throw new Error(`Failed to load destination: ${destError.message}`);
    const dest = destData as Record<string, unknown> | null;
    const { data: postData, error: postError } = await db
      .from('mirror_posts')
      .select(
        'id, mirror_id, source_post_id, caption, video_url, cover_url, source_created_at, status, published_post_id, error, created_at'
      )
      .eq('mirror_id', mirrorId)
      .order('created_at', { ascending: false })
      .limit(30);
    if (postError) throw new Error(`Failed to load mirror posts: ${postError.message}`);
    const posts = postData ?? [];
    const first = posts[0] as Record<string, unknown> | undefined;
    const lastPost =
      first && typeof first.id === 'string' && typeof first.source_post_id === 'string'
        ? {
            id: first.id,
            source_post_id: first.source_post_id,
            caption: typeof first.caption === 'string' ? first.caption : '',
            cover_url: typeof first.cover_url === 'string' ? first.cover_url : null,
            status: typeof first.status === 'string' ? first.status : 'pending',
            published_post_id: typeof first.published_post_id === 'string' ? first.published_post_id : null,
            created_at: typeof first.created_at === 'string' ? first.created_at : '',
          }
        : null;
    const view: MirrorView = {
      id: mirror.id,
      sourcePlatform: mirror.source_platform,
      sourceUsername: mirror.source_username,
      sourceDisplayName: mirror.source_display_name,
      sourceAvatarUrl: mirror.source_avatar_url,
      targetPlatform: mirror.target_platform,
      targetExternalId: mirror.target_external_id,
      targetDisplayName:
        typeof dest?.name === 'string' ? dest.name : mirror.target_display_name,
      targetAvatarUrl:
        typeof dest?.avatar_url === 'string' ? dest.avatar_url : mirror.target_avatar_url,
      targetDestinationId: typeof dest?.id === 'string' ? dest.id : null,
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
    const parsed = MirrorDetailResponseSchema.safeParse({ mirror: view, posts });
    if (!parsed.success) {
      logServerError('[threads-auto-repost] Detail response failed validation', parsed.error, {
        source: 'threads-auto-repost-detail',
        subdomain,
      });
      return NextResponse.json({ error: 'Failed to load TikTok mirror' }, { status: 500 });
    }
    return NextResponse.json(parsed.data);
  } catch (err) {
    logServerError('[threads-auto-repost] Detail failed', err, {
      source: 'threads-auto-repost-detail',
      subdomain,
    });
    return NextResponse.json({ error: 'Failed to load TikTok mirror' }, { status: 500 });
  }
}

export async function handleUpdateThreadsMirror(
  request: NextRequest,
  subdomain: string,
  mirrorId: string,
  dbClient?: Db
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
  const parsed = UpdateMirrorRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const mirror = await loadMirror(db, workspaceId, mirrorId);
    if (!mirror) {
      return NextResponse.json({ error: 'TikTok mirror not found' }, { status: 404 });
    }
    const nextCheckAt =
      parsed.data.status === 'active'
        ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
        : null;
    const isResume = mirror.status === 'paused' && parsed.data.status === 'active';
    const { error } = await db
      .from('mirrors')
      .update(
        isResume
          ? { status: parsed.data.status, next_check_at: nextCheckAt, catch_up_pending: true }
          : { status: parsed.data.status, next_check_at: nextCheckAt }
      )
      .eq('id', mirrorId)
      .eq('workspace_id', workspaceId);
    if (error) throw new Error(`Failed to update mirror: ${error.message}`);
    return NextResponse.json({ ok: true, status: parsed.data.status });
  } catch (err) {
    logServerError('[threads-auto-repost] Update failed', err, {
      source: 'threads-auto-repost-update',
      subdomain,
    });
    return NextResponse.json({ error: 'Failed to update TikTok mirror' }, { status: 500 });
  }
}

export async function handleDeleteThreadsMirror(
  request: NextRequest,
  subdomain: string,
  mirrorId: string,
  dbClient?: Db
): Promise<NextResponse> {
  const auth = await authenticate(request, subdomain, dbClient);
  if (auth.errorResponse) return auth.errorResponse;
  const { db, workspaceId } = auth;

  try {
    const mirror = await loadMirror(db, workspaceId, mirrorId);
    if (!mirror) {
      return NextResponse.json({ error: 'TikTok mirror not found' }, { status: 404 });
    }
    await db.from('mirror_posts').delete().eq('mirror_id', mirrorId);
    const { error } = await db
      .from('mirrors')
      .delete()
      .eq('id', mirrorId)
      .eq('workspace_id', workspaceId);
    if (error) throw new Error(`Failed to delete mirror: ${error.message}`);
    // Cap-at-add release (audit fix 2026-11-01): deleting the
    // mirror frees its unit when the registry row still carries
    // the auto-repost feature. Best-effort — the delete already
    // succeeded. Admins never registered, so they never release.
    if (auth.session.role !== 'admin') {
      const billingClient = getBillingAdminClient();
      if (!billingClient) {
        logServerError('[billing] auto-repost usage release skipped: no billing client', null, {
          source: 'billing',
        });
      } else {
        try {
          await releaseUsageForFeature(
            billingClient,
            auth.session.userId,
            'threads',
            mirror.target_external_id,
            'auto-repost'
          );
        } catch (releaseError) {
          logServerError('[billing] auto-repost usage release failed', releaseError, {
            source: 'billing',
          });
        }
      }
    }
    const parsed = DeleteMirrorResponseSchema.safeParse({ deleted: true });
    return NextResponse.json(parsed.data);
  } catch (err) {
    logServerError('[threads-auto-repost] Delete failed', err, {
      source: 'threads-auto-repost-delete',
      subdomain,
    });
    return NextResponse.json({ error: 'Failed to delete TikTok mirror' }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; mirrorId: string }> }
): Promise<NextResponse> {
  const { subdomain, mirrorId } = await params;
  return handleGetThreadsMirror(request, subdomain, mirrorId);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; mirrorId: string }> }
): Promise<NextResponse> {
  const { subdomain, mirrorId } = await params;
  return handleUpdateThreadsMirror(request, subdomain, mirrorId);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; mirrorId: string }> }
): Promise<NextResponse> {
  const { subdomain, mirrorId } = await params;
  return handleDeleteThreadsMirror(request, subdomain, mirrorId);
}
