import { type NextRequest, NextResponse } from 'next/server';
import { getSessionSecret } from '@fbuploadpro/contracts';
import { handleConnectComplete } from '@/app/api/connect/[platform]/complete/route';
import {
  verifyPendingDestinations,
  PENDING_COOKIE_NAME,
  type PendingDestinationsPayload,
} from '@/lib/connect/state';
import {
  resolveConnectDbClient,
} from '@/lib/connect/session';
import {
  mergeRowMetadata,
  type ConnectDbClient,
} from '@/lib/connect/persist';
import type { TikTokDiscoveredDestination } from '@/lib/connect/tiktok';


/**
 * POST /api/connect/tiktok/complete — finishes a TikTok connect
 * (Spec 126). A static segment, so it wins over the framework's
 * `[platform]` complete route for TikTok only.
 *
 * The heavy lifting is the framework's: session check, pending
 * cookie verification, and persisting the destinations the user
 * confirmed in the read-back step. This wrapper adds the one
 * TikTok-specific write the framework has no field for: the
 * provider account ref (`providerAccountId`, carried through the
 * pending cookie on the discovered destination) is merged into
 * `social_accounts.metadata` and into each picked destination's
 * `metadata` — the worker's TikTok publisher reads it from the
 * destination when it submits posts to the provider.
 */

interface PendingPick {
  pending: PendingDestinationsPayload;
  pickedExternalIds: string[];
  providerAccountId: string | null;
}

async function readPendingPick(
  request: NextRequest
): Promise<PendingPick | null> {
  const pendingCookie = request.cookies.get(PENDING_COOKIE_NAME)?.value;
  if (!pendingCookie) return null;
  let pending: PendingDestinationsPayload;
  try {
    pending = await verifyPendingDestinations(
      pendingCookie,
      getSessionSecret()
    );
  } catch (err) {
    console.error(
      '[connect/tiktok] Pending destinations cookie could not be verified:',
      err
    );
    return null;
  }
  if (pending.platform !== 'tiktok') return null;

  let requestedIds = new Set<string>();
  try {
    const body = (await request.clone().json()) as {
      destinationIds?: unknown;
    };
    if (Array.isArray(body.destinationIds)) {
      requestedIds = new Set(
        body.destinationIds.filter(
          (id): id is string => typeof id === 'string'
        )
      );
    }
  } catch (err) {
    console.error(
      '[connect/tiktok] Complete request body could not be parsed:',
      err
    );
    return { pending, pickedExternalIds: [], providerAccountId: null };
  }

  const picked = pending.destinations.filter((destination) =>
    requestedIds.has(destination.externalDestinationId)
  );
  const firstPicked = picked[0] as
    | TikTokDiscoveredDestination
    | undefined;
  const providerAccountId = firstPicked
    ? firstPicked.providerAccountId
    : null;
  return {
    pending,
    pickedExternalIds: picked.map((d) => d.externalDestinationId),
    providerAccountId,
  };
}

async function persistProviderAccountRef(
  client: ConnectDbClient,
  pick: PendingPick
): Promise<void> {
  if (!pick.providerAccountId || pick.pickedExternalIds.length === 0) {
    return;
  }
  const patch = { providerAccountId: pick.providerAccountId };
  await mergeRowMetadata(client, 'social_accounts', { id: pick.pending.accountId }, patch);
  for (const externalId of pick.pickedExternalIds) {
    await mergeRowMetadata(
      client,
      'destinations',
      {
        account_id: pick.pending.accountId,
        external_destination_id: externalId,
      },
      patch
    );
  }
}

export async function handleTikTokComplete(
  request: NextRequest,
  dbClient?: ConnectDbClient
): Promise<NextResponse> {
  // Read the pending pick BEFORE delegating: the framework consumes
  // the request body and clears the pending cookie in its response.
  const pick = await readPendingPick(request);

  const response = await handleConnectComplete(request, 'tiktok');

  if (response.status === 200 && pick?.providerAccountId) {
    const client = resolveConnectDbClient(dbClient);
    if (client) {
      try {
        await persistProviderAccountRef(client, pick);
      } catch (err) {
        // The destinations are saved; a missing provider ref fails
        // publishing closed with a reconnect message until a
        // reconnect rewrites it. Never fail the connect over it.
        console.error(
          '[connect/tiktok] Failed to persist provider account ref:',
          err
        );
      }
    }
  }
  return response;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handleTikTokComplete(request);
}
