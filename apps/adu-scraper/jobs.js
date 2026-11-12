// Shared ADU job DB helpers (spec scraper-tikwm-first-concurrency
// §3): the single implementation of the upsert/mark logic used by
// both the main loop (index.js) and the TikTok worker pool
// (tiktok-pool.js wiring in index.js). No copy-paste — both import
// from here. Upsert idempotency under parallel jobs is guaranteed by
// onConflict: 'config_id,source_reel_id', ignoreDuplicates: true.
import { supabase } from './db.js';

export async function upsertReelsAndMarkSynced(job, platform, ids) {
  const reelsToInsert = ids.map((id) => ({
    config_id: job.id,
    source_reel_id: id,
    status: 'pending',
  }));

  const { error: insertError } = await supabase
    .from('adu_reels')
    .upsert(reelsToInsert, { onConflict: 'config_id,source_reel_id', ignoreDuplicates: true });

  if (insertError) {
    throw insertError;
  }

  const { error: updateError } = await supabase
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
