/**
 * Minimal in-memory PostgREST double for the Pages list Supabase path.
 *
 * It implements only the chain the route uses — select (including
 * `{ count: 'exact', head: true }`), eq, neq, not, or, order, range,
 * maybeSingle — and evaluates the filters against seeded destination
 * rows, so tests can pin that the route issues real DB range queries
 * (via `returnedRowIds`) instead of fetching the whole list. It is a
 * test double, not a PostgREST reimplementation: the or() evaluator
 * handles the predicate shapes the route builds (group predicates,
 * search ilike) and nothing else.
 */

export interface MockDestinationRow {
  id: string;
  account_id: string;
  external_destination_id: string;
  name: string;
  avatar_url: string | null;
  metadata: Record<string, unknown> | null;
  status: string;
  created_at: string;
  updated_at: string;
  social_accounts: { display_name: string; avatar_url?: string | null } | null;
}

type Condition =
  | { kind: 'and'; parts: Condition[] }
  | { kind: 'or'; parts: Condition[] }
  | { kind: 'cmp'; column: string; op: string; value: string };

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function parseCondition(input: string): Condition {
  const trimmed = input.trim();
  const andMatch = /^and\((.*)\)$/s.exec(trimmed);
  if (andMatch) {
    return { kind: 'and', parts: splitTopLevel(andMatch[1] as string).map(parseCondition) };
  }
  const orMatch = /^or\((.*)\)$/s.exec(trimmed);
  if (orMatch) {
    return { kind: 'or', parts: splitTopLevel(orMatch[1] as string).map(parseCondition) };
  }
  const dot = trimmed.indexOf('.');
  const column = trimmed.slice(0, dot);
  const rest = trimmed.slice(dot + 1);
  const opEnd = rest.indexOf('.');
  if (opEnd === -1) {
    return { kind: 'cmp', column, op: rest, value: '' };
  }
  return {
    kind: 'cmp',
    column,
    op: rest.slice(0, opEnd),
    value: rest.slice(opEnd + 1),
  };
}

function columnValue(row: MockDestinationRow, column: string): unknown {
  if (column.startsWith('metadata->>')) {
    return row.metadata?.[column.slice('metadata->>'.length)] ?? null;
  }
  if (column === 'social_accounts.display_name') {
    return row.social_accounts?.display_name ?? null;
  }
  return (row as unknown as Record<string, unknown>)[column] ?? null;
}

function evalCondition(row: MockDestinationRow, cond: Condition): boolean {
  if (cond.kind === 'and') return cond.parts.every((p) => evalCondition(row, p));
  if (cond.kind === 'or') return cond.parts.some((p) => evalCondition(row, p));
  const actual = columnValue(row, cond.column);
  const value = cond.value;
  switch (cond.op) {
    case 'eq':
      return String(actual ?? '') === value;
    case 'neq':
      return actual !== null && actual !== undefined && String(actual) !== value;
    case 'gt':
      return actual !== null && actual !== undefined && String(actual) > value;
    case 'gte':
      return actual !== null && actual !== undefined && String(actual) >= value;
    case 'lt':
      return actual !== null && actual !== undefined && String(actual) < value;
    case 'lte':
      return actual !== null && actual !== undefined && String(actual) <= value;
    case 'ilike': {
      const needle = value.replace(/^%|%$/g, '').toLowerCase();
      return String(actual ?? '').toLowerCase().includes(needle);
    }
    case 'in': {
      const options = value.replace(/^\(|\)$/g, '').split(',');
      return options.includes(String(actual ?? ''));
    }
    case 'is':
      return value === 'null' ? actual === null || actual === undefined : String(actual) === value;
    default:
      throw new Error(`unsupported mock filter op: ${cond.op}`);
  }
}

class MockQuery {
  private filters: Condition[] = [];
  private orderKey: string | null = null;
  private orderAsc = true;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private head = false;

  constructor(
    private readonly rows: MockDestinationRow[],
    private readonly tracker: { returnedRowIds: string[] }
  ) {}

  select(_columns: string, options?: { count?: string; head?: boolean }): this {
    this.head = options?.head === true;
    return this;
  }

  eq(column: string, value: unknown): this {
    // Workspace/platform scoping is pass-through here: the seed is
    // already one workspace's facebook destinations (the old naive
    // mock never checked these columns either), so tests pin the
    // pagination/range behaviour, not tenant isolation.
    if (column === 'workspace_id' || column === 'platform') {
      return this;
    }
    this.filters.push({ kind: 'cmp', column, op: 'eq', value: String(value) });
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push({ kind: 'cmp', column, op: 'neq', value: String(value) });
    return this;
  }

  not(column: string, op: string, value: unknown): this {
    // Only the `not … in (…)` shape is used by the route; model it as
    // a negated comparison over the same evaluator.
    this.filters.push({
      kind: 'cmp',
      column: `__not_${column}`,
      op,
      value: String(value),
    });
    return this;
  }

  or(filters: string): this {
    this.filters.push(parseCondition(`or(${filters})`));
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderKey = column;
    this.orderAsc = options?.ascending !== false;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  maybeSingle(): Promise<{ data: { id: string } | null; error: null }> {
    return Promise.resolve({ data: { id: 'ws_123' }, error: null });
  }

  then<TResult1 = unknown, TResult2 = never>(
    resolve?: ((value: { data: unknown; count: number | null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve().then(() => {
      let out = this.rows.filter((row) =>
        this.filters.every((cond) => {
          if (cond.kind === 'cmp' && cond.column.startsWith('__not_')) {
            const inner: Condition = {
              kind: 'cmp',
              column: cond.column.slice('__not_'.length),
              op: cond.op,
              value: cond.value,
            };
            return !evalCondition(row, inner);
          }
          return evalCondition(row, cond);
        })
      );
      const count = out.length;
      if (this.orderKey) {
        const key = this.orderKey;
        out = [...out].sort((a, b) => {
          const av = String((a as unknown as Record<string, unknown>)[key] ?? '');
          const bv = String((b as unknown as Record<string, unknown>)[key] ?? '');
          return this.orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (this.rangeFrom !== null && this.rangeTo !== null) {
        out = out.slice(this.rangeFrom, this.rangeTo + 1);
      }
      if (!this.head) {
        this.tracker.returnedRowIds.push(...out.map((r) => r.id));
      }
      const result = { data: this.head ? [] : out, count, error: null };
      return resolve ? resolve(result as never) : (result as never);
    }, reject);
  }
}

export interface MockSupabasePagesClient {
  from: (table: string) => unknown;
  returnedRowIds: string[];
  updates: unknown[];
}

/**
 * Builds a Supabase-shaped client seeded with destination rows, plus
 * the workspaces lookup the tenant resolver needs. `returnedRowIds`
 * records every row id handed out by a non-head (data) query, in
 * order — the pin that the route fetches only the requested page.
 */
export function createMockSupabasePages(
  rows: MockDestinationRow[]
): MockSupabasePagesClient {
  const tracker = { returnedRowIds: [] as string[] };
  const updates: unknown[] = [];
  return {
    returnedRowIds: tracker.returnedRowIds,
    updates,
    from: (table: string) => {
      if (table === 'workspaces') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({ data: { id: 'ws_123' }, error: null }),
              }),
              maybeSingle: () =>
                Promise.resolve({ data: { id: 'ws_123' }, error: null }),
            }),
            maybeSingle: () =>
              Promise.resolve({ data: { id: 'ws_123' }, error: null }),
          }),
        };
      }
      if (table === 'destinations') {
        const query = new MockQuery(rows, tracker);
        return {
          select: (columns: string, options?: { count?: string; head?: boolean }) =>
            query.select(columns, options),
          update: (payload: unknown) => {
            updates.push(payload);
            return {
              eq: () => ({
                then: (resolve: (v: { error: null }) => unknown) =>
                  Promise.resolve({ error: null }).then(resolve),
              }),
            };
          },
        };
      }
      throw new Error(`unexpected mock table: ${table}`);
    },
  };
}
