import { type NextRequest, NextResponse } from 'next/server';
import { aduContext, loadAduOptionsLists } from '@/lib/server/adu';

/** Accounts + managed Facebook pages for the Add Page picker. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string }> }
) {
  const { subdomain } = await params;
  const resolved = await aduContext(request, subdomain);
  if ('errorResponse' in resolved) return resolved.errorResponse;
  const { workspaceId, supabase } = resolved.context;
  try {
    const lists = await loadAduOptionsLists(supabase, workspaceId);
    return NextResponse.json(lists);
  } catch (err) {
    // Fail loud: a transient load failure must surface as a 500 the
    // picker can show, never as an empty accounts/pages list that
    // reads as "0 Connected" and invites duplicate adds.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not load Facebook accounts and pages.' },
      { status: 500 },
    );
  }
}
