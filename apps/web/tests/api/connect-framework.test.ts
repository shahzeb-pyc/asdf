import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import {
  decryptToken,
  encryptToken,
  signSessionToken,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import {
  clearPlatformConnectConfigsForTests,
  registerPlatformConnectConfig,
  type DiscoveredDestination,
  type ExchangedAccount,
} from '@/lib/connect/registry';
import {
  createConnectStatePayload,
  signConnectState,
  signPendingDestinations,
  verifyConnectState,
} from '@/lib/connect/state';
import { CONNECT_NOTICE_MESSAGES } from '@/lib/connect/errors';
import { handleConnectInitiate, GET as initiateGET } from '@/app/api/connect/[platform]/route';
import { handleConnectCallback, GET as callbackGET } from '@/app/api/connect/[platform]/callback/route';
import { handleConnectComplete, POST as completePOST } from '@/app/api/connect/[platform]/complete/route';
import { handleConnectDeauthorize, POST as deauthorizePOST } from '@/app/api/connect/[platform]/deauthorize/route';
import { handleConnectDataDeletion, POST as dataDeletionPOST } from '@/app/api/connect/[platform]/data-deletion/route';
import { handleListSocialAccounts, GET as socialListGET } from '@/app/api/tenant/[subdomain]/accounts/social/route';
import { handleGetSocialDestination, GET as socialDetailGET } from '@/app/api/tenant/[subdomain]/accounts/social/[destinationId]/route';
import type { SupabaseClient } from '@supabase/supabase-js';

const TEST_SECRET = 'test_session_secret_at_least_32_chars_long_value';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const userId = '11111111-1111-4111-a111-111111111111';
const workspaceId = '22222222-2222-4222-a222-222222222222';
const subdomain = 'acme';

const FIXTURE_ACCOUNT: ExchangedAccount = {
  externalAccountId: 'ext-acct-1',
  displayName: 'Fixture Creator',
  avatarUrl: null,
  accessToken: 'fixture_access_token_plain',
  refreshToken: 'fixture_refresh_token_plain',
  expiresIn: 3600,
  scopes: ['basic', 'publish'],
};

const FIXTURE_DESTINATIONS: DiscoveredDestination[] = [
  { externalDestinationId: 'dest-1001', name: 'My Brand', handle: 'mybrand.one' },
  { externalDestinationId: 'dest-2002', name: 'My Brand', handle: 'mybrand.two' },
  { externalDestinationId: 'dest-3003', name: 'Side Project', handle: 'sideproject' },
];

interface SocialAccountStoreRow {
  id: string;
  workspace_id: string;
  platform: string;
  external_account_id: string;
  display_name: string;
  avatar_url: string | null;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  token_expires_at: string | null;
  scopes: string[];
  status: string;
  created_at: string;
  updated_at: string;
}

interface DestinationStoreRow {
  id: string;
  workspace_id: string;
  account_id: string;
  platform: string;
  external_destination_id: string;
  name: string;
  handle: string | null;
  avatar_url: string | null;
  timezone: string;
  status: string;
  created_at: string;
}

class FakeDb {
  accounts = new Map<string, SocialAccountStoreRow>();
  destinations = new Map<string, DestinationStoreRow>();
  credentials = new Map<string, { client_id: string; encrypted_client_secret: string }>();
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  workspaceMissing = false;

  query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM workspaces')) {
      return this.workspaceMissing ? [] : [{ id: workspaceId }];
    }
    if (sql.includes('FROM platform_credentials')) {
      const row =
        this.credentials.get(`${String(params[0])}|${String(params[1])}`) ??
        this.credentials.get(String(params[1]));
      return row ? [row] : [];
    }
    return this.queryData(sql, params);
  });

  private queryData = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO social_accounts')) return this.upsertAccount(params);
    if (sql.includes('INSERT INTO destinations')) return this.insertDestination(params);
    if (sql.includes('UPDATE social_accounts')) return this.revokeAccounts(params);
    if (sql.includes('JOIN social_accounts')) return this.destinationDetail(params);
    if (sql.includes('FROM social_accounts') && sql.includes('external_account_id')) {
      return [...this.accounts.values()].filter(
        (r) => r.platform === params[0] && r.external_account_id === params[1]
      );
    }
    if (sql.includes('FROM destinations')) {
      return [...this.destinations.values()].filter((r) => r.workspace_id === params[0]);
    }
    if (sql.includes('FROM social_accounts')) {
      return [...this.accounts.values()].filter((r) => r.workspace_id === params[0]);
    }
    return [];
  };

  private upsertAccount = (params: unknown[]) => {
    const [
      wsId, platform, externalAccountId, displayName, avatarUrl,
      encAccess, encRefresh, expiresAt, scopes,
    ] = params as [string, string, string, string, string | null, string, string | null, string | null, string[]];
    const key = `${wsId}|${platform}|${externalAccountId}`;
    const existing = this.accounts.get(key);
    if (existing) {
      existing.display_name = displayName;
      existing.avatar_url = avatarUrl;
      existing.encrypted_access_token = encAccess;
      existing.encrypted_refresh_token = encRefresh ?? existing.encrypted_refresh_token;
      existing.token_expires_at = expiresAt;
      existing.scopes = scopes;
      existing.status = 'active';
      return [{ id: existing.id }];
    }
    const row: SocialAccountStoreRow = {
      id: this.nextId('acct'),
      workspace_id: wsId,
      platform,
      external_account_id: externalAccountId,
      display_name: displayName,
      avatar_url: avatarUrl,
      encrypted_access_token: encAccess,
      encrypted_refresh_token: encRefresh,
      token_expires_at: expiresAt,
      scopes,
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.accounts.set(key, row);
    return [{ id: row.id }];
  };

  private insertDestination = (params: unknown[]) => {
    const [wsId, accountId, platform, externalDestinationId, name, handle, avatarUrl] =
      params as [string, string, string, string, string, string | null, string | null];
    const key = `${accountId}|${externalDestinationId}`;
    if (this.destinations.has(key)) return [];
    const row: DestinationStoreRow = {
      id: this.nextId('dest-row'),
      workspace_id: wsId,
      account_id: accountId,
      platform,
      external_destination_id: externalDestinationId,
      name,
      handle,
      avatar_url: avatarUrl,
      timezone: 'UTC',
      status: 'active',
      created_at: new Date().toISOString(),
    };
    this.destinations.set(key, row);
    return [{ id: row.id }];
  };

  private revokeAccounts = (params: unknown[]) => {
    const [platform, externalAccountId, wsId] = params as [string, string, string?];
    const updated: Array<{ id: string }> = [];
    for (const row of this.accounts.values()) {
      if (
        row.platform === platform &&
        row.external_account_id === externalAccountId &&
        (!wsId || row.workspace_id === wsId)
      ) {
        row.status = 'revoked';
        updated.push({ id: row.id });
      }
    }
    return updated;
  };

  private destinationDetail = (params: unknown[]) => {
    const [destinationId, wsId] = params as [string, string];
    for (const row of this.destinations.values()) {
      if (row.id === destinationId && row.workspace_id === wsId) {
        const account = [...this.accounts.values()].find((a) => a.id === row.account_id);
        return [{
          ...row,
          account_display_name: account?.display_name ?? '',
          account_status: account?.status ?? 'active',
        }];
      }
    }
    return [];
  };
}

describe('Connect framework (Spec 123 Part C) with a fixture platform', () => {
  let db: FakeDb;
  let dbClient: DatabaseClient;
  let sessionCookie: string;

  beforeAll(async () => {
    clearPlatformConnectConfigsForTests();
    registerPlatformConnectConfig({
      platform: 'instagram',
      authorizeUrl: 'https://fixture.example/authorize',
      clientIdSource: 'byoc',
      scopes: ['basic', 'publish'],
      usePkce: false,
      destinationMode: 'picker',
      exchangeCode: async () => FIXTURE_ACCOUNT,
      fetchDestinations: async () => FIXTURE_DESTINATIONS,
    });
    registerPlatformConnectConfig({
      platform: 'x',
      authorizeUrl: 'https://fixture-x.example/authorize',
      clientIdSource: 'global',
      scopes: ['tweet.read', 'tweet.write'],
      usePkce: true,
      destinationMode: 'single-confirm',
      exchangeCode: async () => ({
        ...FIXTURE_ACCOUNT,
        externalAccountId: 'ext-x-1',
      }),
      fetchDestinations: async () => [
        { externalDestinationId: 'x-dest-1', name: 'Fixture X', handle: 'fixturex' },
      ],
    });
    registerPlatformConnectConfig({
      platform: 'threads',
      authorizeUrl: 'https://fixture-threads.example/authorize',
      clientIdSource: 'byoc',
      scopes: ['threads_basic'],
      usePkce: false,
      destinationMode: 'single-confirm',
      exchangeCode: async () => {
        throw new Error('fixture exchange failure');
      },
      fetchDestinations: async () => [],
    });
    registerPlatformConnectConfig({
      platform: 'tiktok',
      authorizeUrl: 'https://fixture-tiktok.example/authorize',
      clientIdSource: 'global',
      scopes: ['user.info.basic'],
      usePkce: false,
      destinationMode: 'picker',
      exchangeCode: async () => ({
        ...FIXTURE_ACCOUNT,
        externalAccountId: 'ext-tt-1',
      }),
      fetchDestinations: async () => [],
    });
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
    process.env.CONNECT_X_CLIENT_ID = 'x_global_client_id';
    process.env.CONNECT_TIKTOK_CLIENT_ID = 'tiktok_global_client_id';

    db = new FakeDb();
    dbClient = db as unknown as DatabaseClient;
    db.credentials.set('instagram', {
      client_id: 'fixture_ig_app_id',
      encrypted_client_secret: await encryptToken('fixture_ig_secret', TEST_ENCRYPTION_KEY),
    });

    const token = await signSessionToken(
      {
        userId,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain,
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    sessionCookie = `fbup_session=${token}`;
  });

  async function initiateInstagram(): Promise<{ res: Response; state: string }> {
    const req = new NextRequest(
      `http://localhost:3000/api/connect/instagram?subdomain=${subdomain}`,
      { headers: { cookie: sessionCookie } }
    );
    const res = await handleConnectInitiate(req, 'instagram', dbClient);
    const location = res.headers.get('location') ?? '';
    const state = new URL(location).searchParams.get('state') ?? '';
    return { res, state };
  }

  async function runCallback(state: string): Promise<Response> {
    const req = new NextRequest(
      `http://localhost:3000/api/connect/instagram/callback?code=fixture_code&state=${encodeURIComponent(state)}`
    );
    return handleConnectCallback(req, 'instagram', dbClient);
  }

  const FIXTURE_APP_SECRET = 'fixture_ig_secret';

  function base64UrlEncode(buffer: Buffer): string {
    return buffer
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
  }

  /** Builds a Meta-style signed_request: base64url(HMAC-SHA256(payload segment, secret)) + '.' + base64url(payload). */
  function buildSignedRequest(
    payload: Record<string, unknown>,
    secret: string
  ): string {
    const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
    const signature = createHmac('sha256', secret).update(payloadB64).digest();
    return `${base64UrlEncode(signature)}.${payloadB64}`;
  }

  function signedBodyForFixtureAccount(secret: string = FIXTURE_APP_SECRET): string {
    return JSON.stringify({
      signed_request: buildSignedRequest(
        { user_id: FIXTURE_ACCOUNT.externalAccountId, algorithm: 'HMAC-SHA256' },
        secret
      ),
    });
  }

  function cookieValue(res: Response, name: string): string | null {
    const setCookies = res.headers.getSetCookie();
    for (const entry of setCookies) {
      if (entry.startsWith(`${name}=`)) {
        const value = entry.slice(name.length + 1).split(';')[0];
        return value ? decodeURIComponent(value) : null;
      }
    }
    return null;
  }

  it('initiate builds the authorize URL with signed state and the workspace app ID', async () => {
    const { res, state } = await initiateInstagram();
    expect(res.status).toBe(307);
    const url = new URL(res.headers.get('location') ?? '');
    expect(url.origin).toBe('https://fixture.example');
    expect(url.searchParams.get('client_id')).toBe('fixture_ig_app_id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3000/api/connect/instagram/callback'
    );
    expect(url.searchParams.get('scope')).toBe('basic publish');
    expect(state).toBeTruthy();
    const payload = await verifyConnectState(state, TEST_SECRET);
    expect(payload.workspaceId).toBe(workspaceId);
    expect(payload.platform).toBe('instagram');
    expect(payload.userId).toBe(userId);
    expect(payload.tenantSubdomain).toBe(subdomain);
  });

  it('initiate with PKCE adds a code challenge and sets the verifier cookie', async () => {
    const req = new NextRequest(
      `http://localhost:3000/api/connect/x?subdomain=${subdomain}`,
      { headers: { cookie: sessionCookie } }
    );
    const res = await handleConnectInitiate(req, 'x', dbClient);
    expect(res.status).toBe(307);
    const url = new URL(res.headers.get('location') ?? '');
    expect(url.searchParams.get('client_id')).toBe('x_global_client_id');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(cookieValue(res, 'fbup_connect_pkce')).toBeTruthy();
  });

  it('initiate redirects to login without a session', async () => {
    const req = new NextRequest(
      `http://localhost:3000/api/connect/instagram?subdomain=${subdomain}`
    );
    const res = await handleConnectInitiate(req, 'instagram', dbClient);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login');
  });

  it('initiate redirects an unknown platform to the Facebook accounts URL with an error', async () => {
    const req = new NextRequest(
      `http://localhost:3000/api/connect/myspace?subdomain=${subdomain}`,
      { headers: { cookie: sessionCookie } }
    );
    const res = await handleConnectInitiate(req, 'myspace', dbClient);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      `http://localhost:3000/tenant/${subdomain}/accounts?error=connect_failed`
    );
  });

  it('callback persists the account with encrypted tokens and redirects to the picker', async () => {
    const { state } = await initiateInstagram();
    const res = await runCallback(state);
    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain(`/tenant/${subdomain}/connect/instagram`);
    expect(cookieValue(res, 'fbup_connect_pending')).toBeTruthy();

    expect(db.accounts.size).toBe(1);
    const row = [...db.accounts.values()][0];
    expect(row.external_account_id).toBe(FIXTURE_ACCOUNT.externalAccountId);
    expect(row.encrypted_access_token).not.toBe(FIXTURE_ACCOUNT.accessToken);
    expect(row.encrypted_access_token).not.toContain(FIXTURE_ACCOUNT.accessToken);
    expect(await decryptToken(row.encrypted_access_token, TEST_ENCRYPTION_KEY)).toBe(
      FIXTURE_ACCOUNT.accessToken
    );
    expect(row.token_expires_at).toBeTruthy();
    expect(row.scopes).toEqual(['basic', 'publish']);
    expect(row.status).toBe('active');
  });

  it('complete persists only the picked destinations and returns the Accounts landing URL', async () => {
    const { state } = await initiateInstagram();
    const callbackRes = await runCallback(state);
    const pending = cookieValue(callbackRes, 'fbup_connect_pending');
    expect(pending).toBeTruthy();

    const req = new NextRequest('http://localhost:3000/api/connect/instagram/complete', {
      method: 'POST',
      headers: {
        cookie: `${sessionCookie}; fbup_connect_pending=${encodeURIComponent(pending ?? '')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ destinationIds: ['dest-1001', 'dest-3003', 'not-a-real-id'] }),
    });
    const res = await handleConnectComplete(req, 'instagram', dbClient);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { accountsUrl: string; addedCount: number };
    // Per-platform landing page: Instagram lands on its own accounts page.
    expect(data.accountsUrl).toBe(`/tenant/${subdomain}/instagram/accounts`);
    expect(data.addedCount).toBe(2);
    const storedIds = [...db.destinations.values()].map((d) => d.external_destination_id);
    expect(storedIds.sort((a, b) => a.localeCompare(b))).toEqual(['dest-1001', 'dest-3003']);
  });

  it('complete returns the Facebook accounts URL for facebook (unchanged)', async () => {
    const pending = await signPendingDestinations(
      {
        accountId: 'acct-1',
        workspaceId,
        tenantSubdomain: subdomain,
        platform: 'facebook',
        destinations: FIXTURE_DESTINATIONS,
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      TEST_SECRET
    );
    const req = new NextRequest('http://localhost:3000/api/connect/facebook/complete', {
      method: 'POST',
      headers: {
        cookie: `${sessionCookie}; fbup_connect_pending=${pending}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ destinationIds: ['dest-1001'] }),
    });
    const res = await handleConnectComplete(req, 'facebook', dbClient);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { accountsUrl: string; addedCount: number };
    expect(data.accountsUrl).toBe(`/tenant/${subdomain}/accounts`);
    expect(data.addedCount).toBe(1);
  });

  it('complete returns the per-platform accounts URL for threads and x', async () => {
    for (const [platform, path] of [
      ['threads', 'threads'],
      ['x', 'x'],
    ] as const) {
      const pending = await signPendingDestinations(
        {
          accountId: 'acct-1',
          workspaceId,
          tenantSubdomain: subdomain,
          platform,
          destinations: FIXTURE_DESTINATIONS,
          exp: Math.floor(Date.now() / 1000) + 600,
        },
        TEST_SECRET
      );
      const req = new NextRequest(`http://localhost:3000/api/connect/${platform}/complete`, {
        method: 'POST',
        headers: {
          cookie: `${sessionCookie}; fbup_connect_pending=${pending}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ destinationIds: ['dest-1001'] }),
      });
      const res = await handleConnectComplete(req, platform, dbClient);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { accountsUrl: string; addedCount: number };
      expect(data.accountsUrl).toBe(`/tenant/${subdomain}/${path}/accounts`);
    }
  });

  it('reconnect re-binds the same social_accounts row instead of duplicating it', async () => {
    const first = await initiateInstagram();
    await runCallback(first.state);
    expect(db.accounts.size).toBe(1);
    const firstId = [...db.accounts.values()][0].id;

    const second = await initiateInstagram();
    await runCallback(second.state);
    expect(db.accounts.size).toBe(1);
    expect([...db.accounts.values()][0].id).toBe(firstId);
  });

  it('callback denial lands on a plain-language notice with no jargon', async () => {
    const { state } = await initiateInstagram();
    const req = new NextRequest(
      `http://localhost:3000/api/connect/instagram/callback?error=access_denied&state=${encodeURIComponent(state)}`
    );
    const res = await handleConnectCallback(req, 'instagram', dbClient);
    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain(`/tenant/${subdomain}/connect/instagram`);
    expect(location).toContain('notice=denied');
    expect(db.accounts.size).toBe(0);

    const message = CONNECT_NOTICE_MESSAGES.denied;
    expect(message).toBe('Connection canceled. No changes were made.');
    for (const notice of Object.values(CONNECT_NOTICE_MESSAGES)) {
      expect(notice).not.toMatch(/oauth|scope|endpoint|token/i);
    }
  });

  async function manualState(platform: 'instagram' | 'threads' | 'tiktok' | 'x'): Promise<string> {
    const payload = createConnectStatePayload({
      workspaceId,
      tenantSubdomain: subdomain,
      userId,
      platform,
    });
    return signConnectState(payload, TEST_SECRET);
  }

  it('completes a PKCE flow end to end when the verifier cookie is present', async () => {
    const initReq = new NextRequest(
      `http://localhost:3000/api/connect/x?subdomain=${subdomain}`,
      { headers: { cookie: sessionCookie } }
    );
    const initRes = await handleConnectInitiate(initReq, 'x', dbClient);
    const state = new URL(initRes.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const pkce = cookieValue(initRes, 'fbup_connect_pkce');
    expect(pkce).toBeTruthy();

    const cbReq = new NextRequest(
      `http://localhost:3000/api/connect/x/callback?code=x_code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `fbup_connect_pkce=${encodeURIComponent(pkce ?? '')}` } }
    );
    const cbRes = await handleConnectCallback(cbReq, 'x', dbClient);
    expect(cbRes.status).toBe(307);
    expect(cbRes.headers.get('location')).toContain(`/tenant/${subdomain}/connect/x`);
    expect(cookieValue(cbRes, 'fbup_connect_pending')).toBeTruthy();
    const row = [...db.accounts.values()].find((a) => a.platform === 'x');
    expect(row?.external_account_id).toBe('ext-x-1');
  });

  it('rejects a PKCE callback when the verifier cookie is missing', async () => {
    const initReq = new NextRequest(
      `http://localhost:3000/api/connect/x?subdomain=${subdomain}`,
      { headers: { cookie: sessionCookie } }
    );
    const initRes = await handleConnectInitiate(initReq, 'x', dbClient);
    const state = new URL(initRes.headers.get('location') ?? '').searchParams.get('state') ?? '';

    const cbReq = new NextRequest(
      `http://localhost:3000/api/connect/x/callback?code=x_code&state=${encodeURIComponent(state)}`
    );
    const cbRes = await handleConnectCallback(cbReq, 'x', dbClient);
    expect(cbRes.headers.get('location')).toContain('notice=expired_link');
    expect(db.accounts.size).toBe(0);
  });

  it('surfaces a plain-language failure when the code exchange fails', async () => {
    db.credentials.set('threads', {
      client_id: 'fixture_threads_app_id',
      encrypted_client_secret: await encryptToken('fixture_threads_secret', TEST_ENCRYPTION_KEY),
    });
    const state = await manualState('threads');
    const req = new NextRequest(
      `http://localhost:3000/api/connect/threads/callback?code=abc&state=${encodeURIComponent(state)}`
    );
    const res = await handleConnectCallback(req, 'threads', dbClient);
    expect(res.headers.get('location')).toContain('notice=connect_failed');
    expect(db.accounts.size).toBe(0);
  });

  it('surfaces nothing_found when the platform returns no destinations', async () => {
    const state = await manualState('tiktok');
    const req = new NextRequest(
      `http://localhost:3000/api/connect/tiktok/callback?code=abc&state=${encodeURIComponent(state)}`
    );
    const res = await handleConnectCallback(req, 'tiktok', dbClient);
    expect(res.headers.get('location')).toContain('notice=nothing_found');
  });

  it('asks for credentials first when the workspace has none saved at callback time', async () => {
    db.credentials.delete('instagram');
    const state = await manualState('instagram');
    const req = new NextRequest(
      `http://localhost:3000/api/connect/instagram/callback?code=abc&state=${encodeURIComponent(state)}`
    );
    const res = await handleConnectCallback(req, 'instagram', dbClient);
    expect(res.headers.get('location')).toContain('notice=credentials_required');
  });

  it('rejects a callback whose state belongs to a different platform', async () => {
    const { state } = await initiateInstagram();
    const req = new NextRequest(
      `http://localhost:3000/api/connect/threads/callback?code=abc&state=${encodeURIComponent(state)}`
    );
    const res = await handleConnectCallback(req, 'threads', dbClient);
    expect(res.headers.get('location')).toContain('notice=expired_link');
  });

  it('reports a missing reply when the callback has no code', async () => {
    const { state } = await initiateInstagram();
    const req = new NextRequest(
      `http://localhost:3000/api/connect/instagram/callback?state=${encodeURIComponent(state)}`
    );
    const res = await handleConnectCallback(req, 'instagram', dbClient);
    expect(res.headers.get('location')).toContain('notice=missing_reply');
  });

  it('initiate guards: unknown platform, unregistered platform, forbidden tenant, missing global app', async () => {
    const unknownRes = await handleConnectInitiate(
      new NextRequest(`http://localhost:3000/api/connect/myspace?subdomain=${subdomain}`, {
        headers: { cookie: sessionCookie },
      }),
      'myspace',
      dbClient
    );
    expect(unknownRes.headers.get('location')).toContain('error=connect_failed');

    const unregisteredRes = await handleConnectInitiate(
      new NextRequest(`http://localhost:3000/api/connect/facebook?subdomain=${subdomain}`, {
        headers: { cookie: sessionCookie },
      }),
      'facebook',
      dbClient
    );
    expect(unregisteredRes.headers.get('location')).toContain('error=connect_failed');

    const forbiddenRes = await handleConnectInitiate(
      new NextRequest('http://localhost:3000/api/connect/instagram?subdomain=other-tenant', {
        headers: { cookie: sessionCookie },
      }),
      'instagram',
      dbClient
    );
    expect(forbiddenRes.status).toBe(403);

    delete process.env.CONNECT_X_CLIENT_ID;
    const noGlobalRes = await handleConnectInitiate(
      new NextRequest(`http://localhost:3000/api/connect/x?subdomain=${subdomain}`, {
        headers: { cookie: sessionCookie },
      }),
      'x',
      dbClient
    );
    expect(noGlobalRes.headers.get('location')).toContain('error=connect_failed');
  });

  it('initiate sends BYOC platforms without saved details to Settings first', async () => {
    db.credentials.delete('instagram');
    const res = await handleConnectInitiate(
      new NextRequest(`http://localhost:3000/api/connect/instagram?subdomain=${subdomain}`, {
        headers: { cookie: sessionCookie },
      }),
      'instagram',
      dbClient
    );
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/settings');
    expect(location).toContain('error=credentials_required');
  });

  it('complete rejects a pending flow for another tenant and an empty pick', async () => {
    const foreignPending = await signPendingDestinations(
      {
        accountId: 'acct-foreign',
        workspaceId,
        tenantSubdomain: 'other-tenant',
        platform: 'instagram',
        destinations: FIXTURE_DESTINATIONS,
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      TEST_SECRET
    );
    const foreignRes = await handleConnectComplete(
      new NextRequest('http://localhost:3000/api/connect/instagram/complete', {
        method: 'POST',
        headers: {
          cookie: `${sessionCookie}; fbup_connect_pending=${foreignPending}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ destinationIds: ['dest-1001'] }),
      }),
      'instagram',
      dbClient
    );
    expect(foreignRes.status).toBe(403);

    const { state } = await initiateInstagram();
    const callbackRes = await runCallback(state);
    const pending = cookieValue(callbackRes, 'fbup_connect_pending');
    const emptyRes = await handleConnectComplete(
      new NextRequest('http://localhost:3000/api/connect/instagram/complete', {
        method: 'POST',
        headers: {
          cookie: `${sessionCookie}; fbup_connect_pending=${encodeURIComponent(pending ?? '')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ destinationIds: [] }),
      }),
      'instagram',
      dbClient
    );
    expect(emptyRes.status).toBe(400);
  });

  it('initiate returns 404 when the workspace cannot be found', async () => {
    db.workspaceMissing = true;
    const res = await handleConnectInitiate(
      new NextRequest(`http://localhost:3000/api/connect/instagram?subdomain=${subdomain}`, {
        headers: { cookie: sessionCookie },
      }),
      'instagram',
      dbClient
    );
    expect(res.status).toBe(404);
  });

  it('social list returns 404 when the workspace cannot be found', async () => {
    db.workspaceMissing = true;
    const res = await handleListSocialAccounts(
      new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/accounts/social`, {
        headers: { cookie: sessionCookie },
      }),
      subdomain,
      dbClient
    );
    expect(res.status).toBe(404);
  });

  it('complete rejects a malformed JSON body', async () => {
    const { state } = await initiateInstagram();
    const callbackRes = await runCallback(state);
    const pending = cookieValue(callbackRes, 'fbup_connect_pending');
    const res = await handleConnectComplete(
      new NextRequest('http://localhost:3000/api/connect/instagram/complete', {
        method: 'POST',
        headers: {
          cookie: `${sessionCookie}; fbup_connect_pending=${encodeURIComponent(pending ?? '')}`,
          'content-type': 'application/json',
        },
        body: 'this is not json',
      }),
      'instagram',
      dbClient
    );
    expect(res.status).toBe(400);
  });

  it('complete rejects an expired or missing pending cookie', async () => {
    const req = new NextRequest('http://localhost:3000/api/connect/instagram/complete', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ destinationIds: ['dest-1001'] }),
    });
    const res = await handleConnectComplete(req, 'instagram', dbClient);
    expect(res.status).toBe(410);
  });

  it('deauthorize marks the matching account revoked for a correctly signed request', async () => {
    const { state } = await initiateInstagram();
    await runCallback(state);
    expect([...db.accounts.values()][0].status).toBe('active');

    const req = new NextRequest('http://localhost:3000/api/connect/instagram/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: signedBodyForFixtureAccount(),
    });
    const res = await handleConnectDeauthorize(req, 'instagram', dbClient);
    expect(res.status).toBe(200);
    expect([...db.accounts.values()][0].status).toBe('revoked');
  });

  it('data-deletion answers with a confirmation code and revokes the account for a correctly signed request', async () => {
    const { state } = await initiateInstagram();
    await runCallback(state);

    const req = new NextRequest('http://localhost:3000/api/connect/instagram/data-deletion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: signedBodyForFixtureAccount(),
    });
    const res = await handleConnectDataDeletion(req, 'instagram', dbClient);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { url: string; confirmation_code: string };
    expect(data.confirmation_code).toBeTruthy();
    expect(data.url).toContain('/accounts');
    expect([...db.accounts.values()][0].status).toBe('revoked');
  });

  it('social accounts API returns accounts across platforms, each with destinations', async () => {
    const { state } = await initiateInstagram();
    const callbackRes = await runCallback(state);
    const pending = cookieValue(callbackRes, 'fbup_connect_pending');
    const completeReq = new NextRequest('http://localhost:3000/api/connect/instagram/complete', {
      method: 'POST',
      headers: {
        cookie: `${sessionCookie}; fbup_connect_pending=${encodeURIComponent(pending ?? '')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ destinationIds: ['dest-1001'] }),
    });
    await handleConnectComplete(completeReq, 'instagram', dbClient);

    // A second platform's account + destination, as spec 125 would persist them.
    db.accounts.set(`${workspaceId}|youtube|yt-acct-9`, {
      id: 'acct-yt',
      workspace_id: workspaceId,
      platform: 'youtube',
      external_account_id: 'yt-acct-9',
      display_name: 'Fixture Channel Owner',
      avatar_url: null,
      encrypted_access_token: 'stored-ciphertext',
      encrypted_refresh_token: null,
      token_expires_at: null,
      scopes: [],
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    db.destinations.set('acct-yt|yt-dest-1', {
      id: 'dest-row-yt',
      workspace_id: workspaceId,
      account_id: 'acct-yt',
      platform: 'youtube',
      external_destination_id: 'yt-dest-1',
      name: 'Fixture Channel',
      handle: 'fixturechannel',
      avatar_url: null,
      timezone: 'UTC',
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const req = new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/accounts/social`, {
      headers: { cookie: sessionCookie },
    });
    const res = await handleListSocialAccounts(req, subdomain, dbClient);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      accounts: Array<{
        platform: string;
        displayName: string;
        destinations: Array<{ name: string; id: string }>;
      }>;
    };
    expect(data.accounts).toHaveLength(2);
    const platforms = data.accounts.map((a) => a.platform).sort((a, b) => a.localeCompare(b));
    expect(platforms).toEqual(['instagram', 'youtube']);
    const instagram = data.accounts.find((a) => a.platform === 'instagram');
    expect(instagram?.destinations).toHaveLength(1);
    expect(instagram?.destinations[0].name).toBe('My Brand');

    // Destination detail for the dedicated-section landing.
    const detailReq = new NextRequest(
      `http://localhost:3000/api/tenant/${subdomain}/accounts/social/${instagram?.destinations[0].id}`,
      { headers: { cookie: sessionCookie } }
    );
    const detailRes = await handleGetSocialDestination(
      detailReq,
      subdomain,
      instagram?.destinations[0].id ?? '',
      dbClient
    );
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      destination: { name: string; platform: string; account: { displayName: string } };
    };
    expect(detail.destination.name).toBe('My Brand');
    expect(detail.destination.platform).toBe('instagram');
    expect(detail.destination.account.displayName).toBe('Fixture Creator');
  });

  it('social accounts API rejects requests without a session', async () => {
    const req = new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/accounts/social`);
    const res = await handleListSocialAccounts(req, subdomain, dbClient);
    expect(res.status).toBe(401);
  });

  it('deauthorize ignores a signed_request whose signature cannot be verified', async () => {
    const { state } = await initiateInstagram();
    await runCallback(state);
    expect([...db.accounts.values()][0].status).toBe('active');

    const payloadJson = JSON.stringify({ user_id: FIXTURE_ACCOUNT.externalAccountId, algorithm: 'HMAC-SHA256' });
    const payloadB64 = Buffer.from(payloadJson)
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    const form = new URLSearchParams({ signed_request: `fakesig.${payloadB64}` });
    const req = new NextRequest('http://localhost:3000/api/connect/instagram/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const res = await handleConnectDeauthorize(req, 'instagram', dbClient);
    expect(res.status).toBe(200);
    expect([...db.accounts.values()][0].status).toBe('active');
  });

  it('deauthorize revokes the account from a correctly signed form post', async () => {
    const { state } = await initiateInstagram();
    await runCallback(state);
    expect([...db.accounts.values()][0].status).toBe('active');

    const form = new URLSearchParams({
      signed_request: buildSignedRequest(
        { user_id: FIXTURE_ACCOUNT.externalAccountId, algorithm: 'HMAC-SHA256' },
        FIXTURE_APP_SECRET
      ),
    });
    const req = new NextRequest('http://localhost:3000/api/connect/instagram/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const res = await handleConnectDeauthorize(req, 'instagram', dbClient);
    expect(res.status).toBe(200);
    expect([...db.accounts.values()][0].status).toBe('revoked');
  });

  it('deauthorize does not revoke for a request signed with the wrong secret', async () => {
    const { state } = await initiateInstagram();
    await runCallback(state);
    expect([...db.accounts.values()][0].status).toBe('active');

    const req = new NextRequest('http://localhost:3000/api/connect/instagram/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: signedBodyForFixtureAccount('some_other_secret'),
    });
    const res = await handleConnectDeauthorize(req, 'instagram', dbClient);
    expect(res.status).toBe(200);
    expect([...db.accounts.values()][0].status).toBe('active');
  });

  it('deauthorize never revokes for a bare unsigned account ID', async () => {
    const { state } = await initiateInstagram();
    await runCallback(state);
    expect([...db.accounts.values()][0].status).toBe('active');

    const req = new NextRequest('http://localhost:3000/api/connect/instagram/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: FIXTURE_ACCOUNT.externalAccountId }),
    });
    const res = await handleConnectDeauthorize(req, 'instagram', dbClient);
    expect(res.status).toBe(200);
    expect([...db.accounts.values()][0].status).toBe('active');
  });

  it('a signature valid for one workspace does not revoke another workspace account with the same external ID', async () => {
    const { state } = await initiateInstagram();
    await runCallback(state);

    const otherWorkspaceId = '33333333-3333-4333-a333-333333333333';
    const mainRow = [...db.accounts.values()][0];
    db.accounts.set(`${otherWorkspaceId}|instagram|${FIXTURE_ACCOUNT.externalAccountId}`, {
      ...mainRow,
      id: 'acct-other-workspace',
      workspace_id: otherWorkspaceId,
      status: 'active',
    });
    db.credentials.set(`${otherWorkspaceId}|instagram`, {
      client_id: 'other_workspace_app_id',
      encrypted_client_secret: await encryptToken('other_workspace_secret', TEST_ENCRYPTION_KEY),
    });

    const req = new NextRequest('http://localhost:3000/api/connect/instagram/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: signedBodyForFixtureAccount(),
    });
    const res = await handleConnectDeauthorize(req, 'instagram', dbClient);
    expect(res.status).toBe(200);
    const rows = [...db.accounts.values()];
    expect(rows.find((r) => r.workspace_id === workspaceId)?.status).toBe('revoked');
    expect(rows.find((r) => r.workspace_id === otherWorkspaceId)?.status).toBe('active');
  });

  it('deauthorize without an identifiable account still answers 200 and changes nothing', async () => {
    const req = new NextRequest('http://localhost:3000/api/connect/instagram/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unrelated: true }),
    });
    const res = await handleConnectDeauthorize(req, 'instagram', dbClient);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { received: boolean };
    expect(data.received).toBe(true);
  });

  it('rejects unknown platforms on the public callbacks', async () => {
    const req = new NextRequest('http://localhost:3000/api/connect/myspace/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'x' }),
    });
    const res = await handleConnectDeauthorize(req, 'myspace', dbClient);
    expect(res.status).toBe(404);
  });

  it('route wrappers delegate with params from context', async () => {
    const loginRedirect = await initiateGET(
      new NextRequest(`http://localhost:3000/api/connect/instagram?subdomain=${subdomain}`),
      { params: Promise.resolve({ platform: 'instagram' }) }
    );
    expect(loginRedirect.headers.get('location')).toBe('http://localhost:3000/login');

    const callbackFallback = await callbackGET(
      new NextRequest('http://localhost:3000/api/connect/instagram/callback'),
      { params: Promise.resolve({ platform: 'instagram' }) }
    );
    expect(callbackFallback.headers.get('location')).toContain(
      '/instagram/accounts?error=connect_failed'
    );

    const completeRes = await completePOST(
      new NextRequest('http://localhost:3000/api/connect/instagram/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationIds: [] }),
      }),
      { params: Promise.resolve({ platform: 'instagram' }) }
    );
    expect(completeRes.status).toBe(401);

    const deauthRes = await deauthorizePOST(
      new NextRequest('http://localhost:3000/api/connect/instagram/deauthorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ platform: 'instagram' }) }
    );
    expect(deauthRes.status).toBe(200);

    const deletionRes = await dataDeletionPOST(
      new NextRequest('http://localhost:3000/api/connect/instagram/data-deletion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ platform: 'instagram' }) }
    );
    expect(deletionRes.status).toBe(200);

    const listRes = await socialListGET(
      new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/accounts/social`),
      { params: Promise.resolve({ subdomain }) }
    );
    expect(listRes.status).toBe(401);

    const detailRes = await socialDetailGET(
      new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/accounts/social/abc`),
      { params: Promise.resolve({ subdomain, destinationId: 'abc' }) }
    );
    expect(detailRes.status).toBe(401);
  });

  it('contains no platform_credentials writes anywhere in the new connect code', () => {
    const roots = [
      path.resolve(__dirname, '../../src/lib/connect'),
      path.resolve(__dirname, '../../src/app/api/connect'),
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full);
      }
    };
    roots.forEach(walk);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content, file).not.toMatch(/(INSERT INTO|UPDATE)\s+platform_credentials/i);
      expect(content, file).not.toMatch(
        /platform_credentials[\s\S]{0,300}?\.(insert|update|upsert)\s*\(/
      );
    }
  });
});

/**
 * The same framework flow driven through a Supabase-shaped client, covering
 * the production persistence path (the fake above covers the legacy path).
 */
class FakeSupabaseBuilder {
  mode: 'select' | 'upsert' | 'update' = 'select';
  rowsToWrite: Array<Record<string, unknown>> = [];
  updateValues: Record<string, unknown> = {};
  filters: Array<[string, unknown]> = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;

  constructor(
    private readonly tables: Map<string, Array<Record<string, unknown>>>,
    private readonly table: string,
    private readonly nextId: (prefix: string) => string
  ) {}

  select(): this {
    return this;
  }

  upsert(rows: Record<string, unknown> | Array<Record<string, unknown>>): this {
    this.mode = 'upsert';
    this.rowsToWrite = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.mode = 'update';
    this.updateValues = values;
    return this;
  }

  eq(key: string, value: unknown): this {
    this.filters.push([key, value]);
    return this;
  }

  order(): this {
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  private tableRows(): Array<Record<string, unknown>> {
    if (!this.tables.has(this.table)) this.tables.set(this.table, []);
    return this.tables.get(this.table) ?? [];
  }

  private matches(row: Record<string, unknown>): boolean {
    return this.filters.every(([key, value]) => row[key] === value);
  }

  private executeList(): { data: Array<Record<string, unknown>>; error: null } {
    if (this.mode === 'upsert') return { data: this.executeUpsert(), error: null };
    if (this.mode === 'update') return { data: this.executeUpdate(), error: null };
    const matched = this.tableRows().filter((row) => this.matches(row));
    return {
      data:
        this.rangeFrom !== null && this.rangeTo !== null
          ? matched.slice(this.rangeFrom, this.rangeTo + 1)
          : matched,
      error: null,
    };
  }

  private executeUpsert(): Array<Record<string, unknown>> {
    const rows = this.tableRows();
    const conflictKeys =
      this.table === 'social_accounts'
        ? ['workspace_id', 'platform', 'external_account_id']
        : ['account_id', 'external_destination_id'];
    const written: Array<Record<string, unknown>> = [];
    for (const incoming of this.rowsToWrite) {
      const existing = rows.find((row) =>
        conflictKeys.every((key) => row[key] === incoming[key])
      );
      if (existing) {
        Object.assign(existing, incoming);
        written.push(existing);
      } else {
        const row = {
          id: this.nextId(this.table),
          created_at: new Date().toISOString(),
          ...incoming,
        };
        rows.push(row);
        written.push(row);
      }
    }
    return written;
  }

  private executeUpdate(): Array<Record<string, unknown>> {
    const updated: Array<Record<string, unknown>> = [];
    for (const row of this.tableRows()) {
      if (this.matches(row)) {
        Object.assign(row, this.updateValues);
        updated.push(row);
      }
    }
    return updated;
  }

  private executeSingle(): {
    data: Record<string, unknown> | null;
    error: null;
  } {
    const { data } = this.executeList();
    return { data: data[0] ?? null, error: null };
  }

  maybeSingle() {
    return Promise.resolve(this.executeSingle());
  }

  single() {
    return Promise.resolve(this.executeSingle());
  }

  then<TResult>(
    onFulfilled: (value: { data: Array<Record<string, unknown>>; error: null }) => TResult
  ) {
    return Promise.resolve(this.executeList()).then(onFulfilled);
  }
}

describe('Connect framework via a Supabase-shaped client', () => {
  const tables = new Map<string, Array<Record<string, unknown>>>();
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-sb-${++seq}`;
  const supabase = {
    from: (table: string) => new FakeSupabaseBuilder(tables, table, nextId),
  } as unknown as SupabaseClient<any>;
  let sessionCookie = '';

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
    delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
    tables.clear();
    tables.set('workspaces', [{ id: workspaceId, subdomain, owner_id: userId }]);
    tables.set('platform_credentials', [
      {
        workspace_id: workspaceId,
        platform: 'instagram',
        client_id: 'sb_ig_app_id',
        encrypted_client_secret: await encryptToken('sb_ig_secret', TEST_ENCRYPTION_KEY),
      },
    ]);
    const token = await signSessionToken(
      {
        userId,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain,
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    sessionCookie = `fbup_session=${token}`;
  });

  it('completes initiate → callback → complete → list → detail → deauthorize', async () => {
    const initReq = new NextRequest(
      `http://localhost:3000/api/connect/instagram?subdomain=${subdomain}`,
      { headers: { cookie: sessionCookie } }
    );
    const initRes = await handleConnectInitiate(initReq, 'instagram', supabase);
    expect(initRes.status).toBe(307);
    const state = new URL(initRes.headers.get('location') ?? '').searchParams.get('state') ?? '';

    const cbRes = await handleConnectCallback(
      new NextRequest(
        `http://localhost:3000/api/connect/instagram/callback?code=abc&state=${encodeURIComponent(state)}`
      ),
      'instagram',
      supabase
    );
    expect(cbRes.status).toBe(307);
    const pendingCookie = cbRes.headers
      .getSetCookie()
      .find((entry) => entry.startsWith('fbup_connect_pending='))
      ?.slice('fbup_connect_pending='.length)
      .split(';')[0];
    expect(pendingCookie).toBeTruthy();

    const accountRows = tables.get('social_accounts') ?? [];
    expect(accountRows).toHaveLength(1);
    expect(accountRows[0].encrypted_access_token).not.toBe(FIXTURE_ACCOUNT.accessToken);
    expect(
      await decryptToken(String(accountRows[0].encrypted_access_token), TEST_ENCRYPTION_KEY)
    ).toBe(FIXTURE_ACCOUNT.accessToken);

    const completeRes = await handleConnectComplete(
      new NextRequest('http://localhost:3000/api/connect/instagram/complete', {
        method: 'POST',
        headers: {
          cookie: `${sessionCookie}; fbup_connect_pending=${pendingCookie}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ destinationIds: ['dest-2002'] }),
      }),
      'instagram',
      supabase
    );
    expect(completeRes.status).toBe(200);
    const destinationRows = tables.get('destinations') ?? [];
    expect(destinationRows).toHaveLength(1);
    expect(destinationRows[0].external_destination_id).toBe('dest-2002');

    const listRes = await handleListSocialAccounts(
      new NextRequest(`http://localhost:3000/api/tenant/${subdomain}/accounts/social`, {
        headers: { cookie: sessionCookie },
      }),
      subdomain,
      supabase
    );
    expect(listRes.status).toBe(200);
    const listData = (await listRes.json()) as {
      accounts: Array<{ platform: string; destinations: Array<{ id: string; name: string }> }>;
    };
    expect(listData.accounts).toHaveLength(1);
    expect(listData.accounts[0].destinations[0].name).toBe('My Brand');

    const detailRes = await handleGetSocialDestination(
      new NextRequest(
        `http://localhost:3000/api/tenant/${subdomain}/accounts/social/${listData.accounts[0].destinations[0].id}`,
        { headers: { cookie: sessionCookie } }
      ),
      subdomain,
      listData.accounts[0].destinations[0].id,
      supabase
    );
    expect(detailRes.status).toBe(200);

    const sbPayloadB64 = Buffer.from(
      JSON.stringify({ user_id: FIXTURE_ACCOUNT.externalAccountId, algorithm: 'HMAC-SHA256' })
    )
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    const sbSignature = createHmac('sha256', 'sb_ig_secret')
      .update(sbPayloadB64)
      .digest()
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    const deauthRes = await handleConnectDeauthorize(
      new NextRequest('http://localhost:3000/api/connect/instagram/deauthorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signed_request: `${sbSignature}.${sbPayloadB64}` }),
      }),
      'instagram',
      supabase
    );
    expect(deauthRes.status).toBe(200);
    expect((tables.get('social_accounts') ?? [])[0].status).toBe('revoked');
  });
});
