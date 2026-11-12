import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  clearPlatformConnectConfigsForTests,
  getPlatformConnectConfig,
  hasPlatformConnectConfig,
} from '@/lib/connect/registry';
import {
  createConnectStatePayload,
  signConnectState,
  signPendingDestinations,
  PENDING_COOKIE_NAME,
} from '@/lib/connect/state';
import type { ConnectDbClient } from '@/lib/connect/persist';
import {
  createYouTubeConnectConfig,
  exchangeYouTubeCode,
  fetchYouTubeDestinations,
  registerYouTubeConnectConfig,
  type PostForMeConnectClient,
  type PostForMeSocialAccount,
  type YouTubeDiscoveredDestination,
} from '@/lib/connect/platforms/youtube';
import { handleYouTubeAuthorize } from '@/app/api/connect/youtube/authorize/route';
import { handleYouTubeReturn } from '@/app/api/connect/youtube/return/route';
import { handleYouTubeComplete } from '@/app/api/connect/youtube/complete/route';

// ==========================================
// YouTube connect via Post for Me (spec 125)
// ==========================================

const TEST_SECRET = 'connect-youtube-test-secret-value';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const userId = '11111111-1111-4111-a111-111111111111';
const workspaceId = '22222222-2222-4222-a222-222222222222';
const subdomain = 'acme';

const CHANNEL_ACCOUNT: PostForMeSocialAccount = {
  id: 'sa_yt_1',
  platform: 'youtube',
  username: '@bosschannel',
  display_name: 'Boss Channel',
  platform_account_id: 'channel-123',
  profile_image_url: 'https://img.example.com/avatar.png',
};

const NO_CHANNEL_ACCOUNT: PostForMeSocialAccount = {
  id: 'sa_yt_2',
  platform: 'youtube',
  username: 'someone',
  display_name: 'Someone',
};

function mockClient(
  accounts: Record<string, PostForMeSocialAccount>
): PostForMeConnectClient {
  return {
    createAuthUrl: vi.fn(async () => ({
      url: 'https://provider.example.com/auth/abc',
    })),
    getSocialAccount: vi.fn(async (id: string) => accounts[id] ?? null),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.SESSION_SECRET = TEST_SECRET;
  process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
  delete process.env.NEXT_PUBLIC_ROOT_DOMAIN;
  clearPlatformConnectConfigsForTests();
});

// ==========================================
// Registration into the framework
// ==========================================

describe('YouTube connect registration (spec 123 framework)', () => {
  it('registers a single-confirm config whose authorize URL is our own shim', () => {
    registerYouTubeConnectConfig({
      client: mockClient({}),
      appOrigin: 'http://localhost:3000',
    });
    expect(hasPlatformConnectConfig('youtube')).toBe(true);
    const config = getPlatformConnectConfig('youtube');
    expect(config?.destinationMode).toBe('single-confirm');
    expect(config?.authorizeUrl).toBe(
      'http://localhost:3000/api/connect/youtube/authorize'
    );
    expect(config?.usePkce).toBe(false);
    expect(config?.clientIdSource).toBe('global');
  });

  it('registration is idempotent (importing twice never throws)', () => {
    registerYouTubeConnectConfig({ client: mockClient({}) });
    expect(() =>
      registerYouTubeConnectConfig({ client: mockClient({}) })
    ).not.toThrow();
  });

  it('the framework client id is a non-secret marker, never the API key', async () => {
    const config = createYouTubeConnectConfig({ client: mockClient({}) });
    await expect(
      config.resolveClientId?.({ workspaceId })
    ).resolves.toBe('post-for-me');
  });
});

// ==========================================
// Read-back exchange + destination discovery
// ==========================================

describe('YouTube exchange + discovery (read-back-and-confirm)', () => {
  it('exchangeCode reads the account back and keys the account row by channel id', async () => {
    const client = mockClient({ sa_yt_1: CHANNEL_ACCOUNT });
    const exchanged = await exchangeYouTubeCode(client, 'sa_yt_1');
    expect(exchanged.externalAccountId).toBe('channel-123');
    expect(exchanged.displayName).toBe('Boss Channel');
    expect(exchanged.avatarUrl).toBe('https://img.example.com/avatar.png');
    expect(exchanged.providerAccountId).toBe('sa_yt_1');
    expect(exchanged.channelId).toBe('channel-123');
    // Provider-managed: no token of ours is persisted.
    expect(exchanged.accessToken).toBe('');
    expect(client.getSocialAccount).toHaveBeenCalledWith('sa_yt_1');
  });

  it('exchangeCode takes the first account when the provider returns several', async () => {
    const client = mockClient({
      sa_yt_1: CHANNEL_ACCOUNT,
      sa_yt_2: NO_CHANNEL_ACCOUNT,
    });
    const exchanged = await exchangeYouTubeCode(client, 'sa_yt_1,sa_yt_2');
    expect(exchanged.providerAccountId).toBe('sa_yt_1');
  });

  it('exchangeCode throws when the account cannot be read back', async () => {
    const client = mockClient({});
    await expect(exchangeYouTubeCode(client, 'sa_missing')).rejects.toThrow();
  });

  it('fetchDestinations returns the single channel for the confirm step, carrying the provider ref', async () => {
    const client = mockClient({ sa_yt_1: CHANNEL_ACCOUNT });
    const exchanged = await exchangeYouTubeCode(client, 'sa_yt_1');
    const destinations = (await fetchYouTubeDestinations(
      client,
      exchanged
    )) as YouTubeDiscoveredDestination[];
    expect(destinations).toHaveLength(1);
    expect(destinations[0]?.externalDestinationId).toBe('channel-123');
    expect(destinations[0]?.name).toBe('Boss Channel');
    expect(destinations[0]?.handle).toBe('@bosschannel');
    expect(destinations[0]?.providerAccountId).toBe('sa_yt_1');
  });

  it('an account with no channel yields no destinations (the framework shows the plain-language notice)', async () => {
    const client = mockClient({ sa_yt_2: NO_CHANNEL_ACCOUNT });
    const exchanged = await exchangeYouTubeCode(client, 'sa_yt_2');
    expect(exchanged.channelId).toBeNull();
    const destinations = await fetchYouTubeDestinations(client, exchanged);
    expect(destinations).toEqual([]);
  });
});

// ==========================================
// Authorize shim + provider return
// ==========================================

async function signedYouTubeState(): Promise<string> {
  return signConnectState(
    createConnectStatePayload({
      workspaceId,
      tenantSubdomain: subdomain,
      userId,
      platform: 'youtube',
    }),
    TEST_SECRET
  );
}

describe('YouTube authorize shim', () => {
  it('verifies the framework state, then redirects to the provider auth URL with our return route as target', async () => {
    const client = mockClient({});
    const state = await signedYouTubeState();
    const req = new NextRequest(
      `http://localhost:3000/api/connect/youtube/authorize?state=${encodeURIComponent(state)}`
    );
    const res = await handleYouTubeAuthorize(req, client);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'https://provider.example.com/auth/abc'
    );
    const createAuthUrl = vi.mocked(client.createAuthUrl);
    const calls = createAuthUrl.mock.calls;
    expect(calls[0]?.[0].platform).toBe('youtube');
    expect(calls[0]?.[0].redirectUrl).toContain(
      '/api/connect/youtube/return'
    );
    expect(calls[0]?.[0].redirectUrl).toContain(
      `state=${encodeURIComponent(state)}`
    );
  });

  it('rejects a request without a valid state', async () => {
    const client = mockClient({});
    const req = new NextRequest(
      'http://localhost:3000/api/connect/youtube/authorize?state=not-a-state'
    );
    const res = await handleYouTubeAuthorize(req, client);
    expect(res.status).toBe(400);
    expect(client.createAuthUrl).not.toHaveBeenCalled();
  });
});

describe('YouTube provider return', () => {
  it('translates a successful return into the framework callback with the account id as code', async () => {
    const state = await signedYouTubeState();
    const req = new NextRequest(
      `http://localhost:3000/api/connect/youtube/return?state=${encodeURIComponent(state)}&isSuccess=true&accountIds=sa_yt_1`
    );
    const res = await handleYouTubeReturn(req);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/api/connect/youtube/callback');
    expect(location.searchParams.get('code')).toBe('sa_yt_1');
    expect(location.searchParams.get('state')).toBe(state);
  });

  it('sends a failed return to the picker with a plain-language notice', async () => {
    const state = await signedYouTubeState();
    const req = new NextRequest(
      `http://localhost:3000/api/connect/youtube/return?state=${encodeURIComponent(state)}&isSuccess=false&error=User+cancelled`
    );
    const res = await handleYouTubeReturn(req);
    expect(res.status).toBe(307);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('/connect/youtube');
    expect(location).toContain('notice=denied');
  });
});

// ==========================================
// Complete: framework persist + provider ref metadata
// ==========================================

class FakeDb {
  readonly queries: Array<{ sql: string; params: unknown[] }> = [];

  async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    this.queries.push({ sql, params });
    if (sql.includes('INSERT INTO destinations')) {
      return [{ id: 'dest-row-1' }];
    }
    return [];
  }
}

async function completeRequest(db: FakeDb, withProviderRef: boolean) {
  const sessionToken = await signSessionToken(
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
  const destination = {
    externalDestinationId: 'channel-123',
    name: 'Boss Channel',
    handle: '@bosschannel',
    ...(withProviderRef ? { providerAccountId: 'sa_yt_1' } : {}),
  };
  const pending = await signPendingDestinations(
    {
      accountId: 'acct-row-1',
      workspaceId,
      tenantSubdomain: subdomain,
      platform: 'youtube',
      destinations: [destination],
      exp: Math.floor(Date.now() / 1000) + 900,
    },
    TEST_SECRET
  );
  const req = new NextRequest(
    'http://localhost:3000/api/connect/youtube/complete',
    {
      method: 'POST',
      headers: {
        cookie: `fbup_session=${sessionToken}; ${PENDING_COOKIE_NAME}=${pending}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ destinationIds: ['channel-123'] }),
    }
  );
  return handleYouTubeComplete(req, db as unknown as ConnectDbClient);
}

describe('YouTube complete route', () => {
  it('creates no destinations row (spec 174 2A) and writes the provider ref into the account metadata', async () => {
    const db = new FakeDb();
    const res = await completeRequest(db, true);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { addedCount?: number };
    // Spec 174 §2: connecting an account must never create a
    // destinations row — the section import creates the copy later.
    expect(body.addedCount).toBe(0);

    expect(
      db.queries.some((q) => q.sql.includes('INSERT INTO destinations'))
    ).toBe(false);

    const accountUpdate = db.queries.find((q) =>
      q.sql.includes('UPDATE social_accounts')
    );
    expect(accountUpdate?.params).toContain(
      JSON.stringify({ providerAccountId: 'sa_yt_1' })
    );
    expect(accountUpdate?.params).toContain('acct-row-1');

    // The destinations merge is still attempted (the worker's YouTube
    // publisher reads the ref from the destination); it matches zero
    // rows until a section imports the account, and the ref is
    // preserved on the account row for that import to carry.
    const destinationUpdate = db.queries.find((q) =>
      q.sql.includes('UPDATE destinations')
    );
    expect(destinationUpdate?.params).toContain(
      JSON.stringify({ providerAccountId: 'sa_yt_1' })
    );
    expect(destinationUpdate?.params).toContain('channel-123');
  });

  it('still completes cleanly when no provider ref was carried (nothing to patch)', async () => {
    const db = new FakeDb();
    const res = await completeRequest(db, false);
    expect(res.status).toBe(200);
    expect(
      db.queries.some((q) => q.sql.includes('UPDATE social_accounts'))
    ).toBe(false);
    expect(
      db.queries.some((q) => q.sql.includes('UPDATE destinations'))
    ).toBe(false);
  });

  it('never writes platform_credentials for YouTube', async () => {
    const db = new FakeDb();
    await completeRequest(db, true);
    expect(
      db.queries.some((q) => q.sql.includes('platform_credentials'))
    ).toBe(false);
  });
});
