import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { handleListMedia, sanitizePostgrestSearchPattern } from '../../src/app/api/tenant/[subdomain]/media/route';
import { handleCheckDuplicates } from '../../src/app/api/tenant/[subdomain]/media/check-duplicates/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Media Items Listing & Filtering (GET /api/tenant/[subdomain]/media)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const folderId = '22222222-2222-4222-a222-222222222222';
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

  it('rejects unauthenticated requests with 401 Unauthorized', async () => {
    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media');
    const res = await handleListMedia(req, 'acme');

    expect(res.status).toBe(401);
  });

  it('rejects cross-tenant requests with 403 Forbidden', async () => {
    const req = new NextRequest('http://localhost:3000/api/tenant/other-tenant/media', {
      headers: { cookie: validSessionCookie },
    });
    const res = await handleListMedia(req, 'other-tenant');

    expect(res.status).toBe(403);
  });

  it('lists media items with default pagination', async () => {
    const mockDb: Partial<DatabaseClient> = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT COUNT(*)')) {
          return Promise.resolve([{ total: 1 }]);
        }
        return Promise.resolve([
          {
            id: '33333333-3333-4333-a333-333333333333',
            user_id: userId,
            folder_id: null,
            name: 'reel1.mp4',
            file_size: '10485760',
            mime_type: 'video/mp4',
            media_type: 'video',
            storage_key: `users/${userId}/media/33333333-3333-4333-a333-333333333333/reel1.mp4`,
            url: `https://media.fbuploadpro.com/users/${userId}/media/33333333-3333-4333-a333-333333333333/reel1.mp4`,
            thumbnail_key: `users/${userId}/thumbnails/33333333-3333-4333-a333-333333333333.webp`,
            thumbnail_url: `https://media.fbuploadpro.com/users/${userId}/thumbnails/33333333-3333-4333-a333-333333333333.webp`,
            duration_seconds: '30.00',
            aspect_ratio: '9:16',
            caption_text: 'Promo copy',
            created_at: new Date('2026-10-07T12:00:00Z'),
            updated_at: new Date('2026-10-07T12:00:00Z'),
          },
        ]);
      }),
    };

    const req = new NextRequest('http://localhost:3000/api/tenant/acme/media', {
      headers: { cookie: validSessionCookie },
    });
    const res = await handleListMedia(req, 'acme', mockDb as DatabaseClient);

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.total).toBe(1);
    expect(data.limit).toBe(50);
    expect(data.offset).toBe(0);
    expect(data.items).toHaveLength(1);
    expect(data.items[0].name).toBe('reel1.mp4');
    expect(data.items[0].captionText).toBe('Promo copy');
  });

  it('filters media items by folderId, mediaType, and search', async () => {
    let capturedSql = '';
    let capturedParams: any[] = [];

    const mockDb: Partial<DatabaseClient> = {
      query: vi.fn().mockImplementation((sql: string, params: any[]) => {
        capturedSql = sql;
        capturedParams = params;
        if (sql.includes('SELECT COUNT(*)')) {
          return Promise.resolve([{ total: 0 }]);
        }
        return Promise.resolve([]);
      }),
    };

    const req = new NextRequest(
      `http://localhost:3000/api/tenant/acme/media?folderId=${folderId}&mediaType=video&search=spring`,
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleListMedia(req, 'acme', mockDb as DatabaseClient);

    expect(res.status).toBe(200);
    expect(capturedSql).toContain('folder_id =');
    expect(capturedSql).toContain('media_type =');
    expect(capturedSql).toContain('ILIKE');
    expect(capturedParams).toContain(folderId);
    expect(capturedParams).toContain('video');
  });

  it('filters unorganized items when folderId=unorganized', async () => {
    let capturedSql = '';

    const mockDb: Partial<DatabaseClient> = {
      query: vi.fn().mockImplementation((sql: string) => {
        capturedSql = sql;
        if (sql.includes('SELECT COUNT(*)')) {
          return Promise.resolve([{ total: 0 }]);
        }
        return Promise.resolve([]);
      }),
    };

    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/media?folderId=unorganized',
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleListMedia(req, 'acme', mockDb as DatabaseClient);

    expect(res.status).toBe(200);
    expect(capturedSql).toContain('folder_id IS NULL');
  });

  it('applies sortBy and sortOrder allowlist to ORDER BY', async () => {
    let capturedSql = '';

    const mockDb: Partial<DatabaseClient> = {
      query: vi.fn().mockImplementation((sql: string) => {
        capturedSql = sql;
        if (sql.includes('SELECT COUNT(*)')) {
          return Promise.resolve([{ total: 0 }]);
        }
        return Promise.resolve([]);
      }),
    };

    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/media?sortBy=name&sortOrder=asc',
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleListMedia(req, 'acme', mockDb as DatabaseClient);

    expect(res.status).toBe(200);
    expect(capturedSql).toContain('ORDER BY LOWER(name) ASC');
  });

  it('filters media items by aspectRatio and captionStatus (has_caption / empty_caption)', async () => {
    let capturedSql = '';
    let capturedParams: any[] = [];

    const mockDb: Partial<DatabaseClient> = {
      query: vi.fn().mockImplementation((sql: string, params: any[]) => {
        capturedSql = sql;
        capturedParams = params;
        if (sql.includes('SELECT COUNT(*)')) {
          return Promise.resolve([{ total: 0 }]);
        }
        return Promise.resolve([]);
      }),
    };

    const reqHasCaption = new NextRequest(
      'http://localhost:3000/api/tenant/acme/media?aspectRatio=9:16&captionStatus=has_caption',
      { headers: { cookie: validSessionCookie } }
    );
    const resHasCaption = await handleListMedia(
      reqHasCaption,
      'acme',
      mockDb as DatabaseClient
    );

    expect(resHasCaption.status).toBe(200);
    expect(capturedSql).toContain('aspect_ratio =');
    expect(capturedSql).toContain("caption_text IS NOT NULL AND BTRIM(caption_text) <> ''");
    expect(capturedParams).toContain('9:16');

    const reqEmptyCaption = new NextRequest(
      'http://localhost:3000/api/tenant/acme/media?captionStatus=empty_caption',
      { headers: { cookie: validSessionCookie } }
    );
    const resEmptyCaption = await handleListMedia(
      reqEmptyCaption,
      'acme',
      mockDb as DatabaseClient
    );

    expect(resEmptyCaption.status).toBe(200);
    expect(capturedSql).toContain("(caption_text IS NULL OR BTRIM(caption_text) = '')");
  });

  describe('PostgREST Search Input Sanitization (Issue 11)', () => {
    it('escapes PostgREST delimiters (\\, ", %, _) and wraps search pattern in quotes', () => {
      // Normal term with commas and parentheses
      expect(sanitizePostgrestSearchPattern('reel, test (1).mp4')).toBe(
        '"%reel, test (1).mp4%"'
      );

      // Backslash and quotes
      expect(sanitizePostgrestSearchPattern('test "quote" \\ slash')).toBe(
        '"%test \\"quote\\" \\\\ slash%"'
      );

      // Wildcards % and _
      expect(sanitizePostgrestSearchPattern('100%_done')).toBe(
        '"%100\\%\\_done%"'
      );
    });

    it('verifies searching for terms with commas and parentheses succeeds against Supabase PostgREST', async () => {
      let capturedOrFilter = '';
      const mockQueryBuilder: any = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        or: vi.fn().mockImplementation((filter: string) => {
          capturedOrFilter = filter;
          return mockQueryBuilder;
        }),
        order: vi.fn().mockReturnThis(),
        range: vi.fn().mockResolvedValue({
          data: [
            {
              id: '44444444-4444-4444-a444-444444444444',
              user_id: userId,
              folder_id: null,
              name: 'reel, test (1).mp4',
              file_size: '5242880',
              mime_type: 'video/mp4',
              media_type: 'video',
              storage_key: `users/${userId}/media/44444444/reel.mp4`,
              url: 'https://example.com/reel.mp4',
              thumbnail_key: null,
              thumbnail_url: null,
              duration_seconds: '15.0',
              aspect_ratio: '9:16',
              caption_text: 'Test caption',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          count: 1,
          error: null,
        }),
      };

      const mockSupabase = {
        from: vi.fn().mockReturnValue(mockQueryBuilder),
      };

      const searchTerm = 'reel, test (1).mp4';
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/media?search=${encodeURIComponent(searchTerm)}`,
        { headers: { cookie: validSessionCookie } }
      );

      const res = await handleListMedia(req, 'acme', mockSupabase as any);
      expect(res.status).toBe(200);

      const data = await res.json();
      expect(data.total).toBe(1);
      expect(data.items[0].name).toBe('reel, test (1).mp4');

      // Verify PostgREST .or() filter safely quoted the search pattern
      expect(capturedOrFilter).toBe(
        'name.ilike."%reel, test (1).mp4%",caption_text.ilike."%reel, test (1).mp4%"'
      );
    });
  });

  describe('PostFormat Filtering & Keyset Cursor Pagination', () => {
    it('filters media items by postFormat (reel, image, story, video)', async () => {
      let capturedSql = '';

      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          capturedSql = sql;
          if (sql.includes('SELECT COUNT(*)')) {
            return Promise.resolve([{ total: 0 }]);
          }
          return Promise.resolve([]);
        }),
      };

      // Reel
      const reqReel = new NextRequest('http://localhost:3000/api/tenant/acme/media?postFormat=reel', {
        headers: { cookie: validSessionCookie },
      });
      await handleListMedia(reqReel, 'acme', mockDb as DatabaseClient);
      expect(capturedSql).toContain("media_type = 'video' AND (duration_seconds IS NULL OR duration_seconds <= 90)");

      // Image
      const reqImage = new NextRequest('http://localhost:3000/api/tenant/acme/media?postFormat=image', {
        headers: { cookie: validSessionCookie },
      });
      await handleListMedia(reqImage, 'acme', mockDb as DatabaseClient);
      expect(capturedSql).toContain("media_type = 'image'");

      // Story
      const reqStory = new NextRequest('http://localhost:3000/api/tenant/acme/media?postFormat=story', {
        headers: { cookie: validSessionCookie },
      });
      await handleListMedia(reqStory, 'acme', mockDb as DatabaseClient);
      expect(capturedSql).toContain(
        "((media_type = 'image' AND file_size <= 10485760) OR (media_type = 'video' AND (duration_seconds IS NULL OR duration_seconds <= 60)))"
      );

      // Video
      const reqVideo = new NextRequest('http://localhost:3000/api/tenant/acme/media?postFormat=video', {
        headers: { cookie: validSessionCookie },
      });
      await handleListMedia(reqVideo, 'acme', mockDb as DatabaseClient);
      expect(capturedSql).toContain("media_type = 'video'");
    });

    it('applies keyset cursor pagination condition and returns nextCursor', async () => {
      let capturedSql = '';
      const cursorVal = '2026-10-15T00:00:00.000Z|33333333-3333-4333-a333-333333333333';

      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((sql: string) => {
          capturedSql = sql;
          if (sql.includes('SELECT COUNT(*)')) {
            return Promise.resolve([{ total: 1 }]);
          }
          return Promise.resolve([
            {
              id: '44444444-4444-4444-a444-444444444444',
              user_id: userId,
              folder_id: null,
              name: 'next_item.mp4',
              file_size: '5242880',
              mime_type: 'video/mp4',
              media_type: 'video',
              storage_key: `users/${userId}/media/44444444/next_item.mp4`,
              url: 'https://example.com/next_item.mp4',
              thumbnail_key: null,
              thumbnail_url: null,
              duration_seconds: '15.0',
              aspect_ratio: '9:16',
              caption_text: 'Next caption',
              width: 1080,
              height: 1920,
              created_at: '2026-10-14T23:50:00.000Z',
              updated_at: '2026-10-14T23:50:00.000Z',
            },
          ]);
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/media?cursor=${encodeURIComponent(cursorVal)}&limit=1`,
        { headers: { cookie: validSessionCookie } }
      );
      const res = await handleListMedia(req, 'acme', mockDb as DatabaseClient);
      expect(res.status).toBe(200);
      expect(capturedSql).toContain('created_at < $');

      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.nextCursor).toBe('2026-10-14T23:50:00.000Z|44444444-4444-4444-a444-444444444444');
    });

    it('applies the (created_at, id) keyset tie-break on the Supabase cursor path', async () => {
      // Same-timestamp rows: the old Supabase branch filtered only
      // on created_at, so a page boundary inside one timestamp
      // skipped or repeated rows. The fix ports the legacy branch's
      // (created_at, id) keyset condition.
      const cursorVal = '2026-10-15T00:00:00.000Z|33333333-3333-4333-a333-333333333333';
      let capturedOrFilter = '';
      const capturedOrders: [string, boolean][] = [];
      let capturedLimit: number | null = null;
      const row = {
        id: '44444444-4444-4444-a444-444444444444',
        user_id: userId,
        folder_id: null,
        name: 'next_item.mp4',
        file_size: '5242880',
        mime_type: 'video/mp4',
        media_type: 'video',
        storage_key: `users/${userId}/media/44444444/next_item.mp4`,
        url: 'https://example.com/next_item.mp4',
        thumbnail_key: null,
        thumbnail_url: null,
        duration_seconds: '15.0',
        aspect_ratio: '9:16',
        caption_text: 'Next caption',
        width: 1080,
        height: 1920,
        created_at: '2026-10-14T23:50:00.000Z',
        updated_at: '2026-10-14T23:50:00.000Z',
      };
      const mockQueryBuilder: any = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        lt: vi.fn().mockReturnThis(),
        or: vi.fn().mockImplementation((filter: string) => {
          capturedOrFilter = filter;
          return mockQueryBuilder;
        }),
        order: vi.fn().mockImplementation((col: string, opts: { ascending: boolean }) => {
          capturedOrders.push([col, opts.ascending]);
          return mockQueryBuilder;
        }),
        limit: vi.fn().mockImplementation((n: number) => {
          capturedLimit = n;
          return mockQueryBuilder;
        }),
        then: (resolve: (v: unknown) => void) => {
          resolve({ data: [row], count: 1, error: null });
        },
      };
      const mockSupabase = { from: vi.fn().mockReturnValue(mockQueryBuilder) };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/media?cursor=${encodeURIComponent(cursorVal)}&limit=1`,
        { headers: { cookie: validSessionCookie } }
      );
      const res = await handleListMedia(req, 'acme', mockSupabase as never);
      expect(res.status).toBe(200);
      expect(capturedOrFilter).toBe(
        'created_at.lt.2026-10-15T00:00:00.000Z,and(created_at.eq.2026-10-15T00:00:00.000Z,id.lt.33333333-3333-4333-a333-333333333333)'
      );
      expect(capturedOrders).toEqual([
        ['created_at', false],
        ['id', false],
      ]);
      expect(capturedLimit).toBe(1);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.nextCursor).toBe('2026-10-14T23:50:00.000Z|44444444-4444-4444-a444-444444444444');
    });
  });

  describe('Pre-Upload Duplicate Detection (POST /api/tenant/[subdomain]/media/check-duplicates)', () => {
    it('detects duplicate files in target folder by case-insensitive name and size', async () => {
      const mockDb: Partial<DatabaseClient> = {
        query: vi.fn().mockImplementation((_sql: string, params: any[]) => {
          // params: [userId, targetFolderId, names, fileSizes]
          return Promise.resolve([
            {
              id: '55555555-5555-4555-a555-555555555555',
              user_id: userId,
              folder_id: folderId,
              name: 'EXISTING_VIDEO.MP4',
              file_size: 10485760,
              mime_type: 'video/mp4',
              media_type: 'video',
              storage_key: `users/${userId}/media/55555555/video.mp4`,
              url: 'https://example.com/video.mp4',
              thumbnail_key: null,
              thumbnail_url: null,
              duration_seconds: 30,
              aspect_ratio: '9:16',
              caption_text: null,
              width: 1080,
              height: 1920,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ]);
        }),
      };

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/media/check-duplicates', {
        method: 'POST',
        headers: {
          cookie: validSessionCookie,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          folderId,
          entries: [
            {
              clientKey: 'file-1',
              name: 'existing_video.mp4',
              fileSize: 10485760,
            },
            {
              clientKey: 'file-2',
              name: 'brand_new_video.mp4',
              fileSize: 20485760,
            },
          ],
        }),
      });

      const res = await handleCheckDuplicates(req, 'acme', mockDb as DatabaseClient);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.duplicates).toHaveLength(1);
      expect(body.duplicates[0].clientKey).toBe('file-1');
      expect(body.duplicates[0].existingItem.id).toBe('55555555-5555-4555-a555-555555555555');
    });
  });
});
