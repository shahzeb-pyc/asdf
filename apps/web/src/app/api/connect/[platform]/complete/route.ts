import { type NextRequest, NextResponse } from 'next/server';
import {
  getPlatformAccountsPath,
  getSessionSecret,
} from '@fbuploadpro/contracts';
import { z } from 'zod';
import { bodyTooLargeResponse, enforceIpRateLimit, readJsonBody } from '@/lib/request-body';
import { isKnownPlatform } from '@/lib/connect/registry';
import {
  verifyPendingDestinations,
  PENDING_COOKIE_NAME,
} from '@/lib/connect/state';
import {
  persistPickedDestinations,
  type ConnectDbClient,
} from '@/lib/connect/persist';
import {
  extractConnectSession,
  resolveConnectDbClient,
  sessionCanAccessTenant,
} from '@/lib/connect/session';

/**
 * POST /api/connect/[platform]/complete — finishes a connect flow.
 *
 * Body: { destinationIds: string[] } — the external destination IDs the
 * user picked in the destination picker. Only destinations from the signed
 * pending cookie can be persisted; anything else is ignored. Returns the
 * unified Accounts landing URL.
 */
/**
 * Body schema for completing a connect flow (spec 139 Wave B, audit C2:
 * this body was previously read with ad-hoc type checks only). Entries
 * that are not strings are dropped, exactly as before; the array itself
 * must be present and bounded.
 */
const ConnectCompleteRequestSchema = z.object({
  destinationIds: z
    .array(z.unknown())
    .max(500)
    .transform((ids) =>
      ids.filter((id): id is string => typeof id === 'string')
    ),
});

export async function handleConnectComplete(
  request: NextRequest,
  platformParam: string,
  dbClient?: ConnectDbClient
): Promise<NextResponse> {
  const limited = await enforceIpRateLimit(request, 'connect_complete', 20);
  if (limited) return limited;

  if (!isKnownPlatform(platformParam)) {
    return NextResponse.json({ error: 'Unknown platform' }, { status: 404 });
  }
  const platform = platformParam;

  const session = await extractConnectSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pendingCookie = request.cookies.get(PENDING_COOKIE_NAME)?.value;
  if (!pendingCookie) {
    return NextResponse.json(
      { error: 'This connection has expired. Please start again.' },
      { status: 410 }
    );
  }

  let pending;
  try {
    pending = await verifyPendingDestinations(
      pendingCookie,
      getSessionSecret()
    );
  } catch (err) {
    console.error('[connect/complete] Pending cookie invalid:', err);
    return NextResponse.json(
      { error: 'This connection has expired. Please start again.' },
      { status: 410 }
    );
  }

  if (
    pending.platform !== platform ||
    pending.tenantSubdomain !== session.subdomain ||
    !sessionCanAccessTenant(session, pending.tenantSubdomain)
  ) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') return bodyTooLargeResponse();
    return NextResponse.json(
      { error: 'Please choose at least one destination to add.' },
      { status: 400 }
    );
  }

  const parsedBody = ConnectCompleteRequestSchema.safeParse(bodyResult.value);
  const requestedIds = new Set(
    parsedBody.success ? parsedBody.data.destinationIds : []
  );
  const picked = pending.destinations.filter((destination) =>
    requestedIds.has(destination.externalDestinationId)
  );
  if (picked.length === 0) {
    return NextResponse.json(
      { error: 'Please choose at least one destination to add.' },
      { status: 400 }
    );
  }

  const client = resolveConnectDbClient(dbClient);
  if (!client) {
    return NextResponse.json(
      { error: 'Database service unavailable' },
      { status: 503 }
    );
  }

  try {
    await persistPickedDestinations(client, {
      workspaceId: pending.workspaceId,
      accountId: pending.accountId,
      platform,
      destinations: picked,
    });
  } catch (err) {
    console.error('[connect/complete] Failed to persist destinations:', err);
    return NextResponse.json(
      { error: "Couldn't save your choices. Please try again." },
      { status: 500 }
    );
  }

  // Per-platform Accounts landing page: facebook keeps the historic
  // `/tenant/<sub>/accounts`; every other platform lands on its own
  // accounts page (e.g. Instagram → `/tenant/<sub>/instagram/accounts`,
  // Threads → `/tenant/<sub>/threads/accounts`).
  // Threads additionally carries Facebook's connect-notice params so
  // the Threads shell can toast / highlight / warn in place:
  // fresh connect → `connected=1&accountName=…`, re-sign-in →
  // `connected=already&accountName=…`, wrong-account reconnect →
  // `reconnected_mismatch=1&newAccountName=…&expectedAccountName=…`.
  // The account name is the picked destination's name (the Threads
  // profile itself).
  let accountsUrl = `/tenant/${pending.tenantSubdomain}${getPlatformAccountsPath(platform)}`;
  if (platform === 'threads') {
    const accountName = picked[0]?.name ?? 'Threads account';
    const isMismatch = Boolean(
      pending.expectedExternalAccountId &&
        picked[0]?.externalDestinationId !== pending.expectedExternalAccountId
    );
    const params = new URLSearchParams();
    if (isMismatch) {
      params.set('reconnected_mismatch', '1');
      params.set('newAccountName', accountName);
      params.set(
        'expectedAccountName',
        pending.expectedDisplayName || 'the expired account'
      );
    } else if (pending.alreadyExisted && !pending.expectedExternalAccountId) {
      params.set('connected', 'already');
      params.set('accountName', accountName);
    } else {
      params.set('connected', '1');
      params.set('accountName', accountName);
    }
    accountsUrl = `${accountsUrl}?${params.toString()}`;
  }

  const response = NextResponse.json({
    accountsUrl,
    addedCount: picked.length,
  });
  response.cookies.set(PENDING_COOKIE_NAME, '', {
    httpOnly: true,
    path: '/',
    maxAge: 0,
  });
  return response;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ platform: string }> }
): Promise<NextResponse> {
  const { platform } = await context.params;
  return handleConnectComplete(request, platform);
}
