import { type NextRequest, NextResponse } from 'next/server';
import { buildTenantUrl, getSessionSecret } from '@fbuploadpro/contracts';
import { verifyConnectState } from '@/lib/connect/state';
import { getRequestBrandRoot } from '@/lib/brand';
import type { ConnectNoticeCode } from '@/lib/connect/errors';
import {
  createPostForMeConnectClient,
  type PostForMeConnectClient,
} from '@/lib/connect/tiktok';

/**
 * GET /api/connect/tiktok/authorize — the initiation shim for the
 * provider link flow (Spec 126).
 *
 * Spec 123's framework redirects the browser here (this URL is the
 * TikTok connect config's `authorizeUrl`), carrying the framework's
 * signed `state`. The provider's auth URL is generated per attempt
 * by an authenticated API call, so this shim verifies the state,
 * asks the provider for a fresh auth URL with our return route as
 * the redirect target, and sends the browser on. The provider API
 * key never leaves the server.
 */
export async function handleTikTokAuthorize(
  request: NextRequest,
  client: PostForMeConnectClient = createPostForMeConnectClient()
): Promise<NextResponse> {
  const rootDomain = getRequestBrandRoot(request);
  const state = request.nextUrl.searchParams.get('state');

  if (!state) {
    return NextResponse.json(
      { error: 'This connection link is incomplete. Please start again from Accounts.' },
      { status: 400 }
    );
  }

  let tenantSubdomain: string;
  try {
    const payload = await verifyConnectState(state, getSessionSecret());
    if (payload.platform !== 'tiktok') {
      throw new Error('State was not issued for TikTok');
    }
    tenantSubdomain = payload.tenantSubdomain;
  } catch (err) {
    console.error('[connect/tiktok] Authorize state invalid:', err);
    return NextResponse.json(
      { error: 'This connection link has expired. Please start again from Accounts.' },
      { status: 400 }
    );
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

  const returnUrl = `${request.nextUrl.origin}/api/connect/tiktok/return?state=${encodeURIComponent(state)}`;

  try {
    const { url } = await client.createAuthUrl({
      platform: 'tiktok',
      redirectUrl: returnUrl,
    });
    if (!url) throw new Error('Provider returned no auth URL');
    return NextResponse.redirect(url);
  } catch (err) {
    console.error('[connect/tiktok] Failed to start provider flow:', err);
    return pickerRedirect('connect_failed');
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handleTikTokAuthorize(request);
}
