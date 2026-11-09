import { type NextRequest, NextResponse } from 'next/server';
import {
  AduUpdateConfigSchema,
  decryptToken,
  encryptToken,
  fetchAllFacebookPages,
  generateDailyRandomTimes,
  getTokenEncryptionKey,
  sanitizeSourceIdentity,
} from '@fbuploadpro/contracts';
import { aduContext, loadAduConfigView,
  releaseAduConfigUsage,
} from '@/lib/server/adu';
import { fetchTikwmUserPosts, TikwmError } from '@/lib/server/tikwm';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * PATCH transition guards (spec §3.3): the UI mirrors these, never the
 * other way round. `paused` is allowed from anywhere; `active` only
 * from the listed statuses (with the checks noted); every other target
 * status is system-set and rejected.
 */
const TOKEN_CHECK_STATUSES = new Set([
  'page_not_accessible',
  'missing_page_access',
  'missing_permission',
]);
const DIRECT_ACTIVATE_STATUSES = new Set([
  'paused',
  'fb_verification_required',
  'account_suspended',
  'check_developer_app',
]);

export interface AduPatchDeps {
  /** Default: the reconnect flow's page list, as an id → token map. */
  fetchPageTokenMap?: (userAccessToken: string) => Promise<Map<string, string>>;
  /** Default: fetchTikwmUserPosts (one paid call per toggle-ON). */
  fetchCreatorPosts?: (username: string) => Promise<unknown[]>;
}

interface AduPatchCurrentRow {
  status: string;
  destination_id: string;
  source_platform: string;
  source_username: string;
}

async function defaultFetchPageTokenMap(
  userAccessToken: string
): Promise<Map<string, string>> {
  const { pages, truncated, truncationReason } =
    await fetchAllFacebookPages(userAccessToken, 'id,access_token');
  if (truncated) {
    console.warn(
      `[ADU PATCH] Page token list truncated (${truncationReason}) — a page beyond the list keeps its stored token until the next reconnect.`
    );
  }
  const tokenMap = new Map<string, string>();
  for (const page of pages) {
    if (
      typeof page?.id === 'string' &&
      page.id &&
      typeof page?.access_token === 'string' &&
      page.access_token
    ) {
      tokenMap.set(page.id, page.access_token);
    }
  }
  return tokenMap;
}

/**
 * Fresh page-token check for toggle-ON from page_not_accessible /
 * missing_page_access / missing_permission: fetch the destination's
 * page token through the connected Facebook account. A token means
 * access is back — it is written (encrypted) to the destination and
 * the config may activate. No token means the config stays in its
 * status; the caller surfaces the plain message and the full reason
 * is logged here, never shown to the user.
 */
async function refreshPageTokenForConfig(
  supabase: SupabaseClient,
  workspaceId: string,
  configId: string,
  current: AduPatchCurrentRow,
  deps: AduPatchDeps
): Promise<boolean> {
  const log = (reason: string) =>
    console.error(
      `[ADU PATCH] Page token check failed for config ${configId}: ${reason}`
    );
  const { data: destination } = await supabase
    .from('destinations')
    .select('id, external_destination_id, account_id')
    .eq('id', current.destination_id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  const dest = destination as {
    external_destination_id?: unknown;
    account_id?: unknown;
  } | null;
  if (!dest || typeof dest.external_destination_id !== 'string' || !dest.external_destination_id) {
    log('destination row or Facebook page id missing');
    return false;
  }
  if (typeof dest.account_id !== 'string' || !dest.account_id) {
    log('destination has no linked Facebook account');
    return false;
  }
  const { data: account } = await supabase
    .from('social_accounts')
    .select('encrypted_access_token')
    .eq('id', dest.account_id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  const encrypted = (account as { encrypted_access_token?: unknown } | null)
    ?.encrypted_access_token;
  if (typeof encrypted !== 'string' || !encrypted) {
    log('linked Facebook account has no stored access token');
    return false;
  }
  let userToken: string;
  try {
    userToken = await decryptToken(encrypted, getTokenEncryptionKey());
  } catch (err) {
    log(`could not decrypt the account token: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  let tokenMap: Map<string, string>;
  try {
    const fetchMap = deps.fetchPageTokenMap ?? defaultFetchPageTokenMap;
    tokenMap = await fetchMap(userToken);
  } catch (err) {
    log(`page list fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  const freshToken = tokenMap.get(dest.external_destination_id);
  if (!freshToken) {
    log(`no fresh token for page ${dest.external_destination_id} — access is still missing`);
    return false;
  }
  let encryptedPageToken: string;
  try {
    encryptedPageToken = await encryptToken(freshToken, getTokenEncryptionKey());
  } catch (err) {
    log(`could not encrypt the fresh page token: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  const { error } = await supabase
    .from('destinations')
    .update({
      encrypted_destination_token: encryptedPageToken,
      updated_at: new Date().toISOString(),
    })
    .eq('id', current.destination_id)
    .eq('workspace_id', workspaceId);
  if (error) {
    log(`writing the fresh page token failed: ${error.message}`);
    return false;
  }
  return true;
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
  deps: AduPatchDeps
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
 * reels to pending with download_retries reset to 0 and
 * download_claimed_at / download_failed_at cleared, so the reels are
 * claimable again — the claim RPCs only claim pending reels with
 * download_retries < 3, and every download_failed reel sits at 3
 * retries. A reset failure is loud and blocks the activation: the
 * config must not read active while its reels never re-download.
 */
async function resetFailedReelsForReactivation(
  supabase: SupabaseClient,
  configId: string
): Promise<NextResponse | null> {
  const { error } = await supabase
    .from('adu_reels')
    .update({
      status: 'pending',
      download_retries: 0,
      download_claimed_at: null,
      download_failed_at: null,
    })
    .eq('config_id', configId)
    .eq('status', 'download_failed');
  if (error) {
    console.error(
      `[ADU PATCH] Failed to reset download_failed reels for config ${configId}: ${error.message}`
    );
    return NextResponse.json(
      { error: 'Could not turn automation back on. Try again.' },
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
  workspaceId: string,
  configId: string,
  current: AduPatchCurrentRow,
  target: string,
  deps: AduPatchDeps
): Promise<NextResponse | null> {
  if (target === 'paused') return null;
  if (target !== 'active') {
    return NextResponse.json(
      { error: 'This status can\'t be changed here.' },
      { status: 400 }
    );
  }
  const from = current.status;
  if (from === 'active' || DIRECT_ACTIVATE_STATUSES.has(from)) return null;
  if (TOKEN_CHECK_STATUSES.has(from)) {
    const ok = await refreshPageTokenForConfig(supabase, workspaceId, configId, current, deps);
    if (!ok) {
      return NextResponse.json(
        {
          error:
            'Could not confirm access to this page. Posting stays paused — check the page access and try again.',
        },
        { status: 400 }
      );
    }
    return null;
  }
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
      { error: 'Reconnect your Facebook account to restore access.' },
      { status: 400 }
    );
  }
  if (from === 'fb_rate_limited') {
    return NextResponse.json(
      { error: 'Posting resumes automatically in about 3 days. You don\'t need to do anything.' },
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

export async function handlePatchAduConfig(
  request: NextRequest,
  subdomain: string,
  id: string,
  deps: AduPatchDeps = {}
): Promise<NextResponse> {
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
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
    const { data: currentRow } = await supabase
      .from('adu_configs')
      .select('status, destination_id, source_platform, source_username')
      .eq('workspace_id', workspaceId)
      .eq('id', id)
      .maybeSingle();
    if (!currentRow) return NextResponse.json({ error: 'Page not found.' }, { status: 404 });
    const current = currentRow as AduPatchCurrentRow;
    const guard = await guardAduStatusChange(
      supabase,
      workspaceId,
      id,
      current,
      parsed.data.status,
      deps
    );
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
    if (!current) return NextResponse.json({ error: 'Page not found.' }, { status: 404 });
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
    if (!current) return NextResponse.json({ error: 'Page not found.' }, { status: 404 });
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
        { error: 'This page or source user is already configured.' },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const view = await loadAduConfigView(supabase, workspaceId, id);
  return NextResponse.json({ config: view });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string }> }
) {
  const { subdomain, id } = await params;
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const view = await loadAduConfigView(resolved.context.supabase, resolved.context.workspaceId, id);
  if (!view) return NextResponse.json({ error: 'Page not found.' }, { status: 404 });
  return NextResponse.json({ config: view });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string }> }
) {
  const { subdomain, id } = await params;
  return handlePatchAduConfig(request, subdomain, id);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; id: string }> }
) {
  const { subdomain, id } = await params;
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  // Ownership first: the reels delete below is keyed only by config id,
  // so a foreign id must 404 here before anything is deleted — otherwise
  // one workspace could wipe another workspace's reels while its config
  // (deleted with the workspace filter) survives.
  const { data: owned } = await supabase
    .from('adu_configs')
    .select('id, destination_id')
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle();
  if (!owned) return NextResponse.json({ error: 'Page not found.' }, { status: 404 });
  const ownedDestinationId = (owned as { destination_id?: unknown }).destination_id;
  // Old behaviour: reels are deleted first (in batches in the old app;
  // a single delete by config is equivalent here), then the page.
  await supabase.from('adu_reels').delete().eq('config_id', id);
  const { error } = await supabase
    .from('adu_configs')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  // Cap-at-add release (audit fix 2026-11-01): deleting the config
  // frees its unit when the registry row still carries the ADU
  // feature. Best-effort — the delete already succeeded.
  if (typeof ownedDestinationId === 'string' && ownedDestinationId.length > 0) {
    await releaseAduConfigUsage(resolved.context, 'facebook', ownedDestinationId);
  }
  return NextResponse.json({ deleted: true });
}
