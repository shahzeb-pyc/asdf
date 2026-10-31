import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken, type DatabaseClient } from '@fbuploadpro/contracts';
import { handleCreateFolder } from '../../src/app/api/tenant/[subdomain]/media/folders/route';
import { handleUpdateFolder } from '../../src/app/api/tenant/[subdomain]/media/folders/[folderId]/route';
import { handleBatchMedia } from '../../src/app/api/tenant/[subdomain]/media/batch/route';
import { MockStorageProvider } from '../helpers/mock-storage';

const TEST_SECRET = 'test-secret-that-is-long-enough-for-hs256-ok';
const GIB = 1073741824;

/**
 * Read-only library: when stored bytes exceed the active period's
 * allowance, non-delete writes are refused with 409
 * MEDIA_STORAGE_READ_ONLY, while DELETE stays allowed as the way back
 * under the limit. The downgrade case (allowed drops below used with
 * no upload happening) is covered by the counts/usage mock alone.
 */
describe('Media Library read-only when over the storage limit', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const folderId = '22222222-2222-4222-a222-222222222222';
  const mediaId = '33333333-3333-4333-a333-333333333333';
  let validSessionCookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
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

  function quotaMock(facebookUnits: number, usedBytes: number, queryImpl: (sql: string) => unknown) {
    return {
      query: vi.fn().mockImplementation((sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM subscription_periods')) {
          return Promise.resolve([
            {
              facebook_count: facebookUnits,
              instagram_count: 0,
              threads_count: 0,
              x_count: 0,
              tiktok_count: 0,
              youtube_count: 0,
            },
          ]);
        }
        if (sql.includes('SUM(file_size)')) {
          return Promise.resolve([{ total: usedBytes }]);
        }
        return queryImpl(sql);
      }),
    } as unknown as DatabaseClient;
  }

  function folderRow() {
    return {
      id: folderId,
      user_id: userId,
      parent_id: null,
      name: 'New Folder',
      created_at: new Date('2026-10-31T00:00:00Z'),
      updated_at: new Date('2026-10-31T00:00:00Z'),
    };
  }

  it('blocks folder creation when over, and creates nothing', async () => {
    let insertAttempted = false;
    const mockDb = quotaMock(5, 26 * GIB, (sql) => {
      if (sql.includes('INSERT INTO media_folders')) {
        insertAttempted = true;
        return Promise.resolve([folderRow()]);
      }
      return Promise.resolve([]);
    });
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/folders', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify({ name: 'New Folder', parentId: null }),
    });
    const res = await handleCreateFolder(req, 'acme', mockDb);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('MEDIA_STORAGE_READ_ONLY');
    expect(insertAttempted).toBe(false);
  });

  it('allows folder creation when under the limit', async () => {
    const mockDb = quotaMock(5, 10 * GIB, (sql) => {
      if (sql.includes('INSERT INTO media_folders')) return Promise.resolve([folderRow()]);
      return Promise.resolve([]);
    });
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/folders', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify({ name: 'New Folder', parentId: null }),
    });
    const res = await handleCreateFolder(req, 'acme', mockDb);
    expect(res.status).toBe(201);
  });

  it('blocks folder rename in the downgrade case (allowed drops below used, no upload)', async () => {
    // Stored 25 GiB, renewed at 4 units (20 GiB): over with no upload.
    const mockDb = quotaMock(4, 25 * GIB, () => Promise.resolve([]));
    const req = new NextRequest(`http://localhost:3000/api/tenant/acme/media/folders/${folderId}`, {
      method: 'PATCH',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    const res = await handleUpdateFolder(req, 'acme', folderId, mockDb);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('MEDIA_STORAGE_READ_ONLY');
  });

  it('blocks batch move when over, but allows batch delete (the escape hatch)', async () => {
    const overDb = quotaMock(5, 26 * GIB, (sql) => {
      if (sql.includes('UPDATE media_items')) return Promise.resolve([{ id: mediaId }]);
      return Promise.resolve([]);
    });
    const moveReq = new NextRequest('http://localhost:3000/api/tenant/acme/media/batch', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify({ action: 'move', mediaIds: [mediaId], folderId }),
    });
    const moveRes = await handleBatchMedia(moveReq, 'acme', overDb);
    expect(moveRes.status).toBe(409);
    expect((await moveRes.json()).error).toBe('MEDIA_STORAGE_READ_ONLY');

    const deleteDb = quotaMock(5, 26 * GIB, (sql) => {
      if (sql.includes('SELECT id, storage_key')) {
        return Promise.resolve([{ id: mediaId, storage_key: 'k1', thumbnail_key: null }]);
      }
      if (sql.includes('DELETE FROM media_items')) return Promise.resolve([{ id: mediaId }]);
      return Promise.resolve([]);
    });
    const mockStorage = new MockStorageProvider();
    const deleteReq = new NextRequest('http://localhost:3000/api/tenant/acme/media/batch', {
      method: 'POST',
      headers: { cookie: validSessionCookie },
      body: JSON.stringify({ action: 'delete', mediaIds: [mediaId] }),
    });
    const deleteRes = await handleBatchMedia(deleteReq, 'acme', deleteDb, mockStorage);
    expect(deleteRes.status).toBe(200);
    const deleteData = await deleteRes.json();
    expect(deleteData.success).toBe(true);
    expect(deleteData.action).toBe('delete');
  });
});
