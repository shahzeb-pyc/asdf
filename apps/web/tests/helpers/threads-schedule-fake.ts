/**
 * Fake Supabase client for Threads Schedule tests.
 *
 * A real, stateful in-memory store — not a stub that returns canned
 * responses. Queries filter, sort, page, insert, update and delete
 * against the store, so a test that removes the production logic
 * (cancel-first ordering, rollback, status gates) fails instead of
 * passing on a canned answer. Error injection is per table+operation
 * so failure paths (cancel failure, slot failure, duplicate slot)
 * can be exercised deterministically.
 */
export type Row = Record<string, unknown>;

export interface FakeCall {
  table: string;
  mode: string;
  payload?: unknown;
  filters: Array<{ op: string; col: string; val: unknown }>;
}

interface Filter {
  op: 'eq' | 'in' | 'gte' | 'lt' | 'gt';
  col: string;
  val: unknown;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const value = row[f.col];
    if (f.op === 'eq') return value === f.val;
    if (f.op === 'in') return (f.val as unknown[]).includes(value);
    if (f.op === 'gte') return String(value) >= String(f.val);
    if (f.op === 'lt') return String(value) < String(f.val);
    if (f.op === 'gt') return String(value) > String(f.val);
    return true;
  });
}

let idCounter = 0;

export class FakeBuilder {
  filters: Filter[] = [];
  private mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private head = false;
  private singleFlag = false;
  private selectAfterInsert = false;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private orderCol: string | null = null;
  private orderAsc = true;
  private pendingInsert: Row[] | null = null;
  private pendingUpdate: Row | null = null;

  constructor(
    private readonly table: string,
    private readonly db: Record<string, Row[]>,
    private readonly errors: Record<string, { message: string; code?: string; once?: boolean }>,
    private readonly calls: FakeCall[]
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.mode === 'insert' || this.mode === 'upsert') {
      this.selectAfterInsert = true;
    } else {
      this.mode = 'select';
    }
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

  lt(col: string, val: unknown) {
    this.filters.push({ op: 'lt', col, val });
    return this;
  }

  gt(col: string, val: unknown) {
    this.filters.push({ op: 'gt', col, val });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }

  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  insert(payload: Row | Row[]) {
    this.mode = 'insert';
    this.pendingInsert = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  upsert(payload: Row, _opts?: unknown) {
    this.mode = 'upsert';
    this.pendingInsert = [payload];
    return this;
  }

  update(payload: Row) {
    this.mode = 'update';
    this.pendingUpdate = payload;
    return this;
  }

  delete() {
    this.mode = 'delete';
    return this;
  }

  single() {
    this.singleFlag = true;
    return this;
  }

  maybeSingle() {
    this.singleFlag = true;
    return this;
  }

  then(resolve: (value: unknown) => void) {
    const errKey = `${this.table}:${this.mode}`;
    const err = this.errors[errKey];
    if (err?.once) delete this.errors[errKey];
    this.calls.push({
      table: this.table,
      mode: this.mode,
      payload: this.pendingUpdate ?? this.pendingInsert ?? undefined,
      filters: [...this.filters],
    });
    if (err) {
      resolve({ data: null, count: null, error: err });
      return;
    }
    const store = (this.db[this.table] ??= []);
    if (this.mode === 'insert' || this.mode === 'upsert') {
      const inserted = (this.pendingInsert ?? []).map((row) => {
        const now = new Date().toISOString();
        const full: Row = {
          ...row,
          id: (row.id as string) ?? `fake-${++idCounter}`,
          created_at: row.created_at ?? now,
          updated_at: row.updated_at ?? now,
        };
        if (this.mode === 'upsert') {
          const duplicate = store.some(
            (existing) =>
              existing.workspace_id === full.workspace_id &&
              existing.user_id === full.user_id &&
              existing.action === full.action &&
              existing.idempotency_key === full.idempotency_key
          );
          if (!duplicate) store.push(full);
        } else {
          store.push(full);
        }
        return full;
      });
      if (this.selectAfterInsert && this.singleFlag) {
        resolve({ data: inserted[0] ?? null, error: null });
      } else {
        resolve({ data: inserted, error: null });
      }
      return;
    }
    if (this.mode === 'update') {
      for (const row of store) {
        if (matches(row, this.filters)) Object.assign(row, this.pendingUpdate);
      }
      resolve({ error: null });
      return;
    }
    if (this.mode === 'delete') {
      this.db[this.table] = store.filter((row) => !matches(row, this.filters));
      resolve({ error: null });
      return;
    }
    // select
    let rows = store.filter((row) => matches(row, this.filters));
    if (this.orderCol) {
      const col = this.orderCol;
      const asc = this.orderAsc;
      rows = [...rows].sort((a, b) => {
        const av = String(a[col] ?? '');
        const bv = String(b[col] ?? '');
        return asc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
    }
    if (this.head) {
      resolve({ count: rows.length, error: null });
      return;
    }
    if (this.singleFlag) {
      resolve({ data: rows[0] ?? null, error: null });
      return;
    }
    resolve({ data: rows, count: rows.length, error: null });
  }
}

export interface FakeSupabase {
  from: (table: string) => FakeBuilder;
  calls: FakeCall[];
  errors: Record<string, { message: string; code?: string; once?: boolean }>;
}

export function fakeSupabase(
  db: Record<string, Row[]>,
  errors: Record<string, { message: string; code?: string; once?: boolean }> = {}
): FakeSupabase {
  const calls: FakeCall[] = [];
  return {
    from: (table: string) => new FakeBuilder(table, db, errors, calls),
    calls,
    errors,
  };
}

export function destinationRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'dest-1',
    account_id: 'acct-1',
    platform: 'threads',
    external_destination_id: 'threads-1',
    name: 'Test Threads',
    handle: 'testthreads',
    avatar_url: null,
    timezone: 'UTC',
    status: 'active',
    metadata: { threads_schedule_added_at: '2026-01-01T00:00:00.000Z' },
    workspace_id: 'ws-1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function accountRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'acct-1',
    external_account_id: 'threads-1',
    display_name: 'Test Account',
    avatar_url: null,
    status: 'active',
    token_expires_at: null,
    workspace_id: 'ws-1',
    platform: 'threads',
    ...overrides,
  };
}

export function queueRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'item-1',
    workspace_id: 'ws-1',
    destination_id: 'dest-1',
    kind: 'text',
    caption: 'Hello Threads',
    scheduled_time: '2026-02-01T09:00:00.000Z',
    status: 'queued',
    error_message: null,
    external_post_id: null,
    retry_count: 0,
    created_at: '2026-01-02T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    media: null,
    ...overrides,
  };
}
