import { type NextRequest, NextResponse } from 'next/server';
import {
  AduUpdateConfigSchema,
  generateDailyRandomTimes,
  sanitizeSourceIdentity,
} from '@fbuploadpro/contracts';
import { aduContext, loadAduConfigView,
  releaseAduConfigUsage,
} from '@/lib/server/adu';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * PATCH transition guards (spec §3.3, as rewritten by spec 236): the
 * UI mirrors these, never the other way round. The automation
 * toggle reactivates a page from ANY config status — `paused` from
 * anywhere, `active` from anywhere — with no probes: no page-token
 * refresh, no creator check. Turning it ON first revives the
 * linked destination (and account) so the worker admits the page at
 * the next posting time; a failed publish then falls back to the
 * real error status. Every other target status is system-set and
 * rejected.
 */
interface AduPatchCurrentRow {
  status: string;
  destination_id: string;
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
 * Spec 236, toggle ON: revives the linked destination row so the
 * worker admits the page at the next posting time — the config flip
 * alone is not enough (the worker skips error destinations, and the
 * card badge reads the destination first). Every refusal happens
 * before any write, so a refused toggle leaves config, destination
 * and account untouched. An error or rate-limited destination
 * becomes active with its markers cleared. A disconnected
 * destination (or a missing one) is a 400: the page must be added
 * again first. An expired linked account is flipped back to active
 * — the claim RPCs and the worker require an active account; a
 * revoked or errored account is a 400 asking for a reconnect.
 * Returns a response when the change is rejected or a check fails;
 * returns null when the destination is already fine.
 */
async function reactivateDestinationForToggle(
  supabase: SupabaseClient,
  workspaceId: string,
  configId: string,
  current: AduPatchCurrentRow
): Promise<NextResponse | null> {
  const { data: destination, error: destinationError } = await supabase
    .from('destinations')
    .select('id, account_id, status, metadata')
    .eq('id', current.destination_id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (destinationError) {
    console.error(
      `[ADU PATCH] Failed to read the destination for config ${configId}: ${destinationError.message}`
    );
    return NextResponse.json(
      { error: 'Could not turn automation back on. Try again.' },
      { status: 500 }
    );
  }
  const dest = destination as {
    id: string;
    account_id?: unknown;
    status?: unknown;
    metadata?: unknown;
  } | null;
  if (!dest) {
    return NextResponse.json(
      { error: 'This page was removed. Add it again first.' },
      { status: 400 }
    );
  }
  if (dest.status === 'disconnected') {
    return NextResponse.json(
      { error: 'This page was disconnected. Add it again first.' },
      { status: 400 }
    );
  }
  // The account is checked before any write: a revoked account
  // refuses the toggle with everything untouched.
  if (typeof dest.account_id === 'string' && dest.account_id) {
    const { data: account, error: accountError } = await supabase
      .from('social_accounts')
      .select('status')
      .eq('id', dest.account_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    if (accountError) {
      console.error(
        `[ADU PATCH] Failed to read the linked account for config ${configId}: ${accountError.message}`
      );
      return NextResponse.json(
        { error: 'Could not turn automation back on. Try again.' },
        { status: 500 }
      );
    }
    const accountStatus = (account as { status?: unknown } | null)?.status;
    if (accountStatus === 'expired') {
      const { error: flipError } = await supabase
        .from('social_accounts')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('id', dest.account_id)
        .eq('workspace_id', workspaceId);
      if (flipError) {
        console.error(
          `[ADU PATCH] Failed to revive the linked account for config ${configId}: ${flipError.message}`
        );
        return NextResponse.json(
          { error: 'Could not turn automation back on. Try again.' },
          { status: 500 }
        );
      }
    } else if (accountStatus === 'revoked' || accountStatus === 'error') {
      return NextResponse.json(
        { error: 'Reconnect your Facebook account to restore access.' },
        { status: 400 }
      );
    }
  }
  if (dest.status === 'error' || dest.status === 'rate_limited') {
    const nextMetadata = {
      ...((dest.metadata as Record<string, unknown> | null) ?? {}),
    };
    delete nextMetadata.fb_status;
    delete nextMetadata.rate_limited_at;
    const { error: updateError } = await supabase
      .from('destinations')
      .update({
        status: 'active',
        metadata: nextMetadata,
        updated_at: new Date().toISOString(),
      })
      .eq('id', dest.id)
      .eq('workspace_id', workspaceId);
    if (updateError) {
      console.error(
        `[ADU PATCH] Failed to revive the destination for config ${configId}: ${updateError.message}`
      );
      return NextResponse.json(
        { error: 'Could not turn automation back on. Try again.' },
        { status: 500 }
      );
    }
  }
  return null;
}

/**
 * Spec 236, toggle OFF: clears a destination error so the card
 * reads Paused instead of the error (the ADU badge reads the
 * destination first). The account is never touched, and nothing
 * here can refuse the pause.
 */
async function clearDestinationErrorForToggle(
  supabase: SupabaseClient,
  workspaceId: string,
  configId: string,
  current: AduPatchCurrentRow
): Promise<NextResponse | null> {
  const { data: destination, error: destinationError } = await supabase
    .from('destinations')
    .select('id, status, metadata')
    .eq('id', current.destination_id)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (destinationError) {
    console.error(
      `[ADU PATCH] Failed to read the destination for config ${configId}: ${destinationError.message}`
    );
    return NextResponse.json(
      { error: 'Could not pause automation. Try again.' },
      { status: 500 }
    );
  }
  const dest = destination as {
    id: string;
    status?: unknown;
    metadata?: unknown;
  } | null;
  if (!dest || (dest.status !== 'error' && dest.status !== 'rate_limited')) {
    return null;
  }
  const nextMetadata = {
    ...((dest.metadata as Record<string, unknown> | null) ?? {}),
  };
  delete nextMetadata.fb_status;
  delete nextMetadata.rate_limited_at;
  const { error: updateError } = await supabase
    .from('destinations')
    .update({
      status: 'active',
      metadata: nextMetadata,
      updated_at: new Date().toISOString(),
    })
    .eq('id', dest.id)
    .eq('workspace_id', workspaceId);
  if (updateError) {
    console.error(
      `[ADU PATCH] Failed to clear the destination error for config ${configId}: ${updateError.message}`
    );
    return NextResponse.json(
      { error: 'Could not pause automation. Try again.' },
      { status: 500 }
    );
  }
  return null;
}

/**
 * Enforces the §3.3 transition guards for a status change. Spec 236:
 * the toggle reactivates from ANY config status — `paused` from
 * anywhere, `active` from anywhere — with no probes. Returns a
 * response when the change is rejected or a check fails; returns null
 * when the change may proceed (side effects already applied).
 */
async function guardAduStatusChange(
  supabase: SupabaseClient,
  workspaceId: string,
  configId: string,
  current: AduPatchCurrentRow,
  target: string
): Promise<NextResponse | null> {
  if (target === 'paused') {
    return clearDestinationErrorForToggle(
      supabase,
      workspaceId,
      configId,
      current
    );
  }
  if (target !== 'active') {
    return NextResponse.json(
      { error: "This status can't be changed here." },
      { status: 400 }
    );
  }
  const reactivated = await reactivateDestinationForToggle(
    supabase,
    workspaceId,
    configId,
    current
  );
  if (reactivated) return reactivated;
  if (current.status === 'creator_suspended') {
    return resetFailedReelsForReactivation(supabase, configId);
  }
  return null;
}

export async function handlePatchAduConfig(
  request: NextRequest,
  subdomain: string,
  id: string
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
      .select('status, destination_id')
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
      parsed.data.status
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
    // A cached YouTube channel ID belongs to the old source; clear it so
    // the next discovery resolves the new handle (spec 154). Only for
    // YouTube sources, so a lagging migration can never break a source
    // switch on another platform.
    if (platform === 'youtube' || (current.source_platform as string) === 'youtube') {
      update.youtube_channel_id = null;
    }
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
        { error: 'This page is already configured.' },
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
