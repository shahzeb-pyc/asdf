import { type NextRequest, NextResponse } from 'next/server';
import { aduContext, aduMissingTable } from '@/lib/server/adu';

/**
 * Instagram accounts + their destinations for the Add Account picker.
 * For Instagram the destination IS the account, so the dialog lists
 * destinations (returned as `pages` for dialog compatibility, and as
 * `destinations` for clarity) and the social accounts behind them.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
) {
  const { subdomain } = await params;
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  // Explicit 1,000-row bounds on every list here (PostgREST silently
  // truncates past 1,000 rows) and fail-loud 500s, never an empty
  // picker that invites duplicate configs — the #56 pattern for the
  // Facebook picker, applied to the Instagram picker.
  const { data: accounts, error: accountError } = await supabase
    .from('social_accounts')
    .select('id, external_account_id, display_name, avatar_url, status')
    .eq('workspace_id', workspaceId)
    .eq('platform', 'instagram')
    .order('display_name')
    .limit(1000);
  if (accountError) {
    console.error(`IG ADU options accounts failed: code=${accountError.code ?? 'unknown'}`);
    return NextResponse.json({ error: 'Could not load Instagram accounts.' }, { status: 500 });
  }
  const { data: destinations, error: destError } = await supabase
    .from('destinations')
    .select('id, account_id, external_destination_id, name, avatar_url, status, metadata, section')
    .eq('workspace_id', workspaceId)
    .eq('platform', 'instagram')
    .order('name')
    .limit(1000);
  if (destError) {
    console.error(`IG ADU options destinations failed: code=${destError.code ?? 'unknown'}`);
    return NextResponse.json({ error: 'Could not load Instagram accounts.' }, { status: 500 });
  }
  // One picker entry per account (spec 174 1B): the destination IS the
  // account for Instagram, and an account can hold one row per section
  // now. The adu copy is the entry when it exists (it is the row a new
  // config attaches to); otherwise any row serves as the identity
  // source — createOne creates the adu copy from it.
  const dedupedDestinations = dedupeDestinationsByAccount(
    (destinations ?? []) as Array<Record<string, unknown>>
  );
  const { data: configured } = await supabase
    .from('adu_configs')
    .select('destination_id, source_platform, source_username')
    .eq('workspace_id', workspaceId)
    .limit(1000);
  if (configured === null) {
    const { error } = await supabase.from('adu_configs').select('id').limit(1);
    if (aduMissingTable(error)) {
      return NextResponse.json({
        accounts: accounts ?? [],
        pages: dedupedDestinations,
        destinations: dedupedDestinations,
        configured: [],
        migrationMissing: true,
      });
    }
  }
  return NextResponse.json({
    accounts: accounts ?? [],
    pages: dedupedDestinations,
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
