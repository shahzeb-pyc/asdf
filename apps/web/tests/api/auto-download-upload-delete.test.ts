/**
 * ADU config DELETE tenant isolation: a foreign-workspace config id
 * must 404 and delete NOTHING. Before the fix, DELETE wiped the
 * foreign config's reels (unguarded delete by config_id) while the
 * workspace-filtered config delete no-op'd — one workspace could
 * destroy another workspace's reels.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE } from '../../src/app/api/tenant/[subdomain]/auto-download-upload/[id]/route';

type Row = Record<string, unknown>;

let db: Record<string, Row[]>;
let workspaceId = 'ws_1';

vi.mock('@/lib/server/adu', () => ({
  aduContext: vi.fn(async () => ({
    context: { workspaceId, supabase: fakeSupabase() },
  })),
  loadAduConfigView: vi.fn(),
}));

interface Filter {
  col: string;
  val: unknown;
}

class FakeBuilder {
  filters: Filter[] = [];
  private mode: 'select' | 'delete' = 'select';
  constructor(
    private readonly table: string,
    private readonly store: Record<string, Row[]>
  ) {}

  select() {
    this.mode = 'select';
    return this;
  }

  delete() {
    this.mode = 'delete';
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ col, val });
    return this;
  }

  async maybeSingle() {
    const rows = (this.store[this.table] ?? []).filter((row) =>
      this.filters.every((f) => row[f.col] === f.val)
    );
    return { data: rows[0] ?? null, error: null };
  }

  // Thenable so `await builder` executes a delete and resolves { error }.
  then(resolve: (value: { error: null }) => void) {
    if (this.mode === 'delete') {
      this.store[this.table] = (this.store[this.table] ?? []).filter(
        (row) => !this.filters.every((f) => row[f.col] === f.val)
      );
    }
    resolve({ error: null });
  }
}

function fakeSupabase() {
  return {
    from: (table: string) => new FakeBuilder(table, db),
  };
}

function deleteRequest(id: string) {
  return new NextRequest(
    `http://localhost:3000/api/tenant/acme/auto-download-upload/${id}`,
    { method: 'DELETE' }
  );
}

describe('DELETE /auto-download-upload/[id]', () => {
  beforeEach(() => {
    workspaceId = 'ws_1';
    db = {
      adu_configs: [
        { id: 'cfg_own', workspace_id: 'ws_1' },
        { id: 'cfg_foreign', workspace_id: 'ws_other' },
      ],
      adu_reels: [
        { id: 'r1', config_id: 'cfg_own' },
        { id: 'r2', config_id: 'cfg_foreign' },
        { id: 'r3', config_id: 'cfg_foreign' },
      ],
    };
  });

  it('deletes an own config and only its reels', async () => {
    const res = await DELETE(deleteRequest('cfg_own'), {
      params: Promise.resolve({ subdomain: 'acme', id: 'cfg_own' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(db.adu_configs.map((r) => r.id)).toEqual(['cfg_foreign']);
    expect(db.adu_reels.map((r) => r.id)).toEqual(['r2', 'r3']);
  });

  it('returns 404 and deletes nothing for a foreign-workspace config id', async () => {
    const res = await DELETE(deleteRequest('cfg_foreign'), {
      params: Promise.resolve({ subdomain: 'acme', id: 'cfg_foreign' }),
    });
    expect(res.status).toBe(404);
    expect(db.adu_configs.map((r) => r.id)).toEqual(['cfg_own', 'cfg_foreign']);
    expect(db.adu_reels.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('returns 404 and deletes nothing for a nonexistent config id', async () => {
    const res = await DELETE(deleteRequest('cfg_missing'), {
      params: Promise.resolve({ subdomain: 'acme', id: 'cfg_missing' }),
    });
    expect(res.status).toBe(404);
    expect(db.adu_configs).toHaveLength(2);
    expect(db.adu_reels).toHaveLength(3);
  });
});
