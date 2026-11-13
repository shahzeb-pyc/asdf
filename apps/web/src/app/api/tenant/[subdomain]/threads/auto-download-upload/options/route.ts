import { type NextRequest, NextResponse } from 'next/server';
import { threadsAduContext, threadsAduMissingTable } from '@/lib/server/threads-adu';

/** Threads accounts + their Threads destinations for the Add picker.
 * The dialog lists the ACCOUNTS (spec 174 2A: the Add sources live
 * from the connected account, never from a table — connect creates
 * no destinations rows anymore, so an account with no row is still
 * addable) and the destinations are returned alongside for
 * compatibility. The dialog greys out accounts already configured,
 * via configuredAccountIds: a config's destination_id is an
 * adu-copy id, never an account id, so the dialog cannot check it
 * against accounts itself. */
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
    .eq('workspace_id', workspaceId)
    .order('destination_id')
    .limit(1000);
  if (configured === null) {
    // Table missing is not fatal for the picker: pages are still shown.
    const { error } = await supabase.from('adu_configs').select('id').limit(1);
    if (threadsAduMissingTable(error)) {
      return NextResponse.json({
        accounts: accounts ?? [],
        destinations: dedupedDestinations,
        configured: [],
        configuredAccountIds: [],
        migrationMissing: true,
      });
    }
  }
  // The accounts that already have an ADU config (spec 174 2A): a
  // config's destination_id is an adu-copy id, so the join goes
  // through the loaded destinations' account_ids. The dialog greys
  // out these accounts instead of submitting into the adu_configs
  // UNIQUE(destination_id) 23505.
  const accountIdByDestinationId = new Map<string, string>();
  for (const row of (destinations ?? []) as Array<{ id: string; account_id: string }>) {
    accountIdByDestinationId.set(row.id, row.account_id);
  }
  const configuredAccountIds = [...new Set(
    (configured ?? [])
      .map((c) => accountIdByDestinationId.get(c.destination_id as string))
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  )];
  return NextResponse.json({
    accounts: accounts ?? [],
    destinations: dedupedDestinations,
    configured: configured ?? [],
    configuredAccountIds,
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
