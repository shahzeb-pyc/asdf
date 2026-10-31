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
  op: 'eq' | 'in' | 'gte' | 'lt' | 'gt' | 'lte' | 'is' | 'neq';
  col: string;
  val: unknown;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const value = row[f.col];
    if (f.op === 'eq') return value === f.val;
    if (f.op === 'neq') return value !== f.val;
    if (f.op === 'in') return (f.val as unknown[]).includes(value);
    if (f.op === 'gte') return String(value) >= String(f.val);
    if (f.op === 'lt') return String(value) < String(f.val);
    if (f.op === 'gt') return String(value) > String(f.val);
    if (f.op === 'lte') return String(value) <= String(f.val);
    if (f.op === 'is') return f.val === null ? value == null : value === f.val;
    return true;
  });
}

let idCounter = 0;

/**
 * The builder is a genuine Promise (like tests/helpers/mock-supabase-pages),
 * NOT a custom thenable: Sonar rule S7739 flags a `then` method added to
 * a class, and this helper is not a *.test.ts file so it is scanned as
 * main code. Resolution is deferred to a microtask scheduled by the
 * first chain call, so the route's synchronous chain finishes before
 * execute() observes the final chain state.
 */
export class FakeBuilder extends Promise<unknown> {
  static get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  filters: Filter[] = [];
  private mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private head = false;
  private singleFlag = false;
  private selectAfterInsert = false;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private limitN: number | null = null;
  private orderCol: string | null = null;
  private orderAsc = true;
  private pendingInsert: Row[] | null = null;
  private pendingUpdate: Row | null = null;
  private resolveResult!: (value: unknown) => void;
  private rejectResult!: (reason: unknown) => void;
  private scheduled = false;
  private readonly table: string;
  private readonly db: Record<string, Row[]>;
  private readonly errors: Record<string, { message: string; code?: string; once?: boolean }>;
  private readonly calls: FakeCall[];

  constructor(
    table: string,
    db: Record<string, Row[]>,
    errors: Record<string, { message: string; code?: string; once?: boolean }>,
    calls: FakeCall[]
  ) {
    let resolveResult!: (value: unknown) => void;
    let rejectResult!: (reason: unknown) => void;
    super((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.resolveResult = resolveResult;
    this.rejectResult = rejectResult;
    this.table = table;
    this.db = db;
    this.errors = errors;
    this.calls = calls;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    void Promise.resolve().then(() => {
      try {
        this.resolveResult(this.execute());
      } catch (error) {
        this.rejectResult(error);
      }
    });
  }

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    this.schedule();
    if (this.mode === 'insert' || this.mode === 'upsert') {
      this.selectAfterInsert = true;
    } else {
      this.mode = 'select';
    }
    this.head = Boolean(opts?.head);
    return this;
  }

  eq(col: string, val: unknown) {
    this.schedule();
    this.filters.push({ op: 'eq', col, val });
    return this;
  }

  neq(col: string, val: unknown) {
    this.schedule();
    this.filters.push({ op: 'neq', col, val });
    return this;
  }

  in(col: string, val: unknown[]) {
    this.schedule();
    this.filters.push({ op: 'in', col, val });
    return this;
  }

  gte(col: string, val: unknown) {
    this.schedule();
    this.filters.push({ op: 'gte', col, val });
    return this;
  }

  lt(col: string, val: unknown) {
    this.schedule();
    this.filters.push({ op: 'lt', col, val });
    return this;
  }

  gt(col: string, val: unknown) {
    this.schedule();
    this.filters.push({ op: 'gt', col, val });
    return this;
  }

  lte(col: string, val: unknown) {
    this.schedule();
    this.filters.push({ op: 'lte', col, val });
    return this;
  }

  is(col: string, val: unknown) {
    this.schedule();
    this.filters.push({ op: 'is', col, val });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this.schedule();
    this.orderCol = col;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }

  range(from: number, to: number) {
    this.schedule();
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  limit(n: number) {
    this.schedule();
    this.limitN = n;
    return this;
  }

  insert(payload: Row | Row[]) {
    this.schedule();
    this.mode = 'insert';
    this.pendingInsert = Array.isArray(payload) ? payload : [payload];
    return this;
  }

  upsert(payload: Row, _opts?: unknown) {
    this.schedule();
    this.mode = 'upsert';
    this.pendingInsert = [payload];
    return this;
  }

  update(payload: Row) {
    this.schedule();
    this.mode = 'update';
    this.pendingUpdate = payload;
    return this;
  }

  delete() {
    this.schedule();
    this.mode = 'delete';
    return this;
  }

  single() {
    this.schedule();
    this.singleFlag = true;
    return this;
  }

  maybeSingle() {
    this.schedule();
    this.singleFlag = true;
    return this;
  }

  private execute(): unknown {
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
      return { data: null, count: null, error: err };
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
        return { data: inserted[0] ?? null, error: null };
      } else {
        return { data: inserted, error: null };
      }
    }
    if (this.mode === 'update') {
      for (const row of store) {
        if (matches(row, this.filters)) Object.assign(row, this.pendingUpdate);
      }
      return { error: null };
    }
    if (this.mode === 'delete') {
      this.db[this.table] = store.filter((row) => !matches(row, this.filters));
      return { error: null };
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
    if (this.limitN !== null) {
      rows = rows.slice(0, this.limitN);
    }
    if (this.head) {
      return { count: rows.length, error: null };
    }
    if (this.singleFlag) {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, count: rows.length, error: null };
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
