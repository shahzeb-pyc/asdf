import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  encryptToken,
  getTokenEncryptionKey,
  signSessionToken,
} from '@fbuploadpro/contracts';
import { handleDisconnectPage } from '../../src/app/api/tenant/[subdomain]/pages/[pageId]/route';
import { handleDisconnectAccount } from '../../src/app/api/tenant/[subdomain]/accounts/[accountId]/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Facebook Granular Disconnection & Multi-Tenant Governance (User Story 4 - T069)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const accountId = '22222222-2222-4222-a222-222222222222';
  const pageId = '33333333-3333-4333-a333-333333333333';
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

  describe('Disconnect Page (DELETE /api/tenant/[subdomain]/pages/[pageId])', () => {
    it('soft-deletes specific page under (workspace_id, pageId) by setting status = disconnected, wiping the destination token, and cancelling queued posts', async () => {
      let updatedParams: any[] = [];
      let skippedQueueParams: any[] = [];
      let skippedSql = '';
      const mockDb = {
        query: vi.fn().mockImplementation((sql: string, params: any[]) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('UPDATE destinations')) {
            updatedParams = params;
            return Promise.resolve([{ id: pageId, fbPageId: 'page_1001' }]);
          }
          if (sql.includes('UPDATE queue_items')) {
            skippedSql = sql;
            skippedQueueParams = params;
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

      // Verify soft-delete parameters are workspace-scoped and the
      // queued unified items are cancelled under the same workspace.
      expect(updatedParams[0]).toBe(pageId);
      expect(updatedParams[1]).toBe('ws_123');
      expect(skippedSql).toContain("status = 'cancelled'");
      expect(skippedQueueParams).toEqual(['ws_123', pageId]);
    });

    it('transitions queued items to cancelled via Supabase client on page disconnect', async () => {
      const queueUpdateMock = vi.fn();
      const queueEqMock = vi.fn();

      const mockSupabase = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'workspaces') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: { id: 'ws_123' },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'destinations') {
            const pageBuilder = {
              eq: vi.fn().mockImplementation(() => pageBuilder),
              select: vi.fn().mockResolvedValue({
                data: [{ id: pageId, external_destination_id: 'page_1001' }],
                error: null,
              }),
            };
            return {
              select: vi.fn().mockImplementation(() => {
                const chain: any = {
                  eq: vi.fn().mockImplementation(() => chain),
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { metadata: {} },
                    error: null,
                  }),
                };
                return chain;
              }),
              update: vi.fn().mockReturnValue(pageBuilder),
            };
          }
          if (table === 'queue_items') {
            const queueChain: any = {
              eq: queueEqMock,
              then: (resolve: any) =>
                Promise.resolve({ data: [], error: null }).then(resolve),
            };
            queueEqMock.mockImplementation(() => queueChain);
            queueUpdateMock.mockImplementation(() => queueChain);
            return {
              update: queueUpdateMock,
            };
          }
          return {};
        }),
      };

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}`,
        {
          method: 'DELETE',
          headers: { cookie: validSessionCookie },
        }
      );

      const res = await handleDisconnectPage(req, 'acme', pageId, mockSupabase as any);
      expect(res.status).toBe(200);

      expect(queueUpdateMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'cancelled' })
      );
      expect(queueEqMock).toHaveBeenCalledWith('destination_id', pageId);
    });

    it('returns 404 when page does not exist or belongs to another user', async () => {
      const mockDb = {
        query: vi.fn().mockResolvedValue([]),
      } as unknown as DatabaseClient;

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/pages/${pageId}`,
        {
          method: 'DELETE',
          headers: { cookie: validSessionCookie },
        }
      );

      const res = await handleDisconnectPage(req, 'acme', pageId, mockDb);
      expect(res.status).toBe(404);
    });

    it('rejects cross-tenant access with 403', async () => {
      const mockDb = { query: vi.fn() } as unknown as DatabaseClient;
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/evil-tenant/pages/${pageId}`,
        {
          method: 'DELETE',
          headers: { cookie: validSessionCookie },
        }
      );

      const res = await handleDisconnectPage(req, 'evil-tenant', pageId, mockDb);
      expect(res.status).toBe(403);
    });
  });

  describe('Disconnect Account (DELETE /api/tenant/[subdomain]/accounts/[accountId])', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // Mock Postgres client for the disconnect path. Matcher order
    // matters: the DELETE statement also contains the substring
    // 'FROM social_accounts', so it must be matched first.
    const buildAccountMockDb = (status: string, encrypted: string) => {
      const mockDb = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('DELETE FROM social_accounts')) {
            return Promise.resolve([{ id: accountId }]);
          }
          if (sql.includes('FROM social_accounts')) {
            return Promise.resolve([
              { status, encrypted_access_token: encrypted },
            ]);
          }
          if (sql.includes('FROM destinations')) {
            return Promise.resolve([{ id: 'd1' }, { id: 'd2' }]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;
      return mockDb;
    };

    const deleteAccountRequest = () =>
      new NextRequest(
        `http://localhost:3000/api/tenant/acme/accounts/${accountId}`,
        {
          method: 'DELETE',
          headers: { cookie: validSessionCookie },
        }
      );

    const deleteStatements = (mockDb: DatabaseClient) =>
      (mockDb as unknown as { query: { mock: { calls: Array<[string, unknown[]]> } } }).query.mock.calls
        .filter((call) => (call[0] as string).includes('DELETE FROM social_accounts'));

    it('expired account: skips the Facebook revoke call and deletes the account row', async () => {
      // The stored ciphertext must decrypt under the test-env key
      // so that, on the OLD code, the revoke attempt actually runs
      // (and this test fails there on both assertions below).
      const encrypted = await encryptToken(
        'user-token',
        getTokenEncryptionKey()
      );
      const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
      vi.stubGlobal('fetch', fetchMock);
      const mockDb = buildAccountMockDb('expired', encrypted);

      const res = await handleDisconnectAccount(
        deleteAccountRequest(),
        'acme',
        accountId,
        mockDb
      );
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.accountId).toBe(accountId);
      expect(json.disconnectedPagesCount).toBe(2);
      // No revoke was possible (dead token) — but removal is
      // complete regardless, with no Facebook-side step demanded.
      expect(json.facebookRevoked).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();

      const deletes = deleteStatements(mockDb);
      expect(deletes).toHaveLength(1);
      expect(deletes[0][1]).toEqual([accountId, 'ws_123']);
    });

    it('already-disconnected (revoked) account: skips the revoke call and deletes the row', async () => {
      const encrypted = await encryptToken(
        'user-token',
        getTokenEncryptionKey()
      );
      const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
      vi.stubGlobal('fetch', fetchMock);
      const mockDb = buildAccountMockDb('revoked', encrypted);

      const res = await handleDisconnectAccount(
        deleteAccountRequest(),
        'acme',
        accountId,
        mockDb
      );
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.facebookRevoked).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(deleteStatements(mockDb)).toHaveLength(1);
    });

    it('active account with a successful revoke: deletes the row and reports facebookRevoked=true', async () => {
      const encrypted = await encryptToken(
        'user-token',
        getTokenEncryptionKey()
      );
      const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
      vi.stubGlobal('fetch', fetchMock);
      const mockDb = buildAccountMockDb('active', encrypted);

      const res = await handleDisconnectAccount(
        deleteAccountRequest(),
        'acme',
        accountId,
        mockDb
      );
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.facebookRevoked).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(deleteStatements(mockDb)).toHaveLength(1);
    });

    it('active account with a failing revoke: still deletes the row and still succeeds', async () => {
      const encrypted = await encryptToken(
        'user-token',
        getTokenEncryptionKey()
      );
      const fetchMock = vi.fn(async () => ({ ok: false }) as Response);
      vi.stubGlobal('fetch', fetchMock);
      const mockDb = buildAccountMockDb('active', encrypted);

      const res = await handleDisconnectAccount(
        deleteAccountRequest(),
        'acme',
        accountId,
        mockDb
      );
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      // Revoke failed, but the token dies with the deleted row —
      // removal is complete and no Facebook-side step is demanded.
      expect(json.facebookRevoked).toBe(false);
      expect(deleteStatements(mockDb)).toHaveLength(1);
    });

    it('Supabase path: expired account deletes via the client without calling Facebook', async () => {
      const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
      vi.stubGlobal('fetch', fetchMock);
      const deleteSelectMock = vi.fn().mockResolvedValue({
        data: [{ id: accountId }],
        error: null,
      });
      let socialAccountsCalls = 0;
      const mockSupabase = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'workspaces') {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  eq: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                      data: { id: 'ws_123' },
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          }
          if (table === 'social_accounts') {
            socialAccountsCalls += 1;
            if (socialAccountsCalls === 1) {
              // Load chain.
              const loadChain: any = {};
              loadChain.eq = vi.fn().mockImplementation(() => loadChain);
              loadChain.maybeSingle = vi.fn().mockResolvedValue({
                data: {
                  id: accountId,
                  status: 'expired',
                  encrypted_access_token: 'dead-token',
                },
                error: null,
              });
              return { select: vi.fn().mockReturnValue(loadChain) };
            }
            // Delete chain.
            const deleteChain: any = {};
            deleteChain.eq = vi.fn().mockImplementation(() => deleteChain);
            deleteChain.select = deleteSelectMock;
            return { delete: vi.fn().mockReturnValue(deleteChain) };
          }
          if (table === 'destinations') {
            const countChain: any = {};
            countChain.eq = vi.fn().mockImplementation(() => countChain);
            countChain.then = (resolve: any) =>
              Promise.resolve({
                data: [{ id: 'd1' }],
                error: null,
              }).then(resolve);
            return { select: vi.fn().mockReturnValue(countChain) };
          }
          return {};
        }),
      };

      const res = await handleDisconnectAccount(
        deleteAccountRequest(),
        'acme',
        accountId,
        mockSupabase as any
      );
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.disconnectedPagesCount).toBe(1);
      expect(json.facebookRevoked).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(deleteSelectMock).toHaveBeenCalledWith('id');
    });

    it('returns 404 when account does not exist or belongs to another user', async () => {
      const mockDb = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('SELECT COUNT')) {
            return Promise.resolve([{ count: 0 }]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;

      const req = new NextRequest(
        `http://localhost:3000/api/tenant/acme/accounts/${accountId}`,
        {
          method: 'DELETE',
          headers: { cookie: validSessionCookie },
        }
      );

      const res = await handleDisconnectAccount(
        req,
        'acme',
        accountId,
        mockDb
      );
      expect(res.status).toBe(404);
    });

    it('rejects cross-tenant access with 403', async () => {
      const mockDb = { query: vi.fn() } as unknown as DatabaseClient;
      const req = new NextRequest(
        `http://localhost:3000/api/tenant/evil-tenant/accounts/${accountId}`,
        {
          method: 'DELETE',
          headers: { cookie: validSessionCookie },
        }
      );

      const res = await handleDisconnectAccount(
        req,
        'evil-tenant',
        accountId,
        mockDb
      );
      expect(res.status).toBe(403);
    });
  });
});
