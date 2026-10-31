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
    .select('id, account_id, external_destination_id, name, avatar_url, status, metadata')
    .eq('workspace_id', workspaceId)
    .eq('platform', 'threads')
    .order('name');
  if (pageError) {
    return NextResponse.json({ error: pageError.message }, { status: 500 });
  }
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
        destinations: destinations ?? [],
        configured: [],
        migrationMissing: true,
      });
    }
  }
  return NextResponse.json({
    accounts: accounts ?? [],
    destinations: destinations ?? [],
    configured: configured ?? [],
  });
}
