/**
 * @file social-list-pagination.test.ts
 * @description Spec 139 (audit B14): `fetchSocialAccountsWithDestinations`
 * must page through PostgREST with bounded `.range()` slices instead of
 * trusting an unbounded select, which the server silently truncates at
 * its `max_rows` cap (1,000). The fake client below emulates that server
 * cap — a query with no `.range()` never returns more than 1,000 rows —
 * so these tests fail against the pre-fix loader.
 */
import { describe, expect, it } from 'vitest';
import {
  fetchSocialAccountsWithDestinations,
  SOCIAL_LIST_MAX_PAGES,
  SOCIAL_LIST_PAGE_SIZE,
  type ConnectDbClient,
} from '@/lib/connect/persist';

const workspaceId = '22222222-2222-4222-a222-222222222222';
const otherWorkspaceId = '33333333-3333-4333-a333-333333333333';

/** PostgREST's default `max_rows`: an unranged response is cut here. */
const SERVER_MAX_ROWS = 1_000;

type Row = Record<string, unknown>;
interface FakeResult {
  data: Row[] | null;
  error: { message: string } | null;
}

interface FakeOptions {
  /** Return this error when a page of `table` starts at `from`. */
  failOnPage?: (table: string, from: number) => { message: string } | null;
  /** Every page comes back full, forever (exercises the page cap). */
  endlessFullPages?: boolean;
}

class FakeSupabaseQuery implements PromiseLike<FakeResult> {
  private readonly filters: Array<{ column: string; value: unknown }> = [];
  private readonly orders: Array<{ column: string; ascending: boolean }> = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;

  constructor(
    private readonly tables: Map<string, Row[]>,
    private readonly table: string,
    private readonly options: FakeOptions
  ) {}

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ column, value });
    return this;
  }

  order(column: string, options: { ascending: boolean }): this {
    this.orders.push({ column, ascending: options.ascending });
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?:
      | ((value: FakeResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute(): FakeResult {
    const from = this.rangeFrom ?? 0;
    const failure = this.options.failOnPage?.(this.table, from);
    if (failure) {
      return { data: null, error: failure };
    }
    if (this.options.endlessFullPages) {
      const size = SOCIAL_LIST_PAGE_SIZE;
      return {
        data: Array.from({ length: size }, (_, i) =>
          makeAccountRow(from + i)
        ),
        error: null,
      };
    }
    let rows = (this.tables.get(this.table) ?? []).filter((row) =>
      this.filters.every(({ column, value }) => row[column] === value)
    );
    rows = [...rows].sort((a, b) => {
      for (const { column, ascending } of this.orders) {
        const av = String(a[column] ?? '');
        const bv = String(b[column] ?? '');
        if (av !== bv) {
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        }
      }
      return 0;
    });
    if (this.rangeFrom === null || this.rangeTo === null) {
      // Server behaviour without an explicit range: silent cap.
      return { data: rows.slice(0, SERVER_MAX_ROWS), error: null };
    }
    return { data: rows.slice(this.rangeFrom, this.rangeTo + 1), error: null };
  }
}

function makeFakeClient(
  tables: Map<string, Row[]>,
  options: FakeOptions = {}
): ConnectDbClient {
  return {
    from: (table: string) => new FakeSupabaseQuery(tables, table, options),
  } as unknown as ConnectDbClient;
}

function makeAccountRow(index: number, overrides: Row = {}): Row {
  return {
    id: `acct-${String(index).padStart(6, '0')}`,
    workspace_id: workspaceId,
    platform: 'facebook',
    external_account_id: `ext-${index}`,
    display_name: `Account ${index}`,
    avatar_url: null,
    status: 'active',
    token_expires_at: null,
    // Newest first under created_at DESC = lowest index first.
    created_at: new Date(Date.UTC(2026, 0, 1) - index * 1_000).toISOString(),
    ...overrides,
  };
}

function makeDestinationRow(
  index: number,
  accountId: string,
  overrides: Row = {}
): Row {
  return {
    id: `dest-${String(index).padStart(6, '0')}`,
    workspace_id: workspaceId,
    account_id: accountId,
    external_destination_id: `ext-dest-${index}`,
    name: `Destination ${index}`,
    handle: null,
    avatar_url: null,
    timezone: 'UTC',
    status: 'active',
    // Oldest first under created_at ASC = lowest index first.
    created_at: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
    ...overrides,
  };
}

describe('fetchSocialAccountsWithDestinations bounded pagination (B14)', () => {
  it('returns all 2,500 accounts across pages, not the 1,000-row server cap', async () => {
    const accounts = Array.from({ length: 2_500 }, (_, i) =>
      makeAccountRow(i)
    );
    // Another workspace's rows share the tables and must stay filtered out.
    accounts.push(
      makeAccountRow(90_001, { workspace_id: otherWorkspaceId }),
      makeAccountRow(90_002, { workspace_id: otherWorkspaceId })
    );
    const tables = new Map<string, Row[]>([
      ['social_accounts', accounts],
      ['destinations', []],
    ]);

    const result = await fetchSocialAccountsWithDestinations(
      makeFakeClient(tables),
      workspaceId
    );

    expect(result).toHaveLength(2_500);
    expect(result[0]?.id).toBe('acct-000000');
    expect(result[2_499]?.id).toBe('acct-002499');
    expect(result.every((a) => a.destinations.length === 0)).toBe(true);
  });

  it('returns all 2,500 destinations across pages, joined to their account', async () => {
    const account = makeAccountRow(0);
    const destinations = Array.from({ length: 2_500 }, (_, i) =>
      makeDestinationRow(i, account.id as string)
    );
    const tables = new Map<string, Row[]>([
      ['social_accounts', [account]],
      ['destinations', destinations],
    ]);

    const result = await fetchSocialAccountsWithDestinations(
      makeFakeClient(tables),
      workspaceId
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.destinations).toHaveLength(2_500);
    expect(result[0]?.destinations[0]?.id).toBe('dest-000000');
    expect(result[0]?.destinations[2_499]?.id).toBe('dest-002499');
  });

  it('propagates a mid-pagination error instead of returning a partial list', async () => {
    const accounts = Array.from({ length: 2_500 }, (_, i) =>
      makeAccountRow(i)
    );
    const tables = new Map<string, Row[]>([
      ['social_accounts', accounts],
      ['destinations', []],
    ]);
    const client = makeFakeClient(tables, {
      failOnPage: (table, from) =>
        table === 'social_accounts' && from === SOCIAL_LIST_PAGE_SIZE
          ? { message: 'connection reset mid-list' }
          : null,
    });

    await expect(
      fetchSocialAccountsWithDestinations(client, workspaceId)
    ).rejects.toThrow(
      'Failed to load connected accounts: connection reset mid-list'
    );
  });

  it('propagates a destinations page error with the destinations prefix', async () => {
    const account = makeAccountRow(0);
    const destinations = Array.from({ length: 1_500 }, (_, i) =>
      makeDestinationRow(i, account.id as string)
    );
    const tables = new Map<string, Row[]>([
      ['social_accounts', [account]],
      ['destinations', destinations],
    ]);
    const client = makeFakeClient(tables, {
      failOnPage: (table, from) =>
        table === 'destinations' && from === SOCIAL_LIST_PAGE_SIZE
          ? { message: 'statement timeout' }
          : null,
    });

    await expect(
      fetchSocialAccountsWithDestinations(client, workspaceId)
    ).rejects.toThrow('Failed to load destinations: statement timeout');
  });

  it('orders stably across page boundaries when created_at ties', async () => {
    const tiedTimestamp = new Date(Date.UTC(2026, 0, 1)).toISOString();
    // 2,500 rows sharing ONE created_at, stored in scrambled id order:
    // only the secondary id key makes the page order deterministic.
    const scrambled = Array.from({ length: 2_500 }, (_, i) => (i * 733) % 2_500);
    const accounts = scrambled.map((i) =>
      makeAccountRow(i, { created_at: tiedTimestamp })
    );
    const destinations = scrambled.map((i) =>
      makeDestinationRow(i, 'acct-000000', { created_at: tiedTimestamp })
    );
    const tables = new Map<string, Row[]>([
      ['social_accounts', accounts],
      ['destinations', destinations],
    ]);

    const result = await fetchSocialAccountsWithDestinations(
      makeFakeClient(tables),
      workspaceId
    );

    // Accounts: created_at DESC, id DESC tiebreak.
    const expectedAccountIds = Array.from({ length: 2_500 }, (_, i) =>
      `acct-${String(2_499 - i).padStart(6, '0')}`
    );
    expect(result.map((a) => a.id)).toEqual(expectedAccountIds);
    // No row skipped or repeated across the three pages.
    expect(new Set(result.map((a) => a.id)).size).toBe(2_500);

    // Destinations: created_at ASC, id ASC tiebreak.
    const owner = result.find((a) => a.id === 'acct-000000');
    const expectedDestinationIds = Array.from({ length: 2_500 }, (_, i) =>
      `dest-${String(i).padStart(6, '0')}`
    );
    expect(owner?.destinations.map((d) => d.id)).toEqual(
      expectedDestinationIds
    );
  });

  it('throws loudly past the page cap instead of truncating', async () => {
    const tables = new Map<string, Row[]>([
      ['social_accounts', []],
      ['destinations', []],
    ]);
    const client = makeFakeClient(tables, { endlessFullPages: true });

    await expect(
      fetchSocialAccountsWithDestinations(client, workspaceId)
    ).rejects.toThrow(
      `exceeded the ${SOCIAL_LIST_MAX_PAGES}-page safety cap`
    );
  });

  it('groups one account destinations by section, keeping created_at order inside each section (spec 174 2A)', async () => {
    const account = makeAccountRow(0);
    // Created in adu, mirror, schedule, NULL order — the loader
    // re-groups them schedule, adu, mirror, NULL, without
    // reordering inside a section.
    const destinations = [
      makeDestinationRow(0, account.id as string, { section: 'adu' }),
      makeDestinationRow(1, account.id as string, { section: 'mirror' }),
      makeDestinationRow(2, account.id as string, { section: 'schedule' }),
      makeDestinationRow(3, account.id as string, { section: null }),
      makeDestinationRow(4, account.id as string, { section: 'adu' }),
    ];
    const tables = new Map<string, Row[]>([
      ['social_accounts', [account]],
      ['destinations', destinations],
    ]);

    const result = await fetchSocialAccountsWithDestinations(
      makeFakeClient(tables),
      workspaceId
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.destinations.map((d) => d.id)).toEqual([
      'dest-000002',
      'dest-000000',
      'dest-000004',
      'dest-000001',
      'dest-000003',
    ]);
    expect(result[0]?.destinations.map((d) => d.section)).toEqual([
      'schedule',
      'adu',
      'adu',
      'mirror',
      null,
    ]);
  });
});
