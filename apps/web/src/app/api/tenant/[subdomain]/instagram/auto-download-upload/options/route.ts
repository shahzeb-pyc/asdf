import { type NextRequest, NextResponse } from 'next/server';
import { aduContext } from '@/lib/server/adu';
import { loadAduOptionsListsForPlatform, type AduOptionsLists } from '@/lib/adu-hub-helpers';

/**
 * Instagram accounts + their destinations for the Add Account picker.
 * For Instagram the destination IS the account, so the dialog lists
 * the ACCOUNTS (spec 174 2A: the Add sources live from the connected
 * account, never from a table — connect creates no destinations
 * rows anymore, so an account with no row is still addable) and the
 * destinations are returned alongside for compatibility. The dialog
 * greys out accounts already configured, via configuredAccountIds:
 * a config's destination_id is an adu-copy id, never an account id,
 * so the dialog cannot check it against accounts itself.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
) {
  const { subdomain } = await params;
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  // One shared paged loader (Stream D, F23): the three selects are
  // range-paged past 1,000 rows instead of silently truncating, and
  // run concurrently. A fatal load failure is a loud 500, never an
  // empty picker that invites duplicate configs.
  let lists: AduOptionsLists;
  try {
    lists = await loadAduOptionsListsForPlatform(supabase, workspaceId, 'instagram');
  } catch (err) {
    console.error(`IG ADU options failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return NextResponse.json({ error: 'Could not load Instagram accounts.' }, { status: 500 });
  }
  const { accounts, destinations, configured } = lists;
  // One picker entry per account (spec 174 1B): the destination IS the
  // account for Instagram, and an account can hold one row per section
  // now. The adu copy is the entry when it exists (it is the row a new
  // config attaches to); otherwise any row serves as the identity
  // source — createOne creates the adu copy from it.
  const dedupedDestinations = dedupeDestinationsByAccount(destinations);
  if (lists.migrationMissing) {
    return NextResponse.json({
      accounts,
      pages: dedupedDestinations,
      destinations: dedupedDestinations,
      configured: [],
      configuredAccountIds: [],
      migrationMissing: true,
    });
  }
  // The accounts that already have an ADU config (spec 174 2A): a
  // config's destination_id is an adu-copy id, so the join goes
  // through the loaded destinations' account_ids. The dialog greys
  // out these accounts instead of submitting into the adu_configs
  // UNIQUE(destination_id) 23505.
  const accountIdByDestinationId = new Map<string, string>();
  for (const row of destinations as Array<{ id: string; account_id: string }>) {
    accountIdByDestinationId.set(row.id, row.account_id);
  }
  const configuredAccountIds = [...new Set(
    configured
      .map((c) => accountIdByDestinationId.get(c.destination_id as string))
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  )];
  return NextResponse.json({
    accounts,
    pages: dedupedDestinations,
    destinations: dedupedDestinations,
    configured,
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
