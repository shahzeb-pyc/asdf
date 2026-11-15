import { type NextRequest, NextResponse } from 'next/server';
import { buildTenantUrl, getSessionSecret } from '@fbuploadpro/contracts';
import { verifyConnectState } from '@/lib/connect/state';
import { getRequestBrandRoot } from '@/lib/brand';
import type { ConnectNoticeCode } from '@/lib/connect/errors';

/**
 * GET /api/connect/tiktok/return — where the provider sends the
 * browser back after its hosted link flow (Spec 126).
 *
 * The provider appends `isSuccess`, `accountIds`, `failedAccountIds`
 * and `error` to the redirect URL it was given (documented in the
 * provider's connection-redirect guide) — there is no OAuth code.
 * On success this route translates the return into spec 123's
 * framework callback, carrying the provider account id(s) as the
 * `code` (the TikTok config's `exchangeCode` reads the account back
 * from the provider before anything is persisted). On failure it
 * sends the user to the picker with a plain-language notice.
 */
export async function handleTikTokReturn(
  request: NextRequest
): Promise<NextResponse> {
  const rootDomain = getRequestBrandRoot(request);
  const params = request.nextUrl.searchParams;
  const state = params.get('state');
  const isSuccess = params.get('isSuccess');
  const accountIds = params.get('accountIds');
  const error = params.get('error');

  if (!state) {
    const fallback = new URL('/accounts', request.url);
    fallback.searchParams.set('error', 'connect_failed');
    return NextResponse.redirect(fallback);
  }

  let tenantSubdomain: string;
  try {
    const payload = await verifyConnectState(state, getSessionSecret());
    if (payload.platform !== 'tiktok') {
      throw new Error('State was not issued for TikTok');
    }
    tenantSubdomain = payload.tenantSubdomain;
  } catch (err) {
    console.error('[connect/tiktok] Return state invalid:', err);
    const fallback = new URL('/accounts', request.url);
    fallback.searchParams.set('error', 'connect_failed');
    return NextResponse.redirect(fallback);
  }

  const pickerRedirect = (notice: ConnectNoticeCode) => {
    const url = buildTenantUrl(
      tenantSubdomain,
      '/connect/tiktok',
      request.url,
      rootDomain
    );
    url.searchParams.set('notice', notice);
    return NextResponse.redirect(url);
  };

  if (isSuccess !== 'true' || !accountIds) {
    // The provider reports cancellations and failures the same way
    // (isSuccess=false plus a descriptive `error`); from the user's
    // side both mean "nothing was connected".
    return pickerRedirect(error ? 'denied' : 'connect_failed');
  }

  const callbackUrl = new URL(
    `${request.nextUrl.origin}/api/connect/tiktok/callback`
  );
  callbackUrl.searchParams.set('code', accountIds);
  callbackUrl.searchParams.set('state', state);
  return NextResponse.redirect(callbackUrl.toString());
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleTikTokReturn(request);
}
