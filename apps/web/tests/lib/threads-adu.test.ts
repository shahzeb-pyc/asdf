/**
 * Threads Auto Download/Upload scoping (PR #62).
 *
 * Every Threads ADU route reads through loadThreadsAduDestination, so a
 * Facebook config — or a Threads config from another workspace — must
 * read as "not found" here, never as a Threads config. The view builder
 * must also use Threads wording (fallback name and status alert), never
 * the Facebook ones. This test is also the Sonar new-code coverage for
 * apps/web/src/lib/server/threads-adu.ts: components, app routes,
 * worker and contracts are all excluded from Sonar coverage, so this
 * is the only coverable new production file in the PR.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  loadThreadsAduConfigView,
  loadThreadsAduDestination,
  threadsAduMissingTable,
} from '../../src/lib/server/threads-adu';

// Same mocks as the Facebook ADU view test: the auth/workspace modules
// are replaced, the Threads module under test is real.
vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(),
  getRouteSupabase: vi.fn(),
}));
vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: vi.fn(),
}));
vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveTenantWorkspaceId: vi.fn(),
}));

type Row = Record<string, unknown>;

interface Filter {
  op: 'eq' | 'in' | 'gte';
  col: string;
  val: unknown;
}

function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((row) =>
    filters.every((f) => {
      const value = row[f.col];
      if (f.op === 'eq') return value === f.val;
      if (f.op === 'in') return (f.val as unknown[]).includes(value);
      if (f.op === 'gte') return String(value) >= String(f.val);
      return true;
    }),
  );
}

class FakeBuilder {
  filters: Filter[] = [];
  head = false;
  single = false;
  constructor(
    private readonly table: string,
    private readonly db: Record<string, Row[]>,
    private readonly errors: Record<string, string> = {},
  ) {}

  select(_cols: string, opts?: { count?: string; head?: boolean }) {
    this.head = Boolean(opts?.head);
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ op: 'eq', col, val });
    return this;
  }

  in(col: string, val: unknown[]) {
    this.filters.push({ op: 'in', col, val });
    return this;
  }

  gte(col: string, val: unknown) {
    this.filters.push({ op: 'gte', col, val });
    return this;
  }

  maybeSingle() {
    this.single = true;
    return this;
  }

  then(resolve: (value: unknown) => void) {
    const code = this.errors[this.table];
    if (code) {
      resolve(this.head ? { count: null, error: { code } } : { data: null, error: { code } });
      return;
    }
    const rows = applyFilters(this.db[this.table] ?? [], this.filters);
    if (this.head) resolve({ count: rows.length, error: null });
    else if (this.single) resolve({ data: rows[0] ?? null, error: null });
    else resolve({ data: rows, error: null });
  }
}

function fakeSupabase(db: Record<string, Row[]>, errors: Record<string, string> = {}) {
  return { from: (table: string) => new FakeBuilder(table, db, errors) };
}

function configRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'cfg-1',
    workspace_id: 'ws-1',
    destination_id: 'dest-1',
    source_platform: 'tiktok',
    source_username: 'creator',
    timezone: 'UTC',
    posts_per_day: 1,
    schedule_type: 'dailyrandom',
    posting_times: ['09:00'],
    status: 'active',
    sync_status: 'synced',
    followers_count: 0,
    followers_gained: 0,
    display_name: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function threadsDestination(overrides: Partial<Row> = {}): Row {
  return {
    id: 'dest-1',
    workspace_id: 'ws-1',
    platform: 'threads',
    account_id: 'acc-1',
    name: 'My Threads',
    external_destination_id: 'threads-1',
    avatar_url: null,
    status: 'active',
    social_accounts: { display_name: 'Owner', avatar_url: null },
    ...overrides,
  };
}

describe('loadThreadsAduDestination scoping', () => {
  it('returns the config and destination for a Threads destination in the workspace', async () => {
    const client = fakeSupabase({
      adu_configs: [configRow()],
      destinations: [threadsDestination()],
    });
    const scoped = await loadThreadsAduDestination(client as never, 'ws-1', 'cfg-1');
    expect(scoped?.destination.platform).toBe('threads');
    expect(scoped?.config.id).toBe('cfg-1');
  });

  it('returns null for a Facebook destination', async () => {
    const client = fakeSupabase({
      adu_configs: [configRow()],
      destinations: [threadsDestination({ platform: 'facebook' })],
    });
    await expect(loadThreadsAduDestination(client as never, 'ws-1', 'cfg-1')).resolves.toBeNull();
  });

  it('returns null for a Threads destination in another workspace', async () => {
    const client = fakeSupabase({
      adu_configs: [configRow()],
      destinations: [threadsDestination({ workspace_id: 'ws-2' })],
    });
    await expect(loadThreadsAduDestination(client as never, 'ws-1', 'cfg-1')).resolves.toBeNull();
  });

  it('returns null when the config or the destination is missing or errors', async () => {
    const missingConfig = fakeSupabase({ adu_configs: [], destinations: [threadsDestination()] });
    await expect(loadThreadsAduDestination(missingConfig as never, 'ws-1', 'cfg-1')).resolves.toBeNull();
    const missingDest = fakeSupabase({ adu_configs: [configRow()], destinations: [] });
    await expect(loadThreadsAduDestination(missingDest as never, 'ws-1', 'cfg-1')).resolves.toBeNull();
    const errored = fakeSupabase(
      { adu_configs: [configRow()], destinations: [threadsDestination()] },
      { adu_configs: '500' },
    );
    await expect(loadThreadsAduDestination(errored as never, 'ws-1', 'cfg-1')).resolves.toBeNull();
    const destErrored = fakeSupabase(
      { adu_configs: [configRow()], destinations: [threadsDestination()] },
      { destinations: '500' },
    );
    await expect(loadThreadsAduDestination(destErrored as never, 'ws-1', 'cfg-1')).resolves.toBeNull();
  });
});

describe('loadThreadsAduConfigView wording', () => {
  it('builds a view with the Threads destination name and Threads alert', async () => {
    const client = fakeSupabase({
      adu_configs: [configRow({ status: 'invalid_token' })],
      destinations: [threadsDestination()],
      adu_reels: [],
      adu_posting_jobs: [],
    });
    const view = await loadThreadsAduConfigView(client as never, 'ws-1', 'cfg-1');
    expect(view?.destinationName).toBe('My Threads');
    expect(view?.alert).toBe('The Threads connection is invalid. Reconnect the account in Threads Accounts.');
    expect(view?.alert).not.toContain('Facebook');
  });

  it('falls back to "Threads account", never "Facebook Page", when no name exists', async () => {
    const client = fakeSupabase({
      adu_configs: [configRow()],
      destinations: [threadsDestination({ name: null })],
      adu_reels: [],
      adu_posting_jobs: [],
    });
    const view = await loadThreadsAduConfigView(client as never, 'ws-1', 'cfg-1');
    expect(view?.destinationName).toBe('Threads account');
  });

  it('returns null for a Facebook config', async () => {
    const client = fakeSupabase({
      adu_configs: [configRow()],
      destinations: [threadsDestination({ platform: 'facebook' })],
      adu_reels: [],
      adu_posting_jobs: [],
    });
    await expect(loadThreadsAduConfigView(client as never, 'ws-1', 'cfg-1')).resolves.toBeNull();
  });
});

describe('threadsAduMissingTable', () => {
  it('detects the missing-table code and nothing else', () => {
    expect(threadsAduMissingTable({ code: '42P01' })).toBe(true);
    expect(threadsAduMissingTable({ code: '23505' })).toBe(false);
    expect(threadsAduMissingTable(null)).toBe(false);
  });
});
