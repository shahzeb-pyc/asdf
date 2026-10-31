/**
 * Instagram Schedule API — Supabase path (live path, not the SQL path).
 *
 * Guards pinned here for the PR #67 SEND BACK Blocker 1 fix:
 * (1) Add counts ONLY scheduled destinations (metadata.scheduled
 * true) and calls checkScheduleCap() — an unscheduled connected
 * account must never consume the cap, and a set cap must return
 * 400 with no destination/slot change; (2) with the cap unset
 * (null, today's production value) Add still succeeds even with
 * many scheduled destinations; (3) the Schedule list fetches
 * destinations in bounded .range() chunks with the scheduled-only
 * DB filter, never one unbounded fetch of all Instagram
 * destinations; (4) a rollback failure in Add is logged under its
 * own distinct source and still returns the inner "Nothing was
 * saved" 500, never the generic outer-catch message.
 *
 * The production cap constant is null, so a set cap is simulated
 * by overriding checkScheduleCap() via a hoisted mock state — the
 * point under test is the wiring (route calls the hook with the
 * scheduled-only count), not the constant's current value. The
 * override mirrors the real hook's semantics exactly.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  handleListInstagramSchedule,
  handleAddInstagramSchedule,
} from '../../src/app/api/tenant/[subdomain]/instagram/schedule/route';
import { logServerError } from '@/lib/server-analytics';

const mockCapState = vi.hoisted(() => ({ cap: null as number | null }));

vi.mock('@/lib/server/instagram-schedule', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/instagram-schedule')>();
  return {
    ...actual,
    checkScheduleCap: (currentCount: number) => {
      if (mockCapState.cap === null) return { allowed: true as const };
      if (currentCount < mockCapState.cap) return { allowed: true as const };
      return {
        allowed: false as const,
        message: `You have reached the limit of ${mockCapState.cap} scheduled Instagram accounts for your plan.`,
      };
    },
  };
});

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

const mockedLogServerError = logServerError as unknown as ReturnType<
  typeof vi.fn
>;

const TEST_SECRET =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const USER_ID = '11111111-1111-4111-a111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-a222-222222222222';
const NEW_ACCOUNT_ID = '66666666-6666-4666-a666-666666666666';
const NEW_DEST_ID = '77777777-7777-4777-a777-777777777777';
const SLOT_ID = '88888888-8888-4888-a888-888888888888';

let validSessionCookie: string;

type Row = Record<string, unknown>;

interface CallRecord {
  table: string;
  filters: Array<[string, unknown]>;
  range: [number, number] | null;
  head: boolean;
  kind: string;
}

interface MockState {
  destinations: Row[];
  accounts: Row[];
  calls: CallRecord[];
  failSlotInsert: boolean;
  failRollbackDelete: boolean;
}

function makeDest(
  id: string,
  accountId: string,
  scheduled: boolean,
  createdAt: string
): Row {
  return {
    id,
    account_id: accountId,
    workspace_id: 'ws_123',
    platform: 'instagram',
    timezone: 'Asia/Karachi',
    status: 'active',
    metadata: scheduled ? { scheduled: true } : {},
    name: `Account ${accountId.slice(0, 8)}`,
    handle: null,
    avatar_url: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function makeAccount(id: string): Row {
  return {
    id,
    display_name: `Account ${id.slice(0, 8)}`,
    avatar_url: null,
    status: 'active',
    token_expires_at: '2027-01-01T00:00:00Z',
    external_account_id: `ig-${id.slice(0, 8)}`,
    workspace_id: 'ws_123',
    platform: 'instagram',
  };
}

class Builder {
  table: string;
  state: MockState;
  filters: Array<[string, unknown]> = [];
  selectOpts: { count?: string; head?: boolean } | undefined;
  rangeArgs: [number, number] | null = null;
  limitN: number | null = null;
  orderAsc: boolean | null = null;
  insertData: Row | null = null;
  updateData: Row | null = null;
  isDelete = false;

  constructor(table: string, state: MockState) {
    this.table = table;
    this.state = state;
  }

  select(_cols: string, opts?: { count?: string; head?: boolean }) {
    this.selectOpts = opts;
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push([col, val]);
    return this;
  }

  in(col: string, vals: unknown) {
    this.filters.push([col, vals]);
    return this;
  }

  order(_col: string, opts?: { ascending?: boolean }) {
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  range(from: number, to: number) {
    this.rangeArgs = [from, to];
    return this;
  }

  insert(data: Row) {
    this.insertData = data;
    return this;
  }

  update(data: Row) {
    this.updateData = data;
    return this;
  }

  delete() {
    this.isDelete = true;
    return this;
  }

  filteredRows(): Row[] {
    let rows: Row[];
    if (this.table === 'workspaces') {
      rows = [
        { id: 'ws_123', subdomain: 'acme', owner_id: USER_ID },
      ];
    } else if (this.table === 'social_accounts') {
      const inFilter = this.filters.find(([, v]) => Array.isArray(v));
      if (inFilter) {
        const ids = inFilter[1] as unknown[];
        return ids.map((id) => makeAccount(String(id)));
      }
      rows = [...this.state.accounts];
    } else if (this.table === 'destinations') {
      rows = [...this.state.destinations];
    } else if (this.table === 'posting_slots') {
      rows = [];
    } else if (this.table === 'queue_items') {
      rows = [];
    } else {
      rows = [];
    }
    for (const [col, val] of this.filters) {
      if (Array.isArray(val)) continue;
      if (col === 'metadata->>scheduled') {
        rows = rows.filter(
          (r) =>
            ((r.metadata as Row | null)?.scheduled as unknown) === true ===
            (val === 'true')
        );
        continue;
      }
      rows = rows.filter((r) => r[col] === val);
    }
    if (this.orderAsc !== null && this.table === 'destinations') {
      rows = [...rows].sort((a, b) => {
        const diff =
          new Date(String(a.created_at)).getTime() -
          new Date(String(b.created_at)).getTime();
        return this.orderAsc ? diff : -diff;
      });
    }
    return rows;
  }

  resolveList(): {
    data: Row[] | null;
    count?: number;
    error: { message: string } | null;
  } {
    const kind = this.isDelete
      ? 'delete'
      : this.insertData
        ? 'insert'
        : this.updateData
          ? 'update'
          : 'select';
    this.state.calls.push({
      table: this.table,
      filters: [...this.filters],
      range: this.rangeArgs,
      head: this.selectOpts?.head === true,
      kind,
    });
    if (this.selectOpts?.head) {
      return {
        data: null,
        count: this.filteredRows().length,
        error: null,
      };
    }
    if (this.isDelete) {
      if (this.state.failRollbackDelete) {
        return { data: null, error: { message: 'rollback delete failed' } };
      }
      return { data: null, error: null };
    }
    if (this.updateData) {
      return { data: null, error: null };
    }
    let rows = this.filteredRows();
    if (this.rangeArgs) {
      rows = rows.slice(this.rangeArgs[0], this.rangeArgs[1] + 1);
    }
    if (this.limitN !== null) {
      rows = rows.slice(0, this.limitN);
    }
    return { data: rows, error: null };
  }

  async maybeSingle() {
    const res = this.resolveList();
    return { data: (res.data ?? [])[0] ?? null, error: null };
  }

  async single() {
    if (this.insertData) {
      this.state.calls.push({
        table: this.table,
        filters: [...this.filters],
        range: null,
        head: false,
        kind: 'insert',
      });
      if (this.table === 'posting_slots' && this.state.failSlotInsert) {
        return { data: null, error: { message: 'slot insert failed' } };
      }
      if (this.table === 'destinations') {
        const row: Row = {
          ...this.insertData,
          id: NEW_DEST_ID,
          created_at: '2026-10-12T00:00:00Z',
          updated_at: '2026-10-12T00:00:00Z',
        };
        this.state.destinations.push(row);
        return { data: { id: NEW_DEST_ID }, error: null };
      }
      if (this.table === 'posting_slots') {
        return { data: { id: SLOT_ID }, error: null };
      }
      return { data: null, error: null };
    }
    const res = this.resolveList();
    return { data: (res.data ?? [])[0] ?? null, error: null };
  }

  then(
    resolve: (value: unknown) => void,
    reject: (reason: unknown) => void
  ) {
    return Promise.resolve(this.resolveList()).then(resolve, reject);
  }
}

function mockSupabase(state: MockState) {
  return {
    from: (table: string) => new Builder(table, state),
  };
}

function request(
  url: string,
  init?: { method?: string; body?: unknown }
): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: {
      cookie: validSessionCookie,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

function addBody(accountId: string) {
  return {
    accountId,
    timezone: 'Asia/Karachi',
    postingTimes: [{ time: '09:00', formats: ['image', 'reel', 'carousel'] }],
  };
}

describe('Instagram Schedule API — Supabase path', () => {
  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    mockCapState.cap = null;
    vi.clearAllMocks();
    const token = await signSessionToken(
      {
        userId: USER_ID,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    validSessionCookie = `fbup_session=${token}`;
  });

  it('refuses a Supabase Add at the cap, counting scheduled destinations only', async () => {
    mockCapState.cap = 1;
    const state: MockState = {
      destinations: [
        makeDest(
          '33333333-3333-4333-a333-333333333333',
          '44444444-4444-4444-a444-444444444444',
          true,
          '2026-10-11T00:00:00Z'
        ),
        // Unscheduled: connected, but must NOT consume the cap.
        makeDest(
          '55555555-5555-5555-a555-555555555555',
          '66666666-6666-4666-a666-666666666666',
          false,
          '2026-10-10T00:00:00Z'
        ),
      ],
      accounts: [makeAccount(NEW_ACCOUNT_ID)],
      calls: [],
      failSlotInsert: false,
      failRollbackDelete: false,
    };
    // The new account's own row must be the addable one; the
    // unscheduled destination above belongs to a different account
    // in this test's data (its account id is not NEW_ACCOUNT_ID in
    // the existing-destination lookup, so Add reaches the cap check).
    state.destinations[1].account_id = '99999999-9999-4999-a999-999999999999';
    const res = await handleAddInstagramSchedule(
      request('http://localhost:3000/api/tenant/acme/instagram/schedule', {
        method: 'POST',
        body: addBody(NEW_ACCOUNT_ID),
      }),
      'acme',
      mockSupabase(state) as any
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/limit of 1/);
    // The cap count query itself must filter scheduled-only.
    const countCall = state.calls.find(
      (c) => c.table === 'destinations' && c.head
    );
    expect(countCall).toBeDefined();
    expect(
      countCall?.filters.some(
        ([col, val]) => col === 'metadata->>scheduled' && val === 'true'
      )
    ).toBe(true);
    // No destination or slot was created or changed.
    expect(
      state.calls.some(
        (c) =>
          (c.table === 'destinations' || c.table === 'posting_slots') &&
          (c.kind === 'insert' || c.kind === 'update')
      )
    ).toBe(false);
    expect(
      state.destinations.some((d) => d.account_id === NEW_ACCOUNT_ID)
    ).toBe(false);
  });

  it('does not let an unscheduled destination trigger the cap', async () => {
    mockCapState.cap = 2;
    const state: MockState = {
      destinations: [
        makeDest(
          '33333333-3333-4333-a333-333333333333',
          '44444444-4444-4444-a444-444444444444',
          true,
          '2026-10-11T00:00:00Z'
        ),
        makeDest(
          '55555555-5555-5555-a555-555555555555',
          '99999999-9999-4999-a999-999999999999',
          false,
          '2026-10-10T00:00:00Z'
        ),
      ],
      accounts: [makeAccount(NEW_ACCOUNT_ID)],
      calls: [],
      failSlotInsert: false,
      failRollbackDelete: false,
    };
    const res = await handleAddInstagramSchedule(
      request('http://localhost:3000/api/tenant/acme/instagram/schedule', {
        method: 'POST',
        body: addBody(NEW_ACCOUNT_ID),
      }),
      'acme',
      mockSupabase(state) as any
    );
    // Scheduled-only count is 1 < 2, so Add succeeds. Counting all
    // destinations (2) would have wrongly returned 400 here.
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.destinationId).toBe(NEW_DEST_ID);
  });

  it('allows Add with the cap unset, even with many scheduled destinations', async () => {
    mockCapState.cap = null;
    const destinations: Row[] = [];
    for (let i = 0; i < 10; i++) {
      destinations.push(
        makeDest(
          `10000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
          `20000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
          true,
          `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`
        )
      );
    }
    const state: MockState = {
      destinations,
      accounts: [makeAccount(NEW_ACCOUNT_ID)],
      calls: [],
      failSlotInsert: false,
      failRollbackDelete: false,
    };
    const res = await handleAddInstagramSchedule(
      request('http://localhost:3000/api/tenant/acme/instagram/schedule', {
        method: 'POST',
        body: addBody(NEW_ACCOUNT_ID),
      }),
      'acme',
      mockSupabase(state) as any
    );
    expect(res.status).toBe(201);
  });

  it('lists only scheduled destinations via bounded, scheduled-only fetches', async () => {
    const state: MockState = {
      destinations: [
        makeDest(
          '33333333-3333-4333-a333-333333333333',
          '44444444-4444-4444-a444-444444444444',
          true,
          '2026-10-11T00:00:00Z'
        ),
        makeDest(
          '55555555-5555-5555-a555-555555555555',
          '99999999-9999-4999-a999-999999999999',
          false,
          '2026-10-10T00:00:00Z'
        ),
        makeDest(
          '66666666-6666-4666-a666-666666666666',
          '77777777-7777-4777-a777-777777777777',
          true,
          '2026-10-12T00:00:00Z'
        ),
      ],
      accounts: [],
      calls: [],
      failSlotInsert: false,
      failRollbackDelete: false,
    };
    const res = await handleListInstagramSchedule(
      request('http://localhost:3000/api/tenant/acme/instagram/schedule'),
      'acme',
      mockSupabase(state) as any
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(2);
    expect(json.items).toHaveLength(2);
    const destFetches = state.calls.filter(
      (c) => c.table === 'destinations' && !c.head
    );
    expect(destFetches.length).toBeGreaterThan(0);
    expect(destFetches.every((c) => c.range !== null)).toBe(true);
    expect(
      destFetches.every((c) =>
        c.filters.some(
          ([col, val]) => col === 'metadata->>scheduled' && val === 'true'
        )
      )
    ).toBe(true);
  });

  it('chunks a large Supabase list fetch instead of one unbounded fetch', async () => {
    const destinations: Row[] = [];
    for (let i = 0; i < 250; i++) {
      destinations.push(
        makeDest(
          `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
          true,
          `2026-10-01T00:00:00Z`
        )
      );
    }
    const state: MockState = {
      destinations,
      accounts: [],
      calls: [],
      failSlotInsert: false,
      failRollbackDelete: false,
    };
    const res = await handleListInstagramSchedule(
      request('http://localhost:3000/api/tenant/acme/instagram/schedule'),
      'acme',
      mockSupabase(state) as any
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(250);
    expect(json.items).toHaveLength(30);
    const ranges = state.calls
      .filter((c) => c.table === 'destinations' && !c.head && c.range)
      .map((c) => c.range?.[0]);
    expect(ranges).toContain(0);
    expect(ranges).toContain(200);
    expect(Math.max(...(ranges as number[]))).toBe(200);
  });

  it('logs a rollback failure distinctly and keeps the inner 500', async () => {
    const state: MockState = {
      destinations: [],
      accounts: [makeAccount(NEW_ACCOUNT_ID)],
      calls: [],
      failSlotInsert: true,
      failRollbackDelete: true,
    };
    const res = await handleAddInstagramSchedule(
      request('http://localhost:3000/api/tenant/acme/instagram/schedule', {
        method: 'POST',
        body: addBody(NEW_ACCOUNT_ID),
      }),
      'acme',
      mockSupabase(state) as any
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toMatch(/Nothing was saved/);
    expect(
      mockedLogServerError.mock.calls.some((call) =>
        String(call[0]).includes('add rollback failed')
      )
    ).toBe(true);
  });
});
