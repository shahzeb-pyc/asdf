/**
 * Dev-only claim-race verification (spec 149).
 *
 * Fires parallel `claim_download_jobs` RPC calls for one user and
 * asserts the total claimed never exceeds the per-workspace cap of 3,
 * even under contention. This exercises the real RPC against a real
 * database — it is NOT a unit test and must never run against
 * production.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * DOWNLOAD_VERIFY_USER_ID (an EXISTING dev user id — the jobs table
 * references users). The script inserts 6 queued jobs for that user
 * and deletes them again afterwards, leaving no trace.
 */

import { createSupabaseClient, SupabaseJobStore } from '../src/db.js';

const CAP = 3;

async function main(): Promise<void> {
  const supabaseUrl = process.env['SUPABASE_URL'];
  const serviceKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  const userId = process.env['DOWNLOAD_VERIFY_USER_ID'];
  if (!supabaseUrl || !serviceKey || !userId) {
    throw new Error(
      'Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DOWNLOAD_VERIFY_USER_ID are all required.'
    );
  }

  const client = createSupabaseClient(supabaseUrl, serviceKey);
  const store = new SupabaseJobStore(client);

  const jobIds: string[] = [];
  try {
    for (let i = 0; i < 6; i++) {
      const { data, error } = await client
        .from('media_download_jobs')
        .insert({
          user_id: userId,
          source_url: `https://example.com/verify-${i}.mp4`,
          source_platform: 'direct',
          status: 'queued',
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(`seed insert failed: ${error?.message ?? 'no row'}`);
      jobIds.push((data as { id: string }).id);
    }

    const results = await Promise.all([
      store.claimJobs('verify-worker-a', userId, CAP),
      store.claimJobs('verify-worker-b', userId, CAP),
      store.claimJobs('verify-worker-c', userId, CAP),
      store.claimJobs('verify-worker-d', userId, CAP),
    ]);
    const claimedIds = results.flat().map((job) => job.id);
    const distinct = new Set(claimedIds);
    console.log(
      `claim-race: 4 parallel claims of limit ${CAP} claimed ${claimedIds.length} rows (${distinct.size} distinct)`
    );
    if (claimedIds.length !== distinct.size) {
      throw new Error('claim-race FAILED: the same job was claimed twice');
    }
    if (distinct.size > CAP) {
      throw new Error(`claim-race FAILED: ${distinct.size} claimed, cap is ${CAP}`);
    }
    if (distinct.size === 0) {
      throw new Error('claim-race FAILED: nothing was claimed (is the migration applied?)');
    }
    console.log('claim-race: PASS');
  } finally {
    if (jobIds.length > 0) {
      const { error } = await client
        .from('media_download_jobs')
        .delete()
        .in('id', jobIds);
      if (error) {
        console.error(`claim-race: cleanup failed for jobs ${jobIds.join(',')}: ${error.message}`);
      }
    }
  }
}

main().catch((error: unknown) => {
  console.error(`claim-race: ${String(error)}`);
  process.exitCode = 1;
});
