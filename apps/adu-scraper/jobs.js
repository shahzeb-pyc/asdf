// Shared ADU job DB helpers (spec scraper-tikwm-first-concurrency
// §3): the single implementation of the upsert/mark logic used by
// both the main loop (index.js) and the TikTok worker pool
// (tiktok-pool.js wiring in index.js). No copy-paste — both import
// from here. Upsert idempotency under parallel jobs is guaranteed by
// onConflict: 'config_id,source_reel_id', ignoreDuplicates: true.
import { supabase } from './db.js';

// A discovered reel entry: the reel id plus its measured view count,
// or null when the view count was never measured (non-TikTok
// platforms, and the TikTok discovery-order fallback). Callers may
// still pass plain string ids; they rank by position with no view
// count. The upsert assigns discovery_rank from the entry's position
// in the array (1-based): discovery functions return entries in
// final order — newest first for every platform, top-30-by-views
// first for TikTok (spec 203) — so position IS the rank.
export function buildReelInsertRows(configId, entries) {
  return (entries ?? []).map((entry, index) => {
    const id = typeof entry === 'string' ? entry : entry?.id;
    const viewCount =
      typeof entry === 'object' && entry !== null && typeof entry.view_count === 'number'
        ? entry.view_count
        : null;
    return {
      config_id: configId,
      source_reel_id: id,
      status: 'pending',
      discovery_rank: index + 1,
      view_count: viewCount,
    };
  });
}

export async function upsertReelsAndMarkSynced(job, platform, ids, client = supabase) {
  const reelsToInsert = buildReelInsertRows(job.id, ids);

  // Only newly inserted rows get a rank: ignoreDuplicates leaves
  // already-known rows untouched, so they keep whatever rank (or
  // NULL) they had — never re-ranked, never touched (spec 203).
  const { error: insertError } = await client
    .from('adu_reels')
    .upsert(reelsToInsert, { onConflict: 'config_id,source_reel_id', ignoreDuplicates: true });

  if (insertError) {
    throw insertError;
  }

  const { error: updateError } = await client
    .from('adu_configs')
    .update({ sync_status: 'synced' })
    .eq('id', job.id);

  if (updateError) {
    throw updateError;
  }
}

export async function markSyncStatus(configId, syncStatus) {
  const { error } = await supabase.from('adu_configs').update({ sync_status: syncStatus }).eq('id', configId);
  if (error) {
    throw error;
  }
}
