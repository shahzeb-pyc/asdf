import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  encryptToken,
  decryptToken,
  signSessionToken,
} from '@fbuploadpro/contracts';
import { handleDiscoverPages } from '../../src/app/api/tenant/[subdomain]/accounts/[accountId]/pages/discover/route';
import { handleImportPages } from '../../src/app/api/tenant/[subdomain]/pages/import/route';
import { handleListPages } from '../../src/app/api/tenant/[subdomain]/pages/route';
import {
  handleDisconnectPage,
  handleGetPage,
  handleUpdatePage,
} from '../../src/app/api/tenant/[subdomain]/pages/[pageId]/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';
import { createMockSupabasePages } from '../helpers/mock-supabase-pages';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Facebook Pages Discovery, Import, Follower Tracking & Soft-Delete (Spec 032)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const accountId = '22222222-2222-4222-a222-222222222222';
  const pageId = '33333333-3333-4333-a333-333333333333';
  let validSessionCookie: string;
  let sampleEncryptedAccountToken: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

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

    sampleEncryptedAccountToken = await encryptToken(
      'mock_long_lived_account_token',
      TEST_ENCRYPTION_KEY
    );
  });

  describe('Page Discovery (GET /api/tenant/[subdomain]/accounts/[accountId]/pages/discover)', () => {
    it('discovers pages from Graph API v26.0, excludes groups and soft-deleted (disconnected) pages from isImported: true, and never leaks tokens', async () => {
      const executedQueries: string[] = [];
      const mockDb = {
        query: vi.fn().mockImplementation((sql: string) => {
          executedQueries.push(sql);
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM social_accounts')) {
            return Promise.resolve([
              {
                id: accountId,
                userId,
                fbAccountId: 'fb_act_123',
                displayName: 'Alex Marketing Profile',
                encryptedAccessToken: sampleEncryptedAccountToken,
                status: 'active',
              },
            ]);
          }
          if (sql.includes('FROM destinations')) {
            // Query must exclude status != 'disconnected' so page_disconnected is not returned here
            return Promise.resolve([{ fbPageId: 'page_1001' }]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;

      // Mock Graph API v26.0 /me/accounts response with pages and mixed items
      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'page_1001',
                name: 'Brand Flagship Page',
                category: 'Retail Company',
                followers_count: 52000,
                tasks: ['CREATE_CONTENT', 'MANAGE'],
                access_token: 'page_token_1001_secret',
                picture: {
                  data: {
                    url: 'https://platform-lookaside.fbsbx.com/platform/profilepic/page_1001.jpg',
                  },
                },
              },
              {
                id: 'page_1002',
                name: 'Creator Vlog Page',
                category: 'Digital Creator',
                followers_count: 14000,
                tasks: ['CREATE_CONTENT'],
                access_token: 'page_token_1002_secret',
              },
              {
                id: 'page_disconnected',
                name: 'Previously Removed Page',
                category: 'Media/News Company',
                followers_count: 8500,
                tasks: ['CREATE_CONTENT'],
                access_token: 'page_token_disc_secret',
              },
              {
                // Hypothetical group node accidentally returned - must be ignored
                id: 'group_9999',
                name: 'Unofficial Community Group',
                access_token: 'group_token',
              },
            ],
          }),
          { status: 200 }
        )
      );

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/accounts/${accountId}/pages/discover`,
        { headers: { cookie: validSessionCookie } }
      );

      const res = await handleDiscoverPages(req, 'acme', accountId, mockDb);
      expect(res.status).toBe(200);

      const pagesSql = executedQueries.find((q) => q.includes('FROM destinations'));
      expect(pagesSql).toBeDefined();
      expect(pagesSql).toContain("status != 'disconnected'");

      const json = await res.json();
      expect(json.accountId).toBe(accountId);
      expect(json.pages).toHaveLength(3); // strictly pages, group filtered out

      const page1 = json.pages.find((p: { fbPageId: string }) => p.fbPageId === 'page_1001');
      const page2 = json.pages.find((p: { fbPageId: string }) => p.fbPageId === 'page_1002');
      const pageDisc = json.pages.find(
        (p: { fbPageId: string }) => p.fbPageId === 'page_disconnected'
      );

      expect(page1.isImported).toBe(true);
      expect(page1.currentFollowers).toBe(52000);
      expect(page1.profilePictureUrl).toBe(
        'https://platform-lookaside.fbsbx.com/platform/profilepic/page_1001.jpg'
      );
      expect(page2.isImported).toBe(false);
      expect(page2.currentFollowers).toBe(14000);
      expect(page2.profilePictureUrl).toBeNull();
      expect(pageDisc.isImported).toBe(false);

      // Verify zero token leakage in response
      const resString = JSON.stringify(json);
      expect(resString).not.toContain('page_token');
      expect(resString).not.toContain('secret');
      expect(resString).not.toContain('group_9999');
    });
  });

  describe('Selective Import (POST /api/tenant/[subdomain]/pages/import)', () => {
    it('sets both starting_followers and current_followers on insert, and preserves starting_followers on conflict unless page was disconnected', async () => {
      const savedPages: any[] = [];
      const executedInsertSqls: string[] = [];
      const mockDb = {
        query: vi.fn().mockImplementation((sql: string, params: any[]) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM social_accounts')) {
            return Promise.resolve([
              {
                id: accountId,
                userId,
                fbAccountId: 'fb_act_123',
                encryptedAccessToken: sampleEncryptedAccountToken,
                status: 'active',
              },
            ]);
          }
          if (sql.includes('INSERT INTO destinations')) {
            executedInsertSqls.push(sql);
            savedPages.push(params);
            return Promise.resolve([
              {
                id: pageId,
                fbPageId: params[2],
                pageName: params[3],
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;

      // Mock Graph API v26.0 /me/accounts returning details with Page access tokens
      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'page_1002',
                name: 'Creator Vlog Page',
                category: 'Digital Creator',
                followers_count: 14000,
                tasks: ['CREATE_CONTENT'],
                access_token: 'page_token_1002_raw_secret_value',
                picture: {
                  data: {
                    url: 'https://platform-lookaside.fbsbx.com/platform/profilepic/page_1002.jpg',
                  },
                },
              },
            ],
          }),
          { status: 200 }
        )
      );

      const req = new NextRequest(
        'http://localhost:3000/api/tenant/acme/pages/import',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: validSessionCookie,
          },
          body: JSON.stringify({
            accountId,
            selectedPageIds: ['page_1002'],
          }),
        }
      );

      const res = await handleImportPages(req, 'acme', mockDb);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.importedCount).toBe(1);

      expect(executedInsertSqls).toHaveLength(1);
      const insertSql = executedInsertSqls[0]!;
      // Unified destinations upsert: follower baselines live in the
      // metadata jsonb; the merge preserves starting_followers unless
      // the existing destination was disconnected.
      expect(insertSql).toContain('INSERT INTO destinations');
      expect(insertSql).toContain('ON CONFLICT (account_id, external_destination_id)');
      expect(insertSql).toContain("'starting_followers'");
      expect(insertSql).toContain("'current_followers'");
      expect(insertSql).toContain("destinations.status = 'disconnected'");

      expect(savedPages).toHaveLength(1);
      const [
        wsId,
        accId,
        fbPageId,
        pageName,
        profilePictureUrl,
        encryptedToken,
        category,
        tasksJson,
        followers,
      ] = savedPages[0];

      expect(wsId).toBe('ws_123');
      expect(accId).toBe(accountId);
      expect(fbPageId).toBe('page_1002');
      expect(pageName).toBe('Creator Vlog Page');
      expect(profilePictureUrl).toBe(
        'https://platform-lookaside.fbsbx.com/platform/profilepic/page_1002.jpg'
      );
      expect(encryptedToken).toBeTypeOf('string');
      expect(encryptedToken).toContain(':');
      // The metadata jsonb is built in SQL from these params:
      // category, tasks, and followers feeding BOTH the starting and
      // current follower fields of jsonb_build_object.
      expect(category).toBe('Digital Creator');
      expect(JSON.parse(tasksJson as string)).toEqual(['CREATE_CONTENT']);
      expect(followers).toBe(14000);
      expect(insertSql).toContain("'starting_followers', $9::int");
      expect(insertSql).toContain("'current_followers', $9::int");

      // Verify page token decodes back to original
      const decrypted = await decryptToken(encryptedToken, TEST_ENCRYPTION_KEY);
      expect(decrypted).toBe('page_token_1002_raw_secret_value');
    });

    it('preserves starting_followers baseline when re-importing an active page via Supabase (Audit Issue 12)', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'page_active_1',
                name: 'Active Page',
                category: 'Media',
                tasks: ['MODERATE'],
                access_token: 'token_active_1',
                followers_count: 25000,
                picture: { data: { url: 'https://example.com/pic.jpg' } },
              },
            ],
          }),
          { status: 200 }
        )
      );

      let upsertedPayload: any = null;

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: 'ws_123' },
                error: null,
              }),
            };
          }
          if (table === 'social_accounts') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: accountId,
                  encrypted_access_token: sampleEncryptedAccountToken,
                },
                error: null,
              }),
            };
          }
          if (table === 'destinations') {
            return {
              select: vi.fn((fields: string) => {
                if (fields.includes('metadata')) {
                  return {
                    eq: vi.fn().mockReturnThis(),
                    in: vi.fn().mockResolvedValue({
                      data: [
                        {
                          external_destination_id: 'page_active_1',
                          status: 'active',
                          metadata: { starting_followers: 10000 },
                        },
                      ],
                      error: null,
                    }),
                  };
                }
                return {
                  eq: vi.fn().mockReturnThis(),
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                };
              }),
              upsert: vi.fn((payload: any) => {
                upsertedPayload = payload;
                return {
                  select: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({
                      data: {
                        id: pageId,
                        external_destination_id: 'page_active_1',
                        name: 'Active Page',
                      },
                      error: null,
                    }),
                  }),
                };
              }),
            };
          }
          return {};
        }),
      };

      const req = new NextRequest(
        'http://localhost:3000/api/tenant/acme/pages/import',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: validSessionCookie,
          },
          body: JSON.stringify({
            accountId,
            selectedPageIds: ['page_active_1'],
          }),
        }
      );

      const res = await handleImportPages(req, 'acme', mockSupabase as any);
      expect(res.status).toBe(200);

      expect(upsertedPayload).toBeDefined();
      expect(upsertedPayload.metadata.starting_followers).toBe(10000);
      expect(upsertedPayload.metadata.current_followers).toBe(25000);
      expect(upsertedPayload.status).toBe('active');
    });

    it('resets starting_followers baseline when re-importing a disconnected page via Supabase', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'page_disc_1',
                name: 'Disconnected Page',
                category: 'Media',
                tasks: ['MODERATE'],
                access_token: 'token_disc_1',
                followers_count: 30000,
                picture: { data: { url: 'https://example.com/pic.jpg' } },
              },
            ],
          }),
          { status: 200 }
        )
      );

      let upsertedPayload: any = null;

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: 'ws_123' },
                error: null,
              }),
            };
          }
          if (table === 'social_accounts') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: accountId,
                  encrypted_access_token: sampleEncryptedAccountToken,
                },
                error: null,
              }),
            };
          }
          if (table === 'destinations') {
            return {
              select: vi.fn((fields: string) => {
                if (fields.includes('metadata')) {
                  return {
                    eq: vi.fn().mockReturnThis(),
                    in: vi.fn().mockResolvedValue({
                      data: [
                        {
                          external_destination_id: 'page_disc_1',
                          status: 'disconnected',
                          metadata: { starting_followers: 5000 },
                        },
                      ],
                      error: null,
                    }),
                  };
                }
                return {
                  eq: vi.fn().mockReturnThis(),
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                };
              }),
              upsert: vi.fn((payload: any) => {
                upsertedPayload = payload;
                return {
                  select: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({
                      data: {
                        id: pageId,
                        external_destination_id: 'page_disc_1',
                        name: 'Disconnected Page',
                      },
                      error: null,
                    }),
                  }),
                };
              }),
            };
          }
          return {};
        }),
      };

      const req = new NextRequest(
        'http://localhost:3000/api/tenant/acme/pages/import',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: validSessionCookie,
          },
          body: JSON.stringify({
            accountId,
            selectedPageIds: ['page_disc_1'],
          }),
        }
      );

      const res = await handleImportPages(req, 'acme', mockSupabase as any);
      expect(res.status).toBe(200);

      expect(upsertedPayload).toBeDefined();
      expect(upsertedPayload.metadata.starting_followers).toBe(30000);
      expect(upsertedPayload.metadata.current_followers).toBe(30000);
      expect(upsertedPayload.status).toBe('active');
    });
  });

  describe('List Imported Pages (GET /api/tenant/[subdomain]/pages)', () => {
    it('returns startingFollowers, currentFollowers, and signed followersGained (positive, zero, and negative) while excluding soft-deleted pages', async () => {
      let capturedSql = '';
      const mockDb = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          capturedSql = sql;
          return Promise.resolve([
            {
              id: '33333333-3333-4333-a333-333333333331',
              facebook_account_id: accountId,
              account_display_name: 'Alex Marketing',
              account_avatar_url:
                'https://platform-lookaside.fbsbx.com/platform/profilepic/account_9.jpg',
              fb_page_id: 'page_pos',
              page_name: 'Brand Flagship Page',
              profile_picture_url:
                'https://platform-lookaside.fbsbx.com/platform/profilepic/page_1001.jpg',
              category: 'Retail Company',
              starting_followers: 50000,
              current_followers: 52000,
              status: 'active',
              tasks: ['CREATE_CONTENT', 'MANAGE'],
              created_at: '2026-10-10T10:00:00.000Z',
              updated_at: new Date().toISOString(),
            },
            {
              id: '33333333-3333-4333-a333-333333333332',
              facebook_account_id: accountId,
              account_display_name: 'Alex Marketing',
              fb_page_id: 'page_zero',
              page_name: 'Steady Community Page',
              profile_picture_url: null,
              category: 'Community',
              starting_followers: 10000,
              current_followers: 10000,
              status: 'active',
              tasks: ['CREATE_CONTENT'],
              created_at: '2026-10-09T10:00:00.000Z',
              updated_at: new Date().toISOString(),
            },
            {
              id: '33333333-3333-4333-a333-333333333333',
              facebook_account_id: accountId,
              account_display_name: 'Alex Marketing',
              fb_page_id: 'page_neg',
              page_name: 'Churned Followers Page',
              profile_picture_url: null,
              category: 'Digital Creator',
              starting_followers: 5000,
              current_followers: 4750,
              status: 'paused',
              tasks: ['CREATE_CONTENT'],
              created_at: '2026-10-08T10:00:00.000Z',
              updated_at: new Date().toISOString(),
            },
          ]);
        }),
      } as unknown as DatabaseClient;

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/pages', {
        headers: { cookie: validSessionCookie },
      });

      const res = await handleListPages(req, 'acme', mockDb);
      expect(res.status).toBe(200);

      expect(capturedSql).toContain("d.status != 'disconnected'");
      expect(capturedSql).toContain('starting_followers');
      expect(capturedSql).toContain('current_followers');
      expect(capturedSql).toContain('account_avatar_url');

      const json = await res.json();
      expect(json.total).toBe(3);

      // Looked up by name: the route returns the documented
      // attention-first order (paused before active), not fixture
      // order, now that the SQL path re-sorts the page slice.
      type PageFollowers = {
        startingFollowers: number;
        currentFollowers: number;
        followersGained: number;
        profilePictureUrl: string | null;
        accountPictureUrl: string | null;
      };
      const byName = new Map<string, PageFollowers>(
        json.pages.map((p: any) => [p.pageName, p] as [string, PageFollowers])
      );
      const must = (v: PageFollowers | undefined): PageFollowers => {
        if (!v) throw new Error('expected page missing from response');
        return v;
      };

      // Positive growth (+2000)
      const flagship = must(byName.get('Brand Flagship Page'));
      expect(flagship.startingFollowers).toBe(50000);
      expect(flagship.currentFollowers).toBe(52000);
      expect(flagship.followersGained).toBe(2000);
      expect(flagship.profilePictureUrl).toBe(
        'https://platform-lookaside.fbsbx.com/platform/profilepic/page_1001.jpg'
      );
      expect(flagship.accountPictureUrl).toBe(
        'https://platform-lookaside.fbsbx.com/platform/profilepic/account_9.jpg'
      );

      // Zero growth (0)
      const steady = must(byName.get('Steady Community Page'));
      expect(steady.startingFollowers).toBe(10000);
      expect(steady.currentFollowers).toBe(10000);
      expect(steady.followersGained).toBe(0);

      // Negative growth (-250)
      const churned = must(byName.get('Churned Followers Page'));
      expect(churned.startingFollowers).toBe(5000);
      expect(churned.currentFollowers).toBe(4750);
      expect(churned.followersGained).toBe(-250);

      // Never leak tokens
      const str = JSON.stringify(json);
      expect(str).not.toContain('encryptedAccessToken');
      expect(str).not.toContain('accessToken');
    });

    it('evaluates active status dynamically without write amplification when a page cooldown has expired from fb_rate_limited (Spec 045 / Issue 9)', async () => {
      const pastDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
      let updateExecuted = false;

      const mockDb = {
        query: vi.fn().mockImplementation((sql: string, params?: any[]) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('UPDATE destinations') && sql.includes("status = 'active'")) {
            updateExecuted = true;
            return Promise.resolve([]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([
              {
                id: pageId,
                facebook_account_id: accountId,
                account_display_name: 'Alex Marketing',
                fb_page_id: 'page_rate_limited_expired',
                page_name: 'Recovered Rate Limited Page',
                profile_picture_url: null,
                category: 'Retail Company',
                starting_followers: 1000,
                current_followers: 1050,
                status: 'fb_rate_limited',
                tasks: ['CREATE_CONTENT'],
                created_at: pastDate,
                updated_at: pastDate,
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/pages', {
        headers: { cookie: validSessionCookie },
      });

      const res = await handleListPages(req, 'acme', mockDb);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.pages[0].status).toBe('active');
      expect(updateExecuted).toBe(false);
    });

    it('evaluates active status dynamically via Supabase client without write amplification when a page cooldown has expired (Spec 045 / Issue 9)', async () => {
      const pastDate = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();

      const mockSupabase = createMockSupabasePages([
        {
          id: pageId,
          account_id: accountId,
          external_destination_id: 'page_rate_limited_sb',
          name: 'Supabase Cooldown Page',
          avatar_url: null,
          status: 'rate_limited',
          metadata: {
            category: 'Retail Company',
            tasks: ['CREATE_CONTENT'],
            starting_followers: 1000,
            current_followers: 1050,
            rate_limited_at: pastDate,
          },
          updated_at: pastDate,
          created_at: pastDate,
          social_accounts: {
            display_name: 'Alex Supabase',
            avatar_url:
              'https://platform-lookaside.fbsbx.com/platform/profilepic/account_sup.jpg',
          },
        },
      ]);

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/pages', {
        headers: { cookie: validSessionCookie },
      });

      const res = await handleListPages(req, 'acme', mockSupabase as any);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.pages[0].status).toBe('active');
      expect(mockSupabase.updates).toHaveLength(0);
      expect(json.pages[0].accountPictureUrl).toBe(
        'https://platform-lookaside.fbsbx.com/platform/profilepic/account_sup.jpg'
      );
    });
  });

  describe('Disconnect Page (DELETE /api/tenant/[subdomain]/pages/[pageId])', () => {
    it("performs a soft-delete (status = 'disconnected', wiping encrypted_access_token) and cancels queued posts", async () => {
      const executedStatements: Array<{ sql: string; params: any[] }> = [];
      const mockDb = {
        query: vi.fn().mockImplementation((sql: string, params: any[]) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          executedStatements.push({ sql, params });
          if (sql.includes('UPDATE destinations')) {
            return Promise.resolve([{ id: pageId, fbPageId: 'page_1001' }]);
          }
          if (sql.includes('UPDATE queue_items')) {
            return Promise.resolve([]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}`,
        {
          method: 'DELETE',
          headers: { cookie: validSessionCookie },
        }
      );

      const res = await handleDisconnectPage(req, 'acme', pageId, mockDb);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.pageId).toBe(pageId);

      expect(executedStatements).toHaveLength(2);
      expect(executedStatements[0]!.sql).toContain("status = 'disconnected'");
      expect(executedStatements[0]!.sql).toContain('encrypted_destination_token = NULL');
      expect(executedStatements[0]!.params).toEqual([pageId, 'ws_123']);

      expect(executedStatements[1]!.sql).toContain('UPDATE queue_items');
      expect(executedStatements[1]!.sql).toContain("status = 'cancelled'");
      expect(executedStatements[1]!.params).toEqual(['ws_123', pageId]);
    });

    it('disconnects page and skips queued items via Supabase client', async () => {
      let pageDisconnected = false;
      let queueSkipped = false;

      const mockSupabase = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') {
            return {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'ws_123' }, error: null }),
                  }),
                }),
              }),
            };
          }
          if (table === 'destinations') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnThis(),
                maybeSingle: vi
                  .fn()
                  .mockResolvedValue({ data: { metadata: {} }, error: null }),
              }),
              update: vi.fn((payload: any) => {
                if (payload.status === 'disconnected' && payload.encrypted_destination_token === null) {
                  pageDisconnected = true;
                }
                return {
                  eq: () => ({
                    eq: () => ({
                      eq: () => ({
                        select: vi.fn().mockResolvedValue({
                          data: [{ id: pageId, external_destination_id: 'page_1001' }],
                          error: null,
                        }),
                      }),
                    }),
                  }),
                };
              }),
            };
          }
          if (table === 'queue_items') {
            return {
              update: vi.fn((payload: any) => {
                if (payload.status === 'cancelled') {
                  queueSkipped = true;
                }
                const chain: any = {
                  eq: vi.fn().mockImplementation(() => chain),
                  then: (resolve: any) => Promise.resolve({ error: null }).then(resolve),
                };
                return chain;
              }),
            };
          }
          return {};
        }),
      };

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/pages/${pageId}`, {
        method: 'DELETE',
        headers: { cookie: validSessionCookie },
      });

      const res = await handleDisconnectPage(req, 'acme', pageId, mockSupabase as any);
      expect(res.status).toBe(200);
      expect(pageDisconnected).toBe(true);
      expect(queueSkipped).toBe(true);
    });
  });

  describe('Get Page (GET /api/tenant/[subdomain]/pages/[pageId])', () => {
    it('returns page details for active page via Legacy and Supabase', async () => {
      const mockPageRow = {
        id: pageId,
        facebook_account_id: accountId,
        account_display_name: 'Alex Acme Account',
        fb_page_id: 'fb_page_999',
        page_name: 'Acme Brand',
        profile_picture_url: null,
        category: 'Brand',
        starting_followers: 100,
        current_followers: 150,
        status: 'active',
        tasks: ['CREATE_CONTENT'],
        created_at: new Date('2026-10-01T12:00:00Z').toISOString(),
        updated_at: new Date('2026-10-01T12:00:00Z').toISOString(),
      };

      const mockDb = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([mockPageRow]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/pages/${pageId}`, {
        headers: { cookie: validSessionCookie },
      });

      const res = await handleGetPage(req, 'acme', pageId, mockDb);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.page.id).toBe(pageId);
      expect(json.page.pageName).toBe('Acme Brand');
      expect(json.page.followersGained).toBe(50);
    });
  });

  describe('Update Page (PATCH /api/tenant/[subdomain]/pages/[pageId])', () => {
    it('updates page status to paused and returns updated page', async () => {
      const mockPageRow = {
        id: pageId,
        facebook_account_id: accountId,
        account_display_name: 'Alex Acme Account',
        fb_page_id: 'fb_page_999',
        page_name: 'Acme Brand',
        profile_picture_url: null,
        category: 'Brand',
        starting_followers: 100,
        current_followers: 150,
        status: 'paused',
        tasks: ['CREATE_CONTENT'],
        created_at: new Date('2026-10-01T12:00:00Z').toISOString(),
        updated_at: new Date('2026-10-01T12:00:00Z').toISOString(),
      };

      const mockDb = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('UPDATE destinations')) {
            return Promise.resolve([]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([mockPageRow]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/pages/${pageId}`, {
        method: 'PATCH',
        headers: { cookie: validSessionCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'paused' }),
      });

      const res = await handleUpdatePage(req, 'acme', pageId, mockDb);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.page.status).toBe('paused');
    });

    it('reactivates a checkpoint page to active and clears the fb_status marker', async () => {
      const mockPageRow = {
        id: pageId,
        facebook_account_id: accountId,
        account_display_name: 'Alex Acme Account',
        fb_page_id: 'fb_page_999',
        page_name: 'Acme Brand',
        profile_picture_url: null,
        category: 'Brand',
        starting_followers: 100,
        current_followers: 150,
        status: 'active',
        tasks: ['CREATE_CONTENT'],
        created_at: new Date('2026-10-01T12:00:00Z').toISOString(),
        updated_at: new Date('2026-10-01T12:00:00Z').toISOString(),
      };

      const queryMock = vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (sql.includes('UPDATE destinations')) {
          return Promise.resolve([]);
        }
        if (sql.includes('FROM destinations')) {
          return Promise.resolve([mockPageRow]);
        }
        return Promise.resolve([]);
      });
      const mockDb = {
        query: queryMock,
      } as unknown as DatabaseClient;

      const req = new NextRequest(`http://localhost:3000/api/tenant/acme/pages/${pageId}`, {
        method: 'PATCH',
        headers: { cookie: validSessionCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      });

      const res = await handleUpdatePage(req, 'acme', pageId, mockDb);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.page.status).toBe('active');

      // The UPDATE must write status 'active' with the marker flag
      // false, which the SQL path turns into metadata - 'fb_status':
      // a checkpoint page's marker is cleared on reactivation, so the
      // read-back after reactivation is 'active', never 'invalid_token'
      // via a leftover marker.
      const updateCall = queryMock.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('UPDATE destinations')
      );
      expect(updateCall).toBeDefined();
      expect(updateCall?.[1]).toEqual(['active', null, pageId, false, 'ws_123']);
    });
  });
});

