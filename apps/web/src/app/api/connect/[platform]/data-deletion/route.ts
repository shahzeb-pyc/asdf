import { type NextRequest, NextResponse } from 'next/server';
import { isKnownPlatform } from '@/lib/connect/registry';
import { processPlatformRevocation } from '@/lib/connect/platform-callback';
import type { ConnectDbClient } from '@/lib/connect/persist';

/**
 * POST /api/connect/[platform]/data-deletion — stable public address a
 * platform calls when a user asks for their data to be removed. The
 * matching account is marked revoked (it can no longer publish) and the
 * platform receives the standard confirmation response pointing at the
 * Accounts page, where the workspace owner manages connected accounts.
 * Platform-specific deletion handling belongs to spec 124+.
 *
 * Audit S4: a confirmation code is issued ONLY when verification
 * actually ran and revoked a row (updated > 0). A workspace with
 * no app secret, a bad signature, or no matching account gets no
 * confirmation — previously it got a fresh code for a deletion
 * that deleted nothing. The unverifiable case is logged (the
 * revocation path logs the reason) and answered 400, so the
 * platform does not treat it as a completed deletion.
 */
export async function handleConnectDataDeletion(
  request: NextRequest,
  platformParam: string,
  dbClient?: ConnectDbClient
): Promise<NextResponse> {
  if (!isKnownPlatform(platformParam)) {
    return NextResponse.json({ error: 'Unknown platform' }, { status: 404 });
  }

  const { externalAccountId, updated } = await processPlatformRevocation(
    request,
    platformParam,
    'data-deletion',
    dbClient
  );
  if (updated === 0) {
    console.warn('[connect/data-deletion] Confirmation withheld: no verified revocation', {
      platform: platformParam,
      identified: Boolean(externalAccountId),
      updated,
    });
    return NextResponse.json(
      { error: 'Could not verify this deletion request; nothing was deleted.' },
      { status: 400 }
    );
  }

  const confirmationCode = crypto
    .randomUUID()
    .replaceAll('-', '')
    .slice(0, 16);
  console.info('[connect/data-deletion] Confirmation issued', {
    platform: platformParam,
    identified: Boolean(externalAccountId),
    confirmationCode,
  });

  const statusUrl = new URL('/accounts', request.url);
  return NextResponse.json({
    url: statusUrl.toString(),
    confirmation_code: confirmationCode,
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ platform: string }> }
): Promise<NextResponse> {
  const { platform } = await context.params;
  return handleConnectDataDeletion(request, platform);
}
