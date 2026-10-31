import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  handleListFolders,
  handleCreateFolder,
} from '../../src/app/api/tenant/[subdomain]/media/folders/route';
import {
  handleUpdateFolder,
  handleDeleteFolder,
} from '../../src/app/api/tenant/[subdomain]/media/folders/[folderId]/route';
import { MockStorageProvider } from '../helpers/mock-storage';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Nested Media Folders CRUD, Reparenting & Cascading Deletion', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const folderId = '22222222-2222-4222-a222-222222222222';
  const childFolderId = '33333333-3333-4333-a333-333333333333';
  let validSessionCookie: string;
  let mockStorage: MockStorageProvider;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    mockStorage = new MockStorageProvider();

    const token = await signSessionToken(
      {
        userId,
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

  describe('List Folders (GET /api/tenant/[subdomain]/media/folders)', () => {
    it('rejects unauthenticated requests with 401 Unauthorized', async () => {
      const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/folders');
      const res = await handleListFolders(req, 'acme');
      expect(res.status).toBe(401);
    });

    it('returns folders with parentId, itemCount, subfolderCount, and unorganizedCount', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM media_folders')) {
            return Promise.resolve([
              {
                id: folderId,
                user_id: userId,
                parent_id: null,
                name: 'Spring Campaigns',
                item_count: 8,
                subfolder_count: 2,
                created_at: new Date('2026-10-07T10:00:00Z'),
                updated_at: new Date('2026-10-07T10:00:00Z'),
              },
              {
                id: childFolderId,
                user_id: userId,
                parent_id: folderId,
                name: 'Week 1 Reels',
                item_count: 4,
                subfolder_count: 0,
                created_at: new Date('2026-10-08T10:00:00Z'),
                updated_at: new Date('2026-10-08T10:00:00Z'),
              },
            ]);
          }
          if (sql.includes('folder_id IS NULL')) {
            return Promise.resolve([{ unorganized_count: 3 }]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/folders', {
        headers: { cookie: validSessionCookie },
      });
      const res = await handleListFolders(req, 'acme', mockDb as DatabaseClient);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.folders).toHaveLength(2);
      expect(data.folders[0].name).toBe('Spring Campaigns');
      expect(data.folders[0].parentId).toBeNull();
      expect(data.folders[0].itemCount).toBe(8);
      expect(data.folders[0].subfolderCount).toBe(2);
      expect(data.folders[1].parentId).toBe(folderId);
      expect(data.unorganizedCount).toBe(3);
    });

    // Helper: a Supabase mock for the folders list handler that records
    // every from()/select() call so tests can count DB requests.
    function createListMock(
      folders: Array<Record<string, unknown>>,
      itemFolderIds: Array<string | null>
    ) {
      const fromCalls: string[] = [];
      const selectCalls: Array<{ table: string; columns: unknown; options?: unknown }> = [];
      const mockSupabase = {
        from: vi.fn((table: string) => {
          fromCalls.push(table);
          if (table === 'media_folders') {
            return {
              select: vi.fn((columns: unknown, options?: unknown) => {
                selectCalls.push({ table, columns, options });
                // Chain mirrors the paged list query:
                // .eq().order(name).order(id).range()
                const page: any = {
                  range: vi.fn().mockResolvedValue({ data: folders, error: null }),
                };
                page.order = vi.fn().mockReturnValue(page);
                return {
                  eq: vi.fn().mockReturnValue(page),
                };
              }),
            };
          }
          if (table === 'media_items') {
            return {
              select: vi.fn((columns: unknown, options?: unknown) => {
                selectCalls.push({ table, columns, options });
                // Chain mirrors the paged tally query:
                // .eq().order(id).range()
                const page: any = {
                  range: vi.fn().mockResolvedValue({
                    data: itemFolderIds.map((folder_id) => ({ folder_id })),
                    error: null,
                  }),
                };
                page.order = vi.fn().mockReturnValue(page);
                return {
                  eq: vi.fn().mockReturnValue(page),
                };
              }),
            };
          }
          return {};
        }),
      };
      return { mockSupabase, fromCalls, selectCalls };
    }

    function makeFolder(id: string, name: string, parent_id: string | null = null) {
      return {
        id,
        user_id: userId,
        parent_id,
        name,
        created_at: new Date('2026-10-07T10:00:00Z'),
        updated_at: new Date('2026-10-07T10:00:00Z'),
      };
    }

    it('counts items with a single grouped media_items query (no per-folder counts)', async () => {
      const folders = [makeFolder(folderId, 'Campaigns')];
      // 12 items in the folder, 5 unorganized
      const itemFolderIds: Array<string | null> = [
        ...Array<string>(12).fill(folderId),
        ...Array<null>(5).fill(null),
      ];
      const { mockSupabase, fromCalls, selectCalls } = createListMock(folders, itemFolderIds);

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/folders', {
        headers: { cookie: validSessionCookie },
      });
      const res = await handleListFolders(req, 'acme', mockSupabase as any);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.folders).toHaveLength(1);
      expect(data.folders[0].itemCount).toBe(12);
      expect(data.unorganizedCount).toBe(5);

      // Exactly two DB requests total: folders list + one grouped items query
      expect(fromCalls).toEqual(['media_folders', 'media_items']);
      const itemSelects = selectCalls.filter((c) => c.table === 'media_items');
      expect(itemSelects).toHaveLength(1);
      expect(itemSelects[0].columns).toBe('folder_id');
      // The old per-folder head-count pattern must not be used
      expect(itemSelects[0].options).not.toEqual({ count: 'exact', head: true });
    });

    it('issues a constant number of DB calls regardless of folder count', async () => {
      for (const folderCount of [0, 1, 5, 25]) {
        const folders = Array.from({ length: folderCount }, (_, i) =>
          makeFolder(`11111111-1111-4111-a111-${String(i).padStart(12, '0')}`, `Folder ${i}`)
        );
        // One item in the first folder (if any), two unorganized
        const itemFolderIds: Array<string | null> =
          folderCount > 0 ? [folders[0].id as string, null, null] : [null, null];
        const { mockSupabase, fromCalls } = createListMock(folders, itemFolderIds);

        const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/folders', {
          headers: { cookie: validSessionCookie },
        });
        const res = await handleListFolders(req, 'acme', mockSupabase as any);

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.folders).toHaveLength(folderCount);
        // Constant: 1 folders query + 1 grouped items query, independent of N
        expect(fromCalls).toHaveLength(2);
        expect(fromCalls.filter((t) => t === 'media_items')).toHaveLength(1);
        if (folderCount > 0) {
          expect(data.folders[0].itemCount).toBe(1);
          expect(data.folders.slice(1).every((f: any) => f.itemCount === 0)).toBe(true);
        }
        expect(data.unorganizedCount).toBe(2);
      }
    });

    it('returns correct counts including zero-count and nested folders', async () => {
      const emptyFolderId = '44444444-4444-4444-a444-444444444444';
      const folders = [
        makeFolder(folderId, 'Parent'),
        makeFolder(childFolderId, 'Child', folderId),
        makeFolder(emptyFolderId, 'Empty'),
      ];
      const itemFolderIds: Array<string | null> = [
        folderId,
        folderId,
        childFolderId,
        childFolderId,
        childFolderId,
        null,
        null,
        null,
        null,
      ];
      const { mockSupabase } = createListMock(folders, itemFolderIds);

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/folders', {
        headers: { cookie: validSessionCookie },
      });
      const res = await handleListFolders(req, 'acme', mockSupabase as any);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.folders).toHaveLength(3);
      const byId = new Map<string, any>(
        data.folders.map((f: any) => [f.id, f] as [string, any])
      );
      expect(byId.get(folderId)?.itemCount).toBe(2);
      expect(byId.get(folderId)?.subfolderCount).toBe(1);
      expect(byId.get(folderId)?.parentId).toBeNull();
      expect(byId.get(childFolderId)?.itemCount).toBe(3);
      expect(byId.get(childFolderId)?.subfolderCount).toBe(0);
      expect(byId.get(childFolderId)?.parentId).toBe(folderId);
      expect(byId.get(emptyFolderId)?.itemCount).toBe(0);
      expect(byId.get(emptyFolderId)?.subfolderCount).toBe(0);
      expect(data.unorganizedCount).toBe(4);
    });
  });

  describe('Create Folder (POST /api/tenant/[subdomain]/media/folders)', () => {
    it('creates new root or nested folder and returns 201 Created', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('SELECT id FROM media_folders')) {
            return Promise.resolve([{ id: folderId }]);
          }
          if (sql.includes('INSERT INTO media_folders')) {
            return Promise.resolve([
              {
                id: childFolderId,
                user_id: userId,
                parent_id: folderId,
                name: 'Subfolder Reels',
                created_at: new Date('2026-10-07T10:00:00Z'),
                updated_at: new Date('2026-10-07T10:00:00Z'),
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/folders', {
        method: 'POST',
        headers: { cookie: validSessionCookie },
        body: JSON.stringify({ name: 'Subfolder Reels', parentId: folderId }),
      });
      const res = await handleCreateFolder(req, 'acme', mockDb as DatabaseClient);

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBe(childFolderId);
      expect(data.parentId).toBe(folderId);
      expect(data.name).toBe('Subfolder Reels');
      expect(data.itemCount).toBe(0);
      expect(data.subfolderCount).toBe(0);
    });

    it('returns 404 PARENT_FOLDER_NOT_FOUND when parentId does not belong to user', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockResolvedValue([]),
      };

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/folders', {
        method: 'POST',
        headers: { cookie: validSessionCookie },
        body: JSON.stringify({ name: 'Orphan Subfolder', parentId: folderId }),
      });
      const res = await handleCreateFolder(req, 'acme', mockDb as DatabaseClient);

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('PARENT_FOLDER_NOT_FOUND');
    });

    it('rejects duplicate sibling folder name with 409 Conflict', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockRejectedValue({ code: '23505' }),
      };

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/folders', {
        method: 'POST',
        headers: { cookie: validSessionCookie },
        body: JSON.stringify({ name: 'Product Launches' }),
      });
      const res = await handleCreateFolder(req, 'acme', mockDb as DatabaseClient);

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe('FOLDER_NAME_ALREADY_EXISTS');
    });
  });

  describe('Update Folder (PATCH /api/tenant/[subdomain]/media/folders/[folderId])', () => {
    it('updates folder name and returns subfolderCount and itemCount', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('SELECT id, user_id, parent_id')) {
            return Promise.resolve([
              {
                id: folderId,
                user_id: userId,
                parent_id: null,
                name: 'Old Name',
                created_at: new Date('2026-10-07T10:00:00Z'),
                updated_at: new Date('2026-10-07T10:00:00Z'),
              },
            ]);
          }
          if (sql.includes('UPDATE media_folders')) {
            return Promise.resolve([
              {
                id: folderId,
                user_id: userId,
                parent_id: null,
                name: 'Renamed Folder',
                created_at: new Date('2026-10-07T10:00:00Z'),
                updated_at: new Date('2026-10-07T11:00:00Z'),
              },
            ]);
          }
          if (sql.includes('COUNT(*)::int AS item_count')) {
            return Promise.resolve([{ item_count: 5 }]);
          }
          if (sql.includes('COUNT(*)::int AS subfolder_count')) {
            return Promise.resolve([{ subfolder_count: 2 }]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/media/folders/${folderId}`, {
        method: 'PATCH',
        headers: { cookie: validSessionCookie },
        body: JSON.stringify({ name: 'Renamed Folder' }),
      });
      const res = await handleUpdateFolder(req, 'acme', folderId, mockDb as DatabaseClient);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.name).toBe('Renamed Folder');
      expect(data.itemCount).toBe(5);
      expect(data.subfolderCount).toBe(2);
    });

    it('rejects moving a folder into itself or one of its descendant subfolders with 400 INVALID_FOLDER_HIERARCHY', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('SELECT id, user_id, parent_id')) {
            return Promise.resolve([{ id: folderId, user_id: userId, parent_id: null, name: 'Parent' }]);
          }
          if (sql.includes('WITH RECURSIVE descendants')) {
            return Promise.resolve([{ id: childFolderId }]);
          }
          if (sql.includes('SELECT id FROM media_folders')) {
            return Promise.resolve([{ id: childFolderId }]);
          }
          return Promise.resolve([]);
        }),
      };

      // Self-parenting check
      const selfReq = new NextRequest(`http://localhost:3000/api/tenant/acme/media/folders/${folderId}`, {
        method: 'PATCH',
        headers: { cookie: validSessionCookie },
        body: JSON.stringify({ parentId: folderId }),
      });
      const selfRes = await handleUpdateFolder(selfReq, 'acme', folderId, mockDb as DatabaseClient);
      expect(selfRes.status).toBe(400);
      expect((await selfRes.json()).error).toBe('INVALID_FOLDER_HIERARCHY');

      // Descendant cycle check
      const cycleReq = new NextRequest(`http://localhost:3000/api/tenant/acme/media/folders/${folderId}`, {
        method: 'PATCH',
        headers: { cookie: validSessionCookie },
        body: JSON.stringify({ parentId: childFolderId }),
      });
      const cycleRes = await handleUpdateFolder(cycleReq, 'acme', folderId, mockDb as DatabaseClient);
      expect(cycleRes.status).toBe(400);
      expect((await cycleRes.json()).error).toBe('INVALID_FOLDER_HIERARCHY');
    });

    it('returns 404 when folder is not found', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockResolvedValue([]),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/media/folders/${folderId}`, {
        method: 'PATCH',
        headers: { cookie: validSessionCookie },
        body: JSON.stringify({ name: 'Nonexistent' }),
      });
      const res = await handleUpdateFolder(req, 'acme', folderId, mockDb as DatabaseClient);

      expect(res.status).toBe(404);
    });
  });

  describe('Delete Folder Destructively with R2 Purge (DELETE /api/tenant/[subdomain]/media/folders/[folderId])', () => {
    it('recursively collects subfolder tree, purges all contained media R2 keys, and deletes DB rows', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('WITH RECURSIVE folder_tree')) {
            return Promise.resolve([{ id: folderId }, { id: childFolderId }]);
          }
          if (sql.includes('SELECT id FROM media_folders WHERE id = $1')) {
            return Promise.resolve([{ id: folderId }]);
          }
          if (sql.includes('SELECT id, storage_key, thumbnail_key')) {
            return Promise.resolve([
              {
                id: 'aaaa1111-1111-4111-a111-111111111111',
                storage_key: 'users/111/media/1.mp4',
                thumbnail_key: 'users/111/thumbnails/1.webp',
              },
              {
                id: 'aaaa2222-2222-4222-a222-222222222222',
                storage_key: 'users/111/media/2.jpg',
                thumbnail_key: null,
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/media/folders/${folderId}`, {
        method: 'DELETE',
        headers: { cookie: validSessionCookie },
      });
      const res = await handleDeleteFolder(
        req,
        'acme',
        folderId,
        mockDb as DatabaseClient,
        mockStorage
      );

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        success: true,
        deletedFolderId: folderId,
        deletedSubfoldersCount: 1,
        deletedItemsCount: 2,
      });
      expect(mockStorage.deletedKeys.has('users/111/media/1.mp4')).toBe(true);
      expect(mockStorage.deletedKeys.has('users/111/thumbnails/1.webp')).toBe(true);
      expect(mockStorage.deletedKeys.has('users/111/media/2.jpg')).toBe(true);
    });

    it('returns 404 if folder to delete does not exist', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockResolvedValue([]),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/media/folders/${folderId}`, {
        method: 'DELETE',
        headers: { cookie: validSessionCookie },
      });
      const res = await handleDeleteFolder(
        req,
        'acme',
        folderId,
        mockDb as DatabaseClient,
        mockStorage
      );

      expect(res.status).toBe(404);
    });
  });
});

/**
 * Supabase-path paging (P1-14, P1-18): PostgREST silently caps an
 * unpaged select at 1,000 rows. This mock mirrors that cap — an
 * unpaged select returns at most 1,000 rows — while .range() pages
 * return the exact window, so tests past 1,000 rows fail against
 * the old unpaged fetches and pass against the paged ones.
 */
type MockRow = Record<string, unknown>;

function createCappedSupabaseMock(
  tables: Record<string, MockRow[]>,
  opts?: { failMediaItemsRangeAt?: number }
) {
  // Counts media_items .range() calls so a test can fail one page.
  let mediaItemsRangeCalls = 0;
  function applyFilters(
    rows: MockRow[],
    eqs: [string, unknown][],
    ins: [string, unknown[]][],
    orders: [string, boolean][],
  ): MockRow[] {
    let out = [...rows];
    for (const [col, val] of eqs) out = out.filter((r) => r[col] === val);
    for (const [col, vals] of ins) out = out.filter((r) => vals.includes(r[col]));
    for (const [col, asc] of orders) {
      out = [...out].sort((a, b) => {
        const cmp = String(a[col] ?? '').localeCompare(String(b[col] ?? ''));
        return asc ? cmp : -cmp;
      });
    }
    return out;
  }

  function builder(table: string) {
    const eqs: [string, unknown][] = [];
    const ins: [string, unknown[]][] = [];
    const orders: [string, boolean][] = [];
    let range: [number, number] | null = null;
    let limit: number | null = null;
    let isDelete = false;
    const chain: any = {
      select: () => chain,
      eq: ((col: string, val: unknown) => {
        eqs.push([col, val]);
        return chain;
      }) as (...args: never[]) => unknown,
      in: ((col: string, vals: unknown[]) => {
        ins.push([col, vals]);
        return chain;
      }) as (...args: never[]) => unknown,
      order: ((col: string, opts: { ascending: boolean }) => {
        orders.push([col, opts.ascending]);
        return chain;
      }) as (...args: never[]) => unknown,
      limit: ((n: number) => {
        limit = n;
        return chain;
      }) as (...args: never[]) => unknown,
      range: (from: number, to: number) => {
        range = [from, to];
        if (
          table === 'media_items' &&
          opts?.failMediaItemsRangeAt !== undefined &&
          ++mediaItemsRangeCalls === opts.failMediaItemsRangeAt
        ) {
          return Promise.resolve({ data: null, error: { message: 'boom' } });
        }
        const rows = applyFilters(tables[table] ?? [], eqs, ins, orders);
        return Promise.resolve({
          data: rows.slice(from, to + 1),
          error: null,
        });
      },
      maybeSingle: () => {
        const rows = applyFilters(tables[table] ?? [], eqs, ins, orders);
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      delete: () => {
        isDelete = true;
        return chain;
      },
      then: (resolve: (v: unknown) => void) => {
        const rows = applyFilters(tables[table] ?? [], eqs, ins, orders);
        if (isDelete) {
          const doomed = new Set(rows);
          tables[table] = (tables[table] ?? []).filter((r) => !doomed.has(r));
          resolve({ data: null, error: null });
          return;
        }
        const page =
          range !== null
            ? rows.slice(range[0], range[1] + 1)
            : rows.slice(0, limit ?? 1000);
        resolve({ data: page, error: null });
      },
    };
    return chain;
  }

  return { from: (table: string) => builder(table) };
}

describe('Supabase-path folder paging past the 1,000-row cap', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const folderId = '22222222-2222-4222-a222-222222222222';
  const childFolderId = '33333333-3333-4333-a333-333333333333';
  let validSessionCookie: string;
  let mockStorage: MockStorageProvider;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    mockStorage = new MockStorageProvider();
    const token = await signSessionToken(
      {
        userId,
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

  function folderRow(id: string, parentId: string | null, name: string): MockRow {
    return {
      id,
      user_id: userId,
      parent_id: parentId,
      name,
      created_at: '2026-10-07T10:00:00.000Z',
      updated_at: '2026-10-07T10:00:00.000Z',
    };
  }

  it('counts folder items in full past 1,000 items', async () => {
    const items: MockRow[] = Array.from({ length: 1050 }, (_, i) => ({
      id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
      user_id: userId,
      folder_id: folderId,
    }));
    const supabase = createCappedSupabaseMock({
      media_folders: [folderRow(folderId, null, 'Big')],
      media_items: items,
    });
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/folders', {
      headers: { cookie: validSessionCookie },
    });
    const res = await handleListFolders(req, 'acme', supabase as never);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.folders).toHaveLength(1);
    expect(data.folders[0].itemCount).toBe(1050);
    expect(data.unorganizedCount).toBe(0);
  });

  it('lists folders in full past 1,000 folders', async () => {
    const folders: MockRow[] = Array.from({ length: 1002 }, (_, i) =>
      folderRow(`bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`, null, `Folder ${i}`),
    );
    const supabase = createCappedSupabaseMock({
      media_folders: folders,
      media_items: [],
    });
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/folders', {
      headers: { cookie: validSessionCookie },
    });
    const res = await handleListFolders(req, 'acme', supabase as never);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.folders).toHaveLength(1002);
  });

  it('purges R2 keys for every item in a subtree past 1,000 items', async () => {
    const items: MockRow[] = Array.from({ length: 1050 }, (_, i) => ({
      id: `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`,
      user_id: userId,
      folder_id: i % 2 === 0 ? folderId : childFolderId,
      storage_key: `users/${userId}/media/${i}.jpg`,
      thumbnail_key: i % 3 === 0 ? `users/${userId}/thumbs/${i}.webp` : null,
    }));
    const supabase = createCappedSupabaseMock({
      media_folders: [
        folderRow(folderId, null, 'Root'),
        folderRow(childFolderId, folderId, 'Child'),
      ],
      media_items: items,
    });
    const req = new NextRequest(`http://localhost:3000/api/tenant/acme/media/folders/${folderId}`, {
      method: 'DELETE',
      headers: { cookie: validSessionCookie },
    });
    const res = await handleDeleteFolder(req, 'acme', folderId, supabase as never, mockStorage);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.deletedItemsCount).toBe(1050);
    expect(data.deletedSubfoldersCount).toBe(1);
    for (let i = 0; i < 1050; i++) {
      expect(mockStorage.deletedKeys.has(`users/${userId}/media/${i}.jpg`)).toBe(true);
      if (i % 3 === 0) {
        expect(mockStorage.deletedKeys.has(`users/${userId}/thumbs/${i}.webp`)).toBe(true);
      }
    }
  });

  it('fails loud on a media page fetch error: no success, no DB delete, no storage purge', async () => {
    // A failed page must never be treated as end-of-data: the old
    // code returned 200 and deleted the chunk's DB rows plus the
    // folder rows, orphaning the items' R2 objects.
    const tables: Record<string, MockRow[]> = {
      media_folders: [folderRow(folderId, null, 'Root')],
      media_items: [0, 1, 2].map((i) => ({
        id: `dddddddd-0000-4000-8000-${String(i).padStart(12, '0')}`,
        user_id: userId,
        folder_id: folderId,
        storage_key: `users/${userId}/media/${i}.jpg`,
        thumbnail_key: null,
      })),
    };
    const supabase = createCappedSupabaseMock(tables, { failMediaItemsRangeAt: 1 });
    const req = new NextRequest(`http://localhost:3000/api/tenant/acme/media/folders/${folderId}`, {
      method: 'DELETE',
      headers: { cookie: validSessionCookie },
    });
    const res = await handleDeleteFolder(req, 'acme', folderId, supabase as never, mockStorage);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.success).not.toBe(true);
    // Nothing deleted: rows are retained so a retry can complete
    // the delete (R2 deletes are idempotent).
    expect(tables.media_items).toHaveLength(3);
    expect(tables.media_folders).toHaveLength(1);
    expect(mockStorage.deletedKeys.size).toBe(0);
  });
});
