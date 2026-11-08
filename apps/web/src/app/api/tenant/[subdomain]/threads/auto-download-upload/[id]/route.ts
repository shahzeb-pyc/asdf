import { type NextRequest, NextResponse } from 'next/server';
import {
  AduUpdateConfigSchema,
  generateDailyRandomTimes,
  sanitizeSourceIdentity,
} from '@fbuploadpro/contracts';
import {
  loadThreadsAduConfigView,
  loadThreadsAduDestination,
  threadsAduContext,
} from '@/lib/server/threads-adu';
import { releaseAduConfigUsage } from '@/lib/server/adu';
import { fetchTikwmUserPosts, TikwmError } from '@/lib/server/tikwm';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * PATCH transition guards (spec §3.3): the UI mirrors these, never the
 * other way round. `paused` is allowed from anywhere; `active` only
 * from the listed statuses; every other target status is system-set
 * and rejected.
 *
 * The fresh page-token check for page_not_accessible /
 * missing_page_access / missing_permission is a Facebook-page
 * mechanism (fetchAllFacebookPages over the linked Facebook
 * account): a Threads destination has no Facebook page token to
 * refresh, so toggle-ON from those statuses reactivates directly
 * here. The Facebook route runs the real check.
 */
const DIRECT_ACTIVATE_STATUSES = new Set([
  'paused',
  'fb_verification_required',
  'account_suspended',
  'check_developer_app',
  'page_not_accessible',
  'missing_page_access',
  'missing_permission',
]);

export interface ThreadsAduPatchDeps {
  /** Default: fetchTikwmUserPosts (one paid call per toggle-ON). */
  fetchCreatorPosts?: (username: string) => Promise<unknown[]>;
}

interface AduPatchCurrentRow {
  status: string;
  destination_id: string;
  source_platform: string;
  source_username: string;
}

type CreatorAvailability = 'available' | 'unavailable' | 'unknown';

/**
 * TikWM availability check for toggle-ON from creator_suspended with
 * a TikTok source. Success (an array, even empty) means the creator
 * is available. FEED_UNAVAILABLE means the creator itself is gone.
 * Any other failure is inconclusive — the check failed, not the
 * creator — so it never activates; the full detail is logged here.
 */
async function checkCreatorAvailability(
  username: string,
  configId: string,
  deps: ThreadsAduPatchDeps
): Promise<CreatorAvailability> {
  try {
    const posts = await (deps.fetchCreatorPosts ?? fetchTikwmUserPosts)(username);
    if (!Array.isArray(posts)) {
      console.error(
        `[ADU PATCH] Creator check for config ${configId} returned a non-array response — treating as inconclusive.`
      );
      return 'unknown';
    }
    return 'available';
  } catch (err) {
    if (err instanceof TikwmError && err.code === 'FEED_UNAVAILABLE') {
      return 'unavailable';
    }
    console.error(
      `[ADU PATCH] Creator check failed for config ${configId} (inconclusive — not activating):`,
      err instanceof Error ? err.message : String(err)
    );
    return 'unknown';
  }
}

/**
 * Creator-suspended reactivation resets the config's download_failed
 * reels to pending (status only — download_retries is NOT reset, open
 * item (b)). A reset failure is loud and blocks the activation: the
 * config must not read active while its reels never re-download.
 */
async function resetFailedReelsForReactivation(
  supabase: SupabaseClient,
  configId: string
): Promise<NextResponse | null> {
  const { error } = await supabase
    .from('adu_reels')
    .update({ status: 'pending' })
    .eq('config_id', configId)
    .eq('status', 'download_failed');
  if (error) {
    console.error(
      `[ADU PATCH] Failed to reset download_failed reels for config ${configId}: ${error.message}`
    );
    return NextResponse.json(
      { error: 'Could not reset the failed downloads. Try again.' },
      { status: 500 }
    );
  }
  return null;
}

/**
 * Enforces the §3.3 transition guards for a status change. Returns a
 * response when the change is rejected or a check fails; returns null
 * when the change may proceed (side effects already applied).
 */
async function guardAduStatusChange(
  supabase: SupabaseClient,
  configId: string,
  current: AduPatchCurrentRow,
  target: string,
  deps: ThreadsAduPatchDeps
): Promise<NextResponse | null> {
  if (target === 'paused') return null;
  if (target !== 'active') {
    return NextResponse.json(
      { error: 'This status is set automatically and cannot be changed here.' },
      { status: 400 }
    );
  }
  const from = current.status;
  if (from === 'active' || DIRECT_ACTIVATE_STATUSES.has(from)) return null;
  if (from === 'creator_suspended') {
    if (current.source_platform === 'tiktok') {
      const availability = await checkCreatorAvailability(
        current.source_username,
        configId,
        deps
      );
      if (availability === 'unavailable') {
        return NextResponse.json(
          { error: 'The creator still looks unavailable.' },
          { status: 400 }
        );
      }
      if (availability === 'unknown') {
        return NextResponse.json(
          { error: 'Could not verify the creator right now. Try again shortly.' },
          { status: 400 }
        );
      }
    }
    return resetFailedReelsForReactivation(supabase, configId);
  }
  if (from === 'invalid_token') {
    return NextResponse.json(
      { error: 'Reconnect your Threads account to restore access.' },
      { status: 400 }
    );
  }
  if (from === 'fb_rate_limited') {
    return NextResponse.json(
      { error: 'Posting resumes automatically after the rate-limit cooldown.' },
      { status: 400 }
    );
  }
  if (from === 'completed' || from === 'invalid_username') {
    return NextResponse.json(
      { error: 'Update the source to continue posting.' },
      { status: 400 }
    );
  }
  if (from === '2fa_required_on_BM') {
    return NextResponse.json(
      { error: 'Complete two-factor authentication, then turn automation back on.' },
      { status: 400 }
    );
  }
  return NextResponse.json(
    { error: 'Automation cannot be turned on from this status.' },
    { status: 400 }
  );
}

export async function handlePatchThreadsAduConfig(
  request: NextRequest,
  subdomain: string,
  id: string,
  deps: ThreadsAduPatchDeps = {}
): Promise<NextResponse> {
  const resolved = await threadsAduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  const scoped = await loadThreadsAduDestination(supabase, workspaceId, id);
  if (!scoped) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  const body = await request.json().catch(() => null);
  const parsed = AduUpdateConfigSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 }
    );
  }
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.status) {
    const current = scoped.config as unknown as AduPatchCurrentRow;
    const guard = await guardAduStatusChange(supabase, id, current, parsed.data.status, deps);
    if (guard) return guard;
    update.status = parsed.data.status;
  }
  if (parsed.data.timezone) update.timezone = parsed.data.timezone;
  if (parsed.data.displayName !== undefined) update.display_name = parsed.data.displayName;
  if (parsed.data.sourcePlatform || parsed.data.sourceUsername) {
    const { data: current } = await supabase
      .from('adu_configs')
      .select('status, source_platform, source_username')
      .eq('workspace_id', workspaceId)
      .eq('id', id)
      .maybeSingle();
    if (!current) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    const platform = parsed.data.sourcePlatform ?? (current.source_platform as 'instagram' | 'youtube' | 'tiktok' | 'facebook');
    const username = parsed.data.sourceUsername
      ? sanitizeSourceIdentity(platform, parsed.data.sourceUsername)
      : (current.source_username as string);
    if (!username) return NextResponse.json({ error: 'Enter a source username.' }, { status: 400 });
    update.source_platform = platform;
    update.source_username = username;
    // Changing the source re-syncs the queue: pending/downloaded reels
    // from the old source are removed, and discovery runs again.
    update.sync_status = 'pending';
    // A completed config restarts on a source change (its decided
    // recovery) — unless the request sets a status explicitly, which
    // the guard above already validated.
    if (current.status === 'completed' && !parsed.data.status) {
      update.status = 'active';
    }
    await supabase.from('adu_reels').delete().eq('config_id', id).in('status', ['pending', 'processing', 'downloaded']);
  }
  let postsPerDay = parsed.data.postsPerDay;
  let scheduleType = parsed.data.scheduleType;
  if (postsPerDay !== undefined || scheduleType || parsed.data.postingTimes) {
    const { data: current } = await supabase
      .from('adu_configs')
      .select('posts_per_day, schedule_type, posting_times')
      .eq('workspace_id', workspaceId)
      .eq('id', id)
      .maybeSingle();
    if (!current) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    postsPerDay = postsPerDay ?? (current.posts_per_day as number);
    scheduleType = scheduleType ?? (current.schedule_type as 'dailyrandom' | 'fixed');
    if (scheduleType === 'fixed') {
      const times = parsed.data.postingTimes;
      if (!times || times.length !== postsPerDay) {
        return NextResponse.json(
          { error: 'Please select a time for all posting slots.' },
          { status: 400 }
        );
      }
      update.posting_times = times;
    } else {
      update.posting_times = generateDailyRandomTimes(postsPerDay);
    }
    update.posts_per_day = postsPerDay;
    update.schedule_type = scheduleType;
  }
  const { error } = await supabase
    .from('adu_configs')
    .update(update)
    .eq('workspace_id', workspaceId)
    .eq('id', id);
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'This account or source user is already configured.' },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const view = await loadThreadsAduConfigView(supabase, workspaceId, id);
  return NextResponse.json({ config: view });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string }> }
) {
  const { subdomain, id } = await params;
  const resolved = await threadsAduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const view = await loadThreadsAduConfigView(resolved.context.supabase, resolved.context.workspaceId, id);
  if (!view) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  return NextResponse.json({ config: view });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string }> }
) {
  const { subdomain, id } = await params;
  return handlePatchThreadsAduConfig(request, subdomain, id);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string }> }
) {
  const { subdomain, id } = await params;
  const resolved = await threadsAduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  const scoped = await loadThreadsAduDestination(supabase, workspaceId, id);
  if (!scoped) return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
  // Old behaviour: reels are deleted first (in batches in the old app;
  // a single delete by config is equivalent here), then the page.
  await supabase.from('adu_reels').delete().eq('config_id', id);
  const { error } = await supabase
    .from('adu_configs')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // Cap-at-add release (plan-check B1): deleting the config frees
  // its Threads unit when the registry row still carries the ADU
  // feature. Best-effort — the delete already succeeded.
  await releaseAduConfigUsage(resolved.context, 'threads', scoped.destination.id);
  return NextResponse.json({ deleted: true });
}
