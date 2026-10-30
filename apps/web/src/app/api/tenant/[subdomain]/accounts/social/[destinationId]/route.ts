import { type NextRequest, NextResponse } from 'next/server';
import {
  fetchDestinationDetail,
  type ConnectDbClient,
} from '@/lib/connect/persist';
import { enforceIpRateLimit } from '@/lib/request-body';
import { resolveSocialRouteContext } from '@/lib/connect/session';

/**
 * GET /api/tenant/[subdomain]/accounts/social/[destinationId] — one
 * destination plus its owning account. Backs the dedicated-section landing
 * page (spec 128 builds the section internals on this data).
 */
export async function handleGetSocialDestination(
  request: NextRequest,
  subdomain: string,
  destinationId: string,
  dbClient?: ConnectDbClient
): Promise<NextResponse> {
  const context = await resolveSocialRouteContext(request, subdomain, dbClient);
  if (context.errorResponse) {
    return context.errorResponse;
  }

  try {
    const destination = await fetchDestinationDetail(
      context.client,
      context.workspaceId,
      destinationId
    );
    if (!destination) {
      return NextResponse.json(
        { error: 'Destination not found' },
        { status: 404 }
      );
    }
    return NextResponse.json({ destination });
  } catch (err) {
    console.error('[accounts/social] Failed to load destination:', err);
    return NextResponse.json(
      { error: "Couldn't load this destination. Please try again." },
      { status: 500 }
    );
  }
}

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ subdomain: string; destinationId: string }>;
  }
): Promise<NextResponse> {
  const { subdomain, destinationId } = await context.params;
  // Audit S6: previously unthrottled; 60/min like the other list reads.
  const limited = await enforceIpRateLimit(request, 'tenant_social_detail', 60);
  if (limited) return limited;
  return handleGetSocialDestination(request, subdomain, destinationId);
}
