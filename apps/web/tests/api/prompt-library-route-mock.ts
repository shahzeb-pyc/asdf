/**
 * @file prompt-library-route-mock.ts
 * @description Shared in-memory Supabase-style mock for the prompt
 * library route tests. The builder is chainable and applies .eq(),
 * .in() and .or() filters, .order() and .range(), and resolves
 * when awaited directly (the favourites queries await the builder
 * itself). Tables are plain arrays, so insert/update/delete/upsert
 * actually mutate state and later queries see the effect. Per-test
 * failures are injected via `store.fail` keyed by
 * "<table>:<terminal>" where terminal is one of range, maybeSingle,
 * single, then, insert, update, delete, upsert, rpc. Every call is
 * recorded in `store.calls` for assertions such as "the copy route
 * never writes copied_count directly".
 */

import { signSessionToken } from "@fbuploadpro/contracts";

export const TEST_SECRET = "test-session-secret-for-prompt-library-tests-000000";
export const USER_ID = "11111111-1111-4111-a111-111111111111";
export const ADMIN_ID = "22222222-2222-4222-a222-222222222222";
export const SUBDOMAIN = "acme";

export type Row = Record<string, unknown>;

export type Store = {
  prompts: Row[];
  media: Row[];
  steps: Row[];
  favourites: Row[];
  rpcCount: number;
  fail: Record<string, Error>;
  calls: { op: string; table: string; payload?: unknown }[];
};

export function promptRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    slug: `prompt-${id.slice(-2)}`,
    title: `Prompt ${id.slice(-2)}`,
    short_description: `Description ${id.slice(-2)}.`,
    master_prompt: `Master prompt ${id.slice(-2)}.`,
    tool: "dola_ai",
    category: "animals",
    language: "en",
    video_length_bucket: "1min_plus",
    video_duration_seconds: null,
    format: "vertical_reel",
    aspect_ratio: "9:16",
    copied_count: 0,
    status: "published",
    created_by: null,
    created_at: "2026-10-28T00:00:00.000Z",
    updated_at: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

export function mediaRow(promptId: string, overrides: Row = {}): Row {
  return {
    id: `00000000-0000-4000-8000-00000000${String(
      Math.floor(Math.random() * 90) + 10,
    )}`,
    prompt_id: promptId,
    position: 1,
    media_type: "video",
    storage_key: `prompts/${promptId}/preview.mp4`,
    poster_key: `prompts/${promptId}/poster.jpg`,
    duration_seconds: 30,
    is_main: true,
    created_at: "2026-10-28T00:00:00.000Z",
    ...overrides,
  };
}

export function stepRow(promptId: string, overrides: Row = {}): Row {
  return {
    id: `00000000-0000-4000-8000-00000000${String(
      Math.floor(Math.random() * 90) + 10,
    )}`,
    prompt_id: promptId,
    position: 1,
    title: null,
    body: "Open your video tool.",
    ...overrides,
  };
}

export function newStore(overrides: Partial<Store> = {}): Store {
  return {
    prompts: [],
    media: [],
    steps: [],
    favourites: [],
    rpcCount: 13,
    fail: {},
    calls: [],
    ...overrides,
  };
}

function unescapeIlike(term: string): string {
  return term.replace(/\\(.)/g, "$1");
}

/**
 * Failures are one-shot: consuming the entry models a transient
 * failure, and lets the routes' restore-after-failure paths
 * (PATCH media/steps replacement) actually restore instead of
 * tripping over the same injected failure a second time.
 */
function consumeFail(store: Store, key: string): Error | null {
  const error: Error | undefined = store.fail[key];
  if (error) delete store.fail[key];
  return error ?? null;
}

function applyFilters(store: Store, table: string, builder: QueryBuilder): Row[] {
  const source =
    table === "prompt_library_prompts"
      ? store.prompts
      : table === "prompt_library_media"
        ? store.media
        : table === "prompt_library_how_to_steps"
          ? store.steps
          : table === "prompt_library_favourites"
            ? store.favourites
            : [];
  let rows = [...source];
  for (const [column, value] of builder.eqs) {
    rows = rows.filter((row) => row[column] === value);
  }
  for (const [column, values] of builder.ins) {
    rows = rows.filter((row) => (values as unknown[]).includes(row[column]));
  }
  if (builder.orPattern) {
    const firstSegment = builder.orPattern.split(",")[0];
    const match = firstSegment.match(/ilike\.%(.+)%$/);
    const term = match ? unescapeIlike(match[1]) : "";
    const needle = term.toLowerCase();
    rows = rows.filter((row) =>
      String(row.title ?? "").toLowerCase().includes(needle) ||
      String(row.short_description ?? "").toLowerCase().includes(needle),
    );
  }
  if (builder.orderColumn) {
    const column = builder.orderColumn;
    const ascending = builder.orderAscending;
    rows = [...rows].sort((a, b) => {
      const av = a[column];
      const bv = b[column];
      if (typeof av === "number" && typeof bv === "number") {
        return ascending ? av - bv : bv - av;
      }
      const cmp = String(av ?? "").localeCompare(String(bv ?? ""));
      return ascending ? cmp : -cmp;
    });
  }
  return rows;
}

class QueryBuilder {
  eqs: [string, unknown][] = [];
  ins: [string, unknown[]][] = [];
  orPattern: string | null = null;
  orderColumn: string | null = null;
  orderAscending = true;

  constructor(
    private store: Store,
    private table: string,
  ) {}

  select(): this {
    this.store.calls.push({ op: "select", table: this.table });
    return this;
  }

  eq(column: string, value: unknown): this {
    this.eqs.push([column, value]);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.ins.push([column, values]);
    return this;
  }

  or(pattern: string): this {
    this.orPattern = pattern;
    return this;
  }

  order(column: string, opts: { ascending: boolean }): this {
    this.orderColumn = column;
    this.orderAscending = opts.ascending;
    return this;
  }

  range(from: number, to: number): Promise<{
    data: Row[] | null;
    count: number | null;
    error: Error | null;
  }> {
    const error = consumeFail(this.store, `${this.table}:range`);
    if (error) return Promise.resolve({ data: null, count: null, error });
    const rows = applyFilters(this.store, this.table, this);
    return Promise.resolve({
      data: rows.slice(from, to + 1),
      count: rows.length,
      error: null,
    });
  }

  maybeSingle(): Promise<{ data: Row | null; error: Error | null }> {
    const error = consumeFail(this.store, `${this.table}:maybeSingle`);
    if (error) return Promise.resolve({ data: null, error });
    const rows = applyFilters(this.store, this.table, this);
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  single(): Promise<{ data: Row | null; error: Error | null }> {
    const error = consumeFail(this.store, `${this.table}:single`);
    if (error) return Promise.resolve({ data: null, error });
    const rows = applyFilters(this.store, this.table, this);
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }

  // Thenable: queries awaited directly (favourites list/flag, media
  // and steps loads via .order()) resolve to the filtered rows.
  then(
    resolve: (value: { data: Row[]; count: number; error: Error | null }) => void,
    reject: (reason: unknown) => void,
  ): void {
    const error = consumeFail(this.store, `${this.table}:then`);
    if (error) {
      Promise.resolve({ data: [], count: 0, error }).then(resolve, reject);
      return;
    }
    const rows = applyFilters(this.store, this.table, this);
    Promise.resolve({ data: rows, count: rows.length, error: null }).then(
      resolve,
      reject,
    );
  }
}

class InsertBuilder {
  private inserted: Row[];
  private committed = false;

  constructor(
    private store: Store,
    private table: string,
    rows: Row | Row[],
  ) {
    const list = Array.isArray(rows) ? rows : [rows];
    this.inserted = list.map((row, index) => {
      const copy = { ...row };
      if (this.table === "prompt_library_prompts" && !copy.id) {
        copy.id = `99999999-9999-4999-8999-99999999999${index}`;
      }
      return copy;
    });
  }

  // Rows land in the store only when the insert resolves without
  // error — a failed insert must not leave phantom rows behind
  // (that is what makes the routes' rollback/restore paths
  // observable in tests).
  private commit(): void {
    if (this.committed) return;
    this.committed = true;
    const target =
      this.table === "prompt_library_prompts"
        ? this.store.prompts
        : this.table === "prompt_library_media"
          ? this.store.media
          : this.table === "prompt_library_how_to_steps"
            ? this.store.steps
            : this.table === "prompt_library_favourites"
              ? this.store.favourites
              : null;
    if (target) target.push(...this.inserted);
  }

  select(): { single: () => Promise<{ data: Row | null; error: Error | null }> } {
    return {
      single: async () => {
        const error = consumeFail(this.store, `${this.table}:single`);
        if (error) return { data: null, error };
        this.commit();
        return { data: this.inserted[0] ?? null, error: null };
      },
    };
  }

  then(
    resolve: (value: { data: Row[] | null; error: Error | null }) => void,
    reject: (reason: unknown) => void,
  ): void {
    const error = consumeFail(this.store, `${this.table}:insert`);
    if (!error) this.commit();
    Promise.resolve({ data: null, error }).then(resolve, reject);
  }
}

class DeleteBuilder {
  private eqs: [string, unknown][] = [];

  constructor(
    private store: Store,
    private table: string,
  ) {}

  eq(column: string, value: unknown): this {
    this.eqs.push([column, value]);
    return this;
  }

  then(
    resolve: (value: { error: Error | null }) => void,
    reject: (reason: unknown) => void,
  ): void {
    const error = consumeFail(this.store, `${this.table}:delete`);
    if (!error) {
      const target =
        this.table === "prompt_library_prompts"
          ? this.store.prompts
          : this.table === "prompt_library_media"
            ? this.store.media
            : this.table === "prompt_library_how_to_steps"
              ? this.store.steps
              : this.table === "prompt_library_favourites"
                ? this.store.favourites
                : null;
      if (target) {
        const kept = target.filter(
          (row) => !this.eqs.every(([column, value]) => row[column] === value),
        );
        target.splice(0, target.length, ...kept);
      }
    }
    Promise.resolve({ error }).then(resolve, reject);
  }
}

class UpdateBuilder {
  private eqs: [string, unknown][] = [];

  constructor(
    private store: Store,
    private table: string,
    private patch: Row,
  ) {}

  eq(column: string, value: unknown): this {
    this.eqs.push([column, value]);
    return this;
  }

  then(
    resolve: (value: { error: Error | null }) => void,
    reject: (reason: unknown) => void,
  ): void {
    const error = consumeFail(this.store, `${this.table}:update`);
    if (!error) {
      const target =
        this.table === "prompt_library_prompts" ? this.store.prompts : null;
      if (target) {
        for (const row of target) {
          if (this.eqs.every(([column, value]) => row[column] === value)) {
            Object.assign(row, this.patch);
          }
        }
      }
    }
    Promise.resolve({ error }).then(resolve, reject);
  }
}

class UpsertBuilder {
  constructor(
    private store: Store,
    private table: string,
    private row: Row,
  ) {}

  then(
    resolve: (value: { error: Error | null }) => void,
    reject: (reason: unknown) => void,
  ): void {
    const error = consumeFail(this.store, `${this.table}:upsert`);
    if (!error && this.table === "prompt_library_favourites") {
      const exists = this.store.favourites.some(
        (fav) =>
          fav.user_id === this.row.user_id &&
          fav.prompt_id === this.row.prompt_id,
      );
      if (!exists) this.store.favourites.push({ ...this.row });
    }
    Promise.resolve({ error }).then(resolve, reject);
  }
}

export function makeClient(store: Store) {
  const tableGateway = (table: string) => ({
    select: () => {
      store.calls.push({ op: "select", table });
      return new QueryBuilder(store, table);
    },
    insert: (rows: Row | Row[]) => {
      store.calls.push({ op: "insert", table, payload: rows });
      return new InsertBuilder(store, table, rows);
    },
    update: (patch: Row) => {
      store.calls.push({ op: "update", table, payload: patch });
      return new UpdateBuilder(store, table, patch);
    },
    delete: () => {
      store.calls.push({ op: "delete", table });
      return new DeleteBuilder(store, table);
    },
    upsert: (row: Row, opts?: unknown) => {
      store.calls.push({ op: "upsert", table, payload: row });
      void opts;
      return new UpsertBuilder(store, table, row);
    },
  });
  return {
    from: (table: string) => tableGateway(table),
    rpc: async (name: string, args: unknown) => {
      store.calls.push({ op: "rpc", table: name, payload: args });
      const error = consumeFail(store, `rpc:${name}`);
      if (error) return { data: null, error };
      return { data: store.rpcCount, error: null };
    },
    _store: store,
  };
}

export async function sessionCookieFor(
  role: "user" | "admin" | "seller",
  userId = USER_ID,
): Promise<string> {
  const token = await signSessionToken(
    {
      userId,
      email: "testuser@gmail.com",
      name: "Test User",
      subdomain: SUBDOMAIN,
      role,
      status: "active",
    },
    TEST_SECRET,
  );
  return `fbup_session=${token}`;
}

export function basePromptStore(): Store {
  const p1 = promptRow("00000000-0000-4000-8000-000000000001", {
    slug: "puppy-first-bath",
    title: "Puppy first bath",
    copied_count: 12,
    created_at: "2026-10-28T00:00:00.000Z",
  });
  const p2 = promptRow("00000000-0000-4000-8000-000000000002", {
    slug: "rainy-neon-street",
    title: "Rainy neon street",
    category: "cinematic",
    tool: "veo3",
    language: "ur",
    video_length_bucket: "15_30s",
    format: "horizontal_video",
    aspect_ratio: "16:9",
    copied_count: 3,
    created_at: "2026-10-27T00:00:00.000Z",
  });
  const draft = promptRow("00000000-0000-4000-8000-000000000003", {
    slug: "draft-prompt",
    title: "Draft prompt",
    status: "draft",
    created_at: "2026-10-29T00:00:00.000Z",
  });
  return newStore({
    prompts: [p1, p2, draft],
    media: [
      mediaRow(p1.id as string, { id: "00000000-0000-4000-8000-000000000101" }),
      mediaRow(p2.id as string, {
        id: "00000000-0000-4000-8000-000000000102",
        media_type: "image",
        storage_key: `prompts/${p2.id}/shot.jpg`,
        poster_key: null,
        duration_seconds: null,
      }),
      mediaRow(draft.id as string, {
        id: "00000000-0000-4000-8000-000000000103",
      }),
    ],
    steps: [
      { ...stepRow(p1.id as string), id: "00000000-0000-4000-8000-000000000201" },
      { ...stepRow(p2.id as string), id: "00000000-0000-4000-8000-000000000202" },
    ],
    favourites: [{ user_id: USER_ID, prompt_id: p1.id }],
  });
}
