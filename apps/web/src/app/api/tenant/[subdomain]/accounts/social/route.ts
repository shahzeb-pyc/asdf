import { type NextRequest, NextResponse } from 'next/server';
import {
  fetchSocialAccountsWithDestinations,
  type ConnectDbClient,
} from '@/lib/connect/persist';
import { enforceIpRateLimit } from '@/lib/request-body';
import { resolveSocialRouteContext } from '@/lib/connect/session';

/**
 * GET /api/tenant/[subdomain]/accounts/social — the unified Accounts list
 * data: every connected social account in the workspace, across all
 * platforms, each with its destinations (Spec 123, Part C).
 */
export async function handleListSocialAccounts(
  request: NextRequest,
  subdomain: string,
  dbClient?: ConnectDbClient
): Promise<NextResponse> {
  const context = await resolveSocialRouteContext(request, subdomain, dbClient);
  if (context.errorResponse) {
    return context.errorResponse;
  }

  try {
    const accounts = await fetchSocialAccountsWithDestinations(
      context.client,
      context.workspaceId
    );
    return NextResponse.json({ accounts });
  } catch (err) {
    console.error('[accounts/social] Failed to list accounts:', err);
    return NextResponse.json(
      { error: "Couldn't load your connected accounts. Please try again." },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  // Audit S6: previously unthrottled; 60/min like the other list reads.
  const limited = await enforceIpRateLimit(request, 'tenant_social_list', 60);
  if (limited) return limited;
  return handleListSocialAccounts(request, subdomain);
}
