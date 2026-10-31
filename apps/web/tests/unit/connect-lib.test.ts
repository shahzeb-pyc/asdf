/**
 * @file connect-lib.test.ts
 * @description Spec 123 Part C: branch-level tests for the connect
 * framework library (state envelopes, persistence edge cases, platform
 * callback parsing, registry guards).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  decryptToken,
  encryptToken,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import {
  signConnectEnvelope,
  signConnectState,
  signPendingDestinations,
  signPkceCookie,
  verifyConnectState,
  verifyPendingDestinations,
  verifyPkceCookie,
  createConnectStatePayload,
  generatePkcePair,
  buildConnectCallbackUrl,
} from '@/lib/connect/state';
import {
  fetchDestinationDetail,
  markSocialAccountRevoked,
  persistConnectedAccount,
  persistPickedDestinations,
  resolvePlatformClientCredentials,
} from '@/lib/connect/persist';
import { extractExternalAccountId } from '@/lib/connect/platform-callback';
import {
  clearPlatformConnectConfigsForTests,
  registerPlatformConnectConfig,
} from '@/lib/connect/registry';
import { handleConnectDeauthorize } from '@/app/api/connect/[platform]/deauthorize/route';

const TEST_SECRET = 'test_session_secret_at_least_32_chars_long_value';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const workspaceId = '22222222-2222-4222-a222-222222222222';
const userId = '11111111-1111-4111-a111-111111111111';

describe('Connect state envelopes', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  it('rejects malformed tokens, bad signatures, and expired payloads', async () => {
    await expect(verifyConnectState('no-dot-here', TEST_SECRET)).rejects.toThrow();
    await expect(verifyConnectState('abc.zzz', TEST_SECRET)).rejects.toThrow();
    await expect(verifyConnectState('abc.', TEST_SECRET)).rejects.toThrow();

    const payload = createConnectStatePayload({
      workspaceId,
      tenantSubdomain: 'acme',
      userId,
      platform: 'instagram',
    });
    const signed = await signConnectState(payload, TEST_SECRET);
    await expect(verifyConnectState(signed, 'a-different-secret-value-32-chars!!')).rejects.toThrow();

    const expired = await signConnectEnvelope(
      { ...payload, exp: Math.floor(Date.now() / 1000) - 10 },
      TEST_SECRET
    );
    await expect(verifyConnectState(expired, TEST_SECRET)).rejects.toThrow(
      'expired'
    );
  });

  it('rejects a state payload with missing fields', async () => {
    const incomplete = await signConnectEnvelope(
      { platform: 'instagram', exp: Math.floor(Date.now() / 1000) + 600 },
      TEST_SECRET
    );
    await expect(verifyConnectState(incomplete, TEST_SECRET)).rejects.toThrow(
      'incomplete'
    );
  });

  it('round-trips PKCE cookies and pending destinations, rejecting incomplete payloads', async () => {
    const { verifier, challenge } = await generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).not.toBe(verifier);

    const cookie = await signPkceCookie(
      {
        nonce: 'nonce-1',
        platform: 'x',
        codeVerifier: verifier,
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      TEST_SECRET
    );
    const parsed = await verifyPkceCookie(cookie, TEST_SECRET);
    expect(parsed.codeVerifier).toBe(verifier);

    const incompleteCookie = await signConnectEnvelope(
      { nonce: 'nonce-1', exp: Math.floor(Date.now() / 1000) + 600 },
      TEST_SECRET
    );
    await expect(verifyPkceCookie(incompleteCookie, TEST_SECRET)).rejects.toThrow();

    const pending = await signPendingDestinations(
      {
        accountId: 'acct-1',
        workspaceId,
        tenantSubdomain: 'acme',
        platform: 'instagram',
        destinations: [],
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      TEST_SECRET
    );
    const parsedPending = await verifyPendingDestinations(pending, TEST_SECRET);
    expect(parsedPending.destinations).toEqual([]);

    const badPending = await signConnectEnvelope(
      {
        accountId: 'acct-1',
        workspaceId,
        platform: 'instagram',
        destinations: 'not-an-array',
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      TEST_SECRET
    );
    await expect(verifyPendingDestinations(badPending, TEST_SECRET)).rejects.toThrow();
  });

  it('builds the frozen callback URL from the request origin', () => {
    expect(buildConnectCallbackUrl('http://localhost:3000/api/connect/x', 'x')).toBe(
      'http://localhost:3000/api/connect/x/callback'
    );
    expect(
      buildConnectCallbackUrl(new URL('https://app.example.com/tenant/acme'), 'threads')
    ).toBe('https://app.example.com/api/connect/threads/callback');
  });
});

describe('Registry guards', () => {
  it('refuses a duplicate platform registration', () => {
    clearPlatformConnectConfigsForTests();
    const config = {
      platform: 'tiktok' as const,
      authorizeUrl: 'https://fixture.example/authorize',
      clientIdSource: 'global' as const,
      scopes: [],
      usePkce: false,
      destinationMode: 'picker' as const,
      exchangeCode: async () => {
        throw new Error('unused');
      },
      fetchDestinations: async () => [],
    };
    registerPlatformConnectConfig(config);
    expect(() => registerPlatformConnectConfig(config)).toThrow(
      'already registered'
    );
    clearPlatformConnectConfigsForTests();
  });
});

describe('Persistence edge cases (legacy client)', () => {
  const stored: { accounts: unknown[]; inserted: unknown[] } = {
    accounts: [],
    inserted: [],
  };

  function makeLegacyClient(
    handler: (sql: string, params: unknown[]) => unknown[]
  ): DatabaseClient {
    return { query: vi.fn(async (sql: string, params: unknown[] = []) => handler(sql, params)) } as unknown as DatabaseClient;
  }

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    stored.accounts = [];
    stored.inserted = [];
  });

  it('persists a minimal account with null refresh token, expiry, and scopes', async () => {
    let captured: unknown[] = [];
    const client = makeLegacyClient((sql, params) => {
      if (sql.includes('INSERT INTO social_accounts')) {
        captured = params;
        return [{ id: 'acct-min' }];
      }
      return [];
    });
    const result = await persistConnectedAccount(client, {
      workspaceId,
      platform: 'threads',
      exchanged: {
        externalAccountId: 'ext-min',
        displayName: 'Minimal',
        accessToken: 'plain-token',
      },
    });
    expect(result.accountId).toBe('acct-min');
    expect(captured[6]).toBeNull(); // encrypted refresh token
    expect(captured[7]).toBeNull(); // token_expires_at
    expect(captured[8]).toEqual([]); // scopes
    expect(await decryptToken(String(captured[5]), TEST_ENCRYPTION_KEY)).toBe(
      'plain-token'
    );
  });

  it('fails loudly when the account insert returns no row', async () => {
    const client = makeLegacyClient(() => []);
    await expect(
      persistConnectedAccount(client, {
        workspaceId,
        platform: 'threads',
        exchanged: {
          externalAccountId: 'ext-min',
          displayName: 'Minimal',
          accessToken: 'plain-token',
        },
      })
    ).rejects.toThrow('Failed to persist connected account');
  });

  it('persists no destinations for an empty pick without touching the database', async () => {
    const client = makeLegacyClient(() => {
      throw new Error('should not be called');
    });
    const result = await persistPickedDestinations(client, {
      workspaceId,
      accountId: 'acct-1',
      platform: 'instagram',
      destinations: [],
    });
    expect(result.inserted).toBe(0);
  });

  it('reports zero revocations when no account matches', async () => {
    const client = makeLegacyClient(() => []);
    const result = await markSocialAccountRevoked(client, 'instagram', 'nobody');
    expect(result.updated).toBe(0);
  });

  it('propagates a revocation to destinations, queued items, and tokens (P0-2)', async () => {
    const seen: string[] = [];
    const client = makeLegacyClient((sql) => {
      seen.push(sql);
      if (sql.includes("SET status = 'revoked'")) return [{ id: 'acct-1' }];
      if (sql.includes('UPDATE destinations')) return [{ id: 'd-1' }];
      if (sql.includes('UPDATE queue_items')) return [{ id: 'q-1' }];
      if (sql.includes('encrypted_access_token')) return [];
      return [];
    });
    const result = await markSocialAccountRevoked(client, 'facebook', 'ext-1');
    expect(result).toEqual({ updated: 1, propagationFailed: 0 });
    const joined = seen.join('\n');
    expect(joined).toContain("SET status = 'revoked'");
    expect(joined).toContain('UPDATE destinations');
    expect(joined).toContain("status = 'error'");
    expect(joined).toContain('UPDATE queue_items');
    expect(joined).toContain("status = 'cancelled'");
    expect(joined).toContain('encrypted_access_token');
    // Verification send-back: the legacy path must null BOTH tokens,
    // like the Supabase branch — a surviving refresh token is a hole.
    expect(joined).toContain('encrypted_refresh_token');
  });

  it('counts a token-null failure instead of reporting full success (P0-2)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const client = makeLegacyClient((sql) => {
        if (sql.includes("SET status = 'revoked'")) return [{ id: 'acct-1' }];
        if (sql.includes('UPDATE destinations')) return [{ id: 'd-1' }];
        if (sql.includes('UPDATE queue_items')) return [{ id: 'q-1' }];
        if (sql.includes('encrypted_access_token')) {
          throw new Error('token table down');
        }
        return [];
      });
      const result = await markSocialAccountRevoked(client, 'facebook', 'ext-1');
      expect(result).toEqual({ updated: 1, propagationFailed: 1 });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('propagates a revocation on the Supabase path, including token nulling (P0-2)', async () => {
    interface Call {
      table: string;
      update: Record<string, unknown>;
      filters: Array<[string, unknown]>;
      inFilters: Array<[string, unknown[]]>;
    }
    const calls: Call[] = [];
    const supabase = {
      from: (table: string) => {
        const entry: Call = { table, update: {}, filters: [], inFilters: [] };
        calls.push(entry);
        const builder: Record<string, unknown> = {};
        builder.update = (payload: Record<string, unknown>) => {
          entry.update = payload;
          return builder;
        };
        builder.eq = (column: string, value: unknown) => {
          entry.filters.push([column, value]);
          return builder;
        };
        builder.in = (column: string, values: unknown[]) => {
          entry.inFilters.push([column, values]);
          return builder;
        };
        builder.select = () => {
          if (table === 'social_accounts' && entry.update.status === 'revoked') {
            return Promise.resolve({ data: [{ id: 'acct-1' }], error: null });
          }
          if (table === 'destinations') {
            return Promise.resolve({ data: [{ id: 'd-1' }], error: null });
          }
          if (table === 'queue_items') {
            return Promise.resolve({ data: [{ id: 'q-1' }], error: null });
          }
          return Promise.resolve({ data: [], error: null });
        };
        // The token-null update is awaited directly (no .select()).
        builder.then = (resolve: (value: unknown) => void) =>
          resolve({ data: null, error: null });
        return builder;
      },
    };
    const result = await markSocialAccountRevoked(supabase as never, 'facebook', 'ext-1');
    expect(result).toEqual({ updated: 1, propagationFailed: 0 });
    expect(calls[0]?.table).toBe('social_accounts');
    expect(calls[0]?.update.status).toBe('revoked');
    expect(calls[0]?.filters).toContainEqual(['platform', 'facebook']);
    expect(calls[0]?.filters).toContainEqual(['external_account_id', 'ext-1']);
    const destCall = calls.find((c) => c.table === 'destinations');
    expect(destCall?.update.status).toBe('error');
    expect(destCall?.filters).toContainEqual(['account_id', 'acct-1']);
    expect(destCall?.filters).toContainEqual(['status', 'active']);
    const queueCall = calls.find((c) => c.table === 'queue_items');
    expect(queueCall?.update.status).toBe('cancelled');
    expect(queueCall?.filters).toContainEqual(['status', 'queued']);
    expect(queueCall?.inFilters).toContainEqual(['destination_id', ['d-1']]);
    const nullCall = calls.filter((c) => c.table === 'social_accounts').at(-1);
    expect(nullCall?.update.encrypted_access_token).toBeNull();
    expect(nullCall?.update.encrypted_refresh_token).toBeNull();
    expect(nullCall?.filters).toContainEqual(['id', 'acct-1']);
  });

  it('still lands the revocation and nulls tokens when propagation fails (P0-2)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const seen: string[] = [];
      const client = makeLegacyClient((sql) => {
        seen.push(sql);
        if (sql.includes("SET status = 'revoked'")) return [{ id: 'acct-1' }];
        if (sql.includes('UPDATE destinations')) {
          throw new Error('destinations down');
        }
        if (sql.includes('encrypted_access_token')) return [];
        return [];
      });
      const result = await markSocialAccountRevoked(client, 'facebook', 'ext-1');
      expect(result).toEqual({ updated: 1, propagationFailed: 1 });
      expect(seen.join('\n')).toContain('encrypted_access_token');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns null for a missing destination and missing credentials', async () => {
    const client = makeLegacyClient(() => []);
    expect(await fetchDestinationDetail(client, workspaceId, 'missing')).toBeNull();
    expect(
      await resolvePlatformClientCredentials(client, workspaceId, 'instagram')
    ).toBeNull();
  });

  it('surfaces the persisted account type on the destination detail', async () => {
    const client = makeLegacyClient((sql) => {
      if (sql.includes('FROM destinations d')) {
        return [
          {
            id: 'dest-1',
            account_id: 'acct-1',
            platform: 'instagram',
            external_destination_id: '12345',
            name: 'The Baby Boss',
            handle: 'boss.baby',
            avatar_url: null,
            timezone: 'UTC',
            status: 'active',
            metadata: { account_type: 'BUSINESS' },
            account_display_name: 'The Baby Boss',
            account_status: 'active',
          },
        ];
      }
      return [];
    });
    const detail = await fetchDestinationDetail(client, workspaceId, 'dest-1');
    expect(detail?.accountType).toBe('BUSINESS');
    expect(detail?.platform).toBe('instagram');
  });

  it('reports accountType null when the destination metadata carries none', async () => {
    const client = makeLegacyClient((sql) => {
      if (sql.includes('FROM destinations d')) {
        return [
          {
            id: 'dest-1',
            account_id: 'acct-1',
            platform: 'instagram',
            external_destination_id: '12345',
            name: 'The Baby Boss',
            handle: 'boss.baby',
            avatar_url: null,
            timezone: 'UTC',
            status: 'active',
            metadata: {},
            account_display_name: 'The Baby Boss',
            account_status: 'active',
          },
        ];
      }
      return [];
    });
    const detail = await fetchDestinationDetail(client, workspaceId, 'dest-1');
    // Connected before the type was persisted: unknown, never guessed.
    expect(detail?.accountType).toBeNull();
  });

  it('decrypts stored credentials for the exchange', async () => {
    const encrypted = await encryptToken('the-secret', TEST_ENCRYPTION_KEY);
    const client = makeLegacyClient((sql) => {
      if (sql.includes('FROM platform_credentials')) {
        return [{ client_id: 'app-9', encrypted_client_secret: encrypted }];
      }
      return [];
    });
    const resolved = await resolvePlatformClientCredentials(
      client,
      workspaceId,
      'threads'
    );
    expect(resolved).toEqual({ clientId: 'app-9', clientSecret: 'the-secret' });
  });
});

describe('Platform callback payload parsing', () => {
  it('reads the account ID from a JSON body', async () => {
    const req = new NextRequest('http://localhost:3000/api/connect/threads/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 12345 }),
    });
    expect(await extractExternalAccountId(req)).toBe('12345');
  });

  it('reads the account ID from a form field', async () => {
    const form = new URLSearchParams({ user_id: 'form-user-7' });
    const req = new NextRequest('http://localhost:3000/api/connect/threads/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    expect(await extractExternalAccountId(req)).toBe('form-user-7');
  });

  it('reads the account ID from a JSON signed_request payload', async () => {
    const payloadB64 = Buffer.from(JSON.stringify({ user_id: 'signed-user-3' }))
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    const req = new NextRequest('http://localhost:3000/api/connect/threads/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signed_request: `sig.${payloadB64}` }),
    });
    expect(await extractExternalAccountId(req)).toBe('signed-user-3');
  });

  it('returns null for malformed bodies and unknown content types', async () => {
    const badJson = new NextRequest('http://localhost:3000/api/connect/threads/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'this is not json',
    });
    expect(await extractExternalAccountId(badJson)).toBeNull();

    const plain = new NextRequest('http://localhost:3000/api/connect/threads/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'user_id=abc',
    });
    expect(await extractExternalAccountId(plain)).toBeNull();

    const badSigned = new NextRequest('http://localhost:3000/api/connect/threads/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signed_request: 'only-one-part' }),
    });
    expect(await extractExternalAccountId(badSigned)).toBeNull();
  });

  it('deauthorize still answers 200 when the body cannot be parsed', async () => {
    const req = new NextRequest('http://localhost:3000/api/connect/threads/deauthorize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    const res = await handleConnectDeauthorize(req, 'threads', {
      query: vi.fn(async () => []),
    } as unknown as DatabaseClient);
    expect(res.status).toBe(200);
  });
});
