import { type NextRequest, NextResponse } from 'next/server';
import { threadsAduContext, threadsAduMissingTable } from '@/lib/server/threads-adu';

/** Threads accounts + their Threads destinations for the Add picker. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
) {
  const { subdomain } = await params;
  const resolved = await threadsAduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  const { data: accounts, error: accountError } = await supabase
    .from('social_accounts')
    .select('id, external_account_id, display_name, avatar_url, status')
    .eq('workspace_id', workspaceId)
    .eq('platform', 'threads')
    .order('display_name');
  if (accountError) {
    return NextResponse.json({ error: accountError.message }, { status: 500 });
  }
  const { data: destinations, error: pageError } = await supabase
    .from('destinations')
    .select('id, account_id, external_destination_id, name, avatar_url, status, metadata, section')
    .eq('workspace_id', workspaceId)
    .eq('platform', 'threads')
    .order('name')
    .limit(1000);
  if (pageError) {
    return NextResponse.json({ error: pageError.message }, { status: 500 });
  }
  // One picker entry per account (spec 174 1B): the destination IS the
  // account for Threads, and an account can hold one row per section
  // now. The adu copy is the entry when it exists (it is the row a new
  // config attaches to); otherwise any row serves as the identity
  // source — createOne creates the adu copy from it. The 1,000-row
  // limit matches the Facebook/Instagram pickers (they already had
  // it; this route did not).
  const dedupedDestinations = dedupeDestinationsByAccount(
    (destinations ?? []) as Array<Record<string, unknown>>
  );
  const { data: configured } = await supabase
    .from('adu_configs')
    .select('destination_id, source_platform, source_username')
    .eq('workspace_id', workspaceId);
  if (configured === null) {
    // Table missing is not fatal for the picker: pages are still shown.
    const { error } = await supabase.from('adu_configs').select('id').limit(1);
    if (threadsAduMissingTable(error)) {
      return NextResponse.json({
        accounts: accounts ?? [],
        destinations: dedupedDestinations,
        configured: [],
        migrationMissing: true,
      });
    }
  }
  return NextResponse.json({
    accounts: accounts ?? [],
    destinations: dedupedDestinations,
    configured: configured ?? [],
  });
}

function dedupeDestinationsByAccount(
  rows: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const rank = (row: Record<string, unknown>): number =>
    row.section === 'adu' ? 0 : row.section === null || row.section === undefined ? 1 : 2;
  const byAccount = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const accountId = String(row.account_id ?? '');
    const prev = byAccount.get(accountId);
    if (!prev || rank(row) < rank(prev)) byAccount.set(accountId, row);
  }
  return [...byAccount.values()];
}
