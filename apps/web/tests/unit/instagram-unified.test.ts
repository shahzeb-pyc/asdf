import { describe, expect, it } from 'vitest';
import { INSTAGRAM_UNIFIED_OAUTH_SCOPES } from '@fbuploadpro/contracts';
import {
  buildInstagramScopeRejectionMessage,
  findMissingInstagramScopes,
  parseInstagramPermissions,
  parseMissingInstagramScopesParam,
} from '../../src/lib/instagram-permissions';
import {
  buildInstagramUnifiedDialogUrl,
  exchangeInstagramUnifiedCode,
  probeInstagramUnifiedPermissions,
} from '../../src/lib/connect/platforms/instagram-unified';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('Instagram Unified Login scopes', () => {
  it('is exactly the four hard-required permissions, single-sourced from contracts', () => {
    expect([...INSTAGRAM_UNIFIED_OAUTH_SCOPES]).toEqual([
      'instagram_basic',
      'instagram_content_publish',
      'instagram_manage_comments',
      'instagram_manage_insights',
    ]);
  });

  it('treats a declined, absent, or non-granted name as missing', () => {
    const permissions = [
      { permission: 'instagram_basic', status: 'granted' },
      { permission: 'instagram_content_publish', status: 'declined' },
      { permission: 'instagram_manage_comments', status: 'granted' },
    ];
    expect(findMissingInstagramScopes(permissions)).toEqual([
      'instagram_content_publish',
      'instagram_manage_insights',
    ]);
  });

  it('names the missing permissions in plain language in the rejection banner', () => {
    expect(
      buildInstagramScopeRejectionMessage(
        parseMissingInstagramScopesParam('instagram_manage_comments,instagram_manage_insights')
      )
    ).toContain('managing comments');
    expect(
      buildInstagramScopeRejectionMessage(
        parseMissingInstagramScopesParam('instagram_manage_comments,instagram_manage_insights')
      )
    ).toContain('viewing insights');
  });

  it('uses the singular form when exactly one permission is missing', () => {
    expect(buildInstagramScopeRejectionMessage(['instagram_basic'])).toContain(
      'A required permission — reading your profile and media — was declined.'
    );
  });

  it('uses the generic form when the missing list is empty', () => {
    expect(buildInstagramScopeRejectionMessage([])).toContain(
      'A required permission was declined.'
    );
  });

  it('treats malformed permission payloads as an empty list, never as granted', () => {
    expect(parseInstagramPermissions(null)).toEqual([]);
    expect(parseInstagramPermissions({})).toEqual([]);
    expect(parseInstagramPermissions({ data: 'not-an-array' })).toEqual([]);
    expect(
      parseInstagramPermissions({
        data: [null, 'not-an-object', { permission: 'instagram_basic', status: 'granted' }],
      })
    ).toEqual([{ permission: 'instagram_basic', status: 'granted' }]);
  });
});

describe('Instagram Unified Login dialog', () => {
  it('builds the Facebook dialog URL with config_id and no scope parameter', () => {
    const url = new URL(
      buildInstagramUnifiedDialogUrl({
        appId: '123456789012345',
        configId: '987654321',
        redirectUri: 'https://acme.fbuploadpro.com/api/auth/instagram/callback',
        state: 'state123',
      })
    );
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('123456789012345');
    expect(url.searchParams.get('config_id')).toBe('987654321');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('display')).toBe('popup');
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.has('scope')).toBe(false);
  });
});

describe('Instagram Unified Login exchange and probe', () => {
  function unifiedFetch() {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      if (url.includes('/oauth/access_token')) {
        return jsonResponse({ access_token: 'bisu_token_abc', token_type: 'bearer' });
      }
      if (url.includes('/me?fields=client_business_id')) {
        return jsonResponse({ client_business_id: 'biz_1', id: 'sys_1' });
      }
      if (url.includes('/me/assigned_instagram_accounts')) {
        return jsonResponse({
          data: [
            { id: 'ig_1', username: 'bakery' },
            { id: 'ig_2', username: 'bakery2' },
          ],
        });
      }
      if (url.includes('/me/permissions')) {
        return jsonResponse({
          data: [
            { permission: 'instagram_basic', status: 'granted' },
            { permission: 'instagram_content_publish', status: 'granted' },
            { permission: 'instagram_manage_comments', status: 'granted' },
            { permission: 'instagram_manage_insights', status: 'granted' },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  it('exchanges with App ID, Secret, code and redirect_uri, then reads business ID and all shared accounts', async () => {
    const { fetchFn, calls } = unifiedFetch();
    const result = await exchangeInstagramUnifiedCode({
      code: 'code123',
      redirectUri: 'https://acme.fbuploadpro.com/api/auth/instagram/callback',
      appId: '123456789012345',
      appSecret: 'secret',
      fetchFn,
    });
    expect(result.accessToken).toBe('bisu_token_abc');
    expect(result.clientBusinessId).toBe('biz_1');
    expect(result.accounts).toEqual([
      { id: 'ig_1', username: 'bakery' },
      { id: 'ig_2', username: 'bakery2' },
    ]);
    const exchangeUrl = new URL(calls[0]);
    expect(exchangeUrl.searchParams.get('client_id')).toBe('123456789012345');
    expect(exchangeUrl.searchParams.get('code')).toBe('code123');
    expect(exchangeUrl.searchParams.get('redirect_uri')).toBe(
      'https://acme.fbuploadpro.com/api/auth/instagram/callback'
    );
    expect(exchangeUrl.searchParams.has('config_id')).toBe(false);
  });

  it('probe reports granted when all four are granted', async () => {
    const { fetchFn } = unifiedFetch();
    expect(
      await probeInstagramUnifiedPermissions({ accessToken: 'bisu_token_abc', fetchFn })
    ).toEqual({ kind: 'granted' });
  });

  it('probe reports unknown on a non-OK response (caller must fail open)', async () => {
    const fetchFn = (async () => jsonResponse({ error: 'boom' }, false, 500)) as unknown as typeof fetch;
    expect(
      await probeInstagramUnifiedPermissions({ accessToken: 'bisu_token_abc', fetchFn })
    ).toEqual({ kind: 'unknown' });
  });

  it('probe reports unknown when the fetch throws (caller must fail open)', async () => {
    const fetchFn = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(
      await probeInstagramUnifiedPermissions({ accessToken: 'bisu_token_abc', fetchFn })
    ).toEqual({ kind: 'unknown' });
  });
});
