import { describe, expect, it, vi, beforeEach } from 'vitest';
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
    it('revokes Facebook access, marks the account revoked, disconnects destinations and cancels queued items — never hard-deleting (BG10)', async () => {
      // The stored ciphertext must decrypt under the test-env key
      // (dev fallback) so the revoke attempt actually runs.
      const encrypted = await encryptToken(
        'user-token',
        getTokenEncryptionKey()
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true }) as Response)
      );
      let revokedAccountParams: any[] = [];
      const mockDb = {
        query: vi.fn().mockImplementation((sql: string, params: any[]) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('SELECT encrypted_access_token')) {
            return Promise.resolve([{ encrypted_access_token: encrypted }]);
          }
          if (sql.includes("UPDATE destinations SET status = 'disconnected'")) {
            return Promise.resolve([{ id: 'd1' }, { id: 'd2' }]);
          }
          if (sql.includes("UPDATE social_accounts SET status = 'revoked'")) {
            revokedAccountParams = params;
            return Promise.resolve([{ id: accountId }]);
          }
          return Promise.resolve([]);
        }),
      };

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
        mockDb as unknown as DatabaseClient
      );
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.accountId).toBe(accountId);
      expect(json.disconnectedPagesCount).toBe(2);
      expect(json.facebookRevoked).toBe(true);

      expect(revokedAccountParams[0]).toBe(accountId);
      expect(revokedAccountParams[1]).toBe('ws_123');
      // The old hard delete must be gone: no DELETE statement
      // against social_accounts may run on this path.
      const statements = mockDb.query.mock.calls.map(
        (call) => call[0] as string
      );
      expect(
        statements.some((sql) => sql.includes('DELETE FROM social_accounts'))
      ).toBe(false);
      vi.unstubAllGlobals();
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
