import { afterEach, describe, expect, it, vi } from 'vitest';
import { markSocialAccountRevoked } from '@/lib/connect/persist';
import type { DatabaseClient } from '@fbuploadpro/contracts';

// Deterministic no-database suite: the admin client is null, so no
// Supabase fallback is ever consulted. The legacy path under test takes
// an explicit client; the Supabase-path test passes its own client.
vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: () => null,
}));

/**
 * Spec 175 — a miniature UPDATE executor for the legacy client.
 *
 * It behaves like Postgres for the UPDATE statements this code path
 * sends: it parses the SET list (each comma-separated segment must be
 * exactly one `column = value` assignment) and the WHERE conditions,
 * applies the assignments to an in-memory row store, and honours
 * `RETURNING id`. A malformed SET list — a missing comma fusing two
 * assignments, or a trailing comma before WHERE — throws a syntax
 * error, exactly as Postgres would. The test therefore proves the
 * end state (the token is actually NULL afterwards), not the SQL
 * string: it fails on the old SQL and passes on the fixed SQL.
 */
type AccountRow = {
  id: string;
  platform: string;
  external_account_id: string;
  workspace_id: string | null;
  status: string;
  encrypted_access_token: string | null;
  encrypted_refresh_token: string | null;
  updated_at: string | null;
};

type DestinationRow = {
  id: string;
  account_id: string;
  status: string;
  updated_at: string | null;
};

const ASSIGNMENT =
  /^\s*[a-z_][a-z0-9_]*\s*=\s*(NULL|now\(\)|\$[0-9]+|'[^']*')\s*$/i;
const CONDITION =
  /^\s*[a-z_][a-z0-9_]*\s*=\s*(\$[0-9]+|'[^']*'|ANY\(\$[0-9]+\))\s*$/i;

function evalValue(raw: string, params: unknown[]): unknown {
  const value = raw.trim();
  if (/^NULL$/i.test(value)) return null;
  if (/^now\(\)$/i.test(value)) return new Date().toISOString();
  const param = /^\$([0-9]+)$/.exec(value);
  if (param) return params[Number(param[1]) - 1];
  const literal = /^'([^']*)'$/.exec(value);
  if (literal) return literal[1];
  throw new Error(`syntax error at or near "${value}"`);
}

function conditionMatches(
  raw: string,
  row: Record<string, unknown>,
  params: unknown[]
): boolean {
  const condition = raw.trim();
  const anyMatch = /^\s*([a-z_][a-z0-9_]*)\s*=\s*ANY\(\$([0-9]+)\)\s*$/i.exec(
    condition
  );
  if (anyMatch) {
    const values = params[Number(anyMatch[2]) - 1];
    return Array.isArray(values) && values.includes(row[anyMatch[1]]);
  }
  const match = /^\s*([a-z_][a-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(condition);
  if (!match) throw new Error(`syntax error at or near "${condition}"`);
  return row[match[1]] === evalValue(match[2], params);
}

function makeLegacyClient(seedAccounts: AccountRow[]) {
  const accounts = seedAccounts.map((row) => ({ ...row }));
  const destinations: DestinationRow[] = [];
  const executed: Array<{ text: string; params: unknown[] }> = [];

  const query = async <T = unknown>(
    text: string,
    params: unknown[] = []
  ): Promise<T[]> => {
    executed.push({ text, params });
    const sql = text.replace(/\s+/g, ' ').trim();
    const parsed =
      /^UPDATE (social_accounts|destinations|queue_items) SET (.+?) WHERE (.+?)(?: RETURNING (.+))?$/.exec(
        sql
      );
    if (!parsed) {
      throw new Error(`unsupported statement in fake legacy client: ${sql}`);
    }
    const [, table, setClause, whereClause, returning] = parsed;

    // Postgres rejects a SET list that is not comma-separated
    // `column = value` assignments — a missing comma fusing two
    // assignments, or a trailing comma, is a syntax error.
    const assignments = setClause.split(',').map((segment) => {
      const match =
        /^\s*([a-z_][a-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(segment);
      if (!match || !ASSIGNMENT.test(segment)) {
        throw new Error(
          `syntax error at or near "${segment.trim() || ','}"`
        );
      }
      return { column: match[1], rawValue: match[2] };
    });
    const conditions = whereClause.split(/\s+AND\s+/i);
    for (const condition of conditions) {
      if (!CONDITION.test(condition)) {
        throw new Error(`syntax error at or near "${condition.trim()}"`);
      }
    }

    const store: Array<Record<string, unknown>> =
      table === 'social_accounts'
        ? (accounts as unknown as Array<Record<string, unknown>>)
        : table === 'destinations'
          ? (destinations as unknown as Array<Record<string, unknown>>)
          : [];
    const matched = store.filter((row) =>
      conditions.every((condition) =>
        conditionMatches(condition, row, params)
      )
    );
    for (const row of matched) {
      for (const { column, rawValue } of assignments) {
        row[column] = evalValue(rawValue, params);
      }
    }
    if (!returning) return [] as unknown as T[];
    return matched.map((row) => ({ id: row.id })) as unknown as T[];
  };

  return {
    accounts,
    destinations,
    executed,
    client: { query } as unknown as DatabaseClient,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('markSocialAccountRevoked — legacy path (spec 175)', () => {
  it('nulls both encrypted tokens on the revoked account', async () => {
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const store = makeLegacyClient([
      {
        id: 'acct-1',
        platform: 'facebook',
        external_account_id: 'ext-1',
        workspace_id: 'ws-1',
        status: 'active',
        encrypted_access_token: 'enc-access-token',
        encrypted_refresh_token: 'enc-refresh-token',
        updated_at: '2026-11-01T00:00:00.000Z',
      },
    ]);

    const result = await markSocialAccountRevoked(
      store.client,
      'facebook',
      'ext-1',
      'ws-1'
    );

    expect(result).toEqual({ updated: 1, propagationFailed: 0 });
    expect(store.accounts[0].status).toBe('revoked');
    expect(store.accounts[0].encrypted_access_token).toBeNull();
    expect(store.accounts[0].encrypted_refresh_token).toBeNull();
    // No loud failure was logged: the propagation really succeeded.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still flips the account to revoked when the row has no destinations', async () => {
    const store = makeLegacyClient([
      {
        id: 'acct-1',
        platform: 'facebook',
        external_account_id: 'ext-1',
        workspace_id: null,
        status: 'active',
        encrypted_access_token: 'enc-access-token',
        encrypted_refresh_token: null,
        updated_at: null,
      },
    ]);

    const result = await markSocialAccountRevoked(
      store.client,
      'facebook',
      'ext-1'
    );

    expect(result).toEqual({ updated: 1, propagationFailed: 0 });
    expect(store.accounts[0].encrypted_access_token).toBeNull();
  });

  it('reports zero updated when no account matches', async () => {
    const store = makeLegacyClient([]);
    const result = await markSocialAccountRevoked(
      store.client,
      'facebook',
      'ext-missing',
      'ws-1'
    );
    expect(result).toEqual({ updated: 0, propagationFailed: 0 });
  });
});

describe('markSocialAccountRevoked — Supabase path (spec 175)', () => {
  // Minimal chain: from().update().eq()...select('id') returns the
  // { data, error } the helper destructures; the token-nulling update
  // and the destinations propagation share the same chain shape. The
  // first select returns the revoked account id; later selects return
  // no rows (no destinations to flip), mirroring an account with no
  // active destinations.
  function supabaseClient() {
    const seen: {
      table: string | null;
      payload: unknown;
      eqs: Array<[string, unknown]>;
    } = { table: null, payload: null, eqs: [] };
    let selectCalls = 0;
    const chain: Record<string, (...args: never[]) => unknown> = {};
    chain.update = ((payload: unknown) => {
      seen.payload = payload;
      return chain;
    }) as (...args: never[]) => unknown;
    chain.eq = ((column: string, value: unknown) => {
      seen.eqs.push([column, value]);
      return chain;
    }) as (...args: never[]) => unknown;
    chain.in = ((_column: string, _values: unknown[]) => {
      return chain;
    }) as (...args: never[]) => unknown;
    chain.select = (async () => {
      selectCalls++;
      return selectCalls === 1
        ? { data: [{ id: 'acct-1' }], error: null }
        : { data: [], error: null };
    }) as (...args: never[]) => unknown;
    const from = (table: string) => {
      seen.table = table;
      return chain;
    };
    return { seen, client: { from } };
  }

  it('nulls both tokens in the update payload and leaves the path working', async () => {
    const { seen, client } = supabaseClient();
    const result = await markSocialAccountRevoked(
      client as never,
      'facebook',
      'ext-1',
      'ws-1'
    );

    expect(result).toEqual({ updated: 1, propagationFailed: 0 });
    // The token-nulling update (the last update on social_accounts)
    // nulls both tokens — the Supabase path was already correct.
    expect(seen.table).toBe('social_accounts');
    expect(seen.payload).toMatchObject({
      encrypted_access_token: null,
      encrypted_refresh_token: null,
    });
  });
});
