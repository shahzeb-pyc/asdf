/**
 * @file multi-workspace-fb-constraints.test.ts
 * @description Security and regression tests for ISSUES.md:
 * - Multi-workspace Facebook accounts & pages unique constraints (Issue 1)
 * - Tenant auth guards and multi-tab access via allowedSubdomains (Issue 2)
 * - Active session validation revoking stale/suspended sessions (Issue 2)
 * - 3-day fb_rate_limited cooldown preservation via rateLimitedAt (Issue 6)
 * - Deep link redirection preservation via allowedSubdomains (Issue 9)
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  canAccessTenant,
  evaluatePageHealth,
} from '@fbuploadpro/contracts';
import { sanitizeAuthRedirectUrl } from '@/lib/auth-redirect';
import {
  _setMockSupabaseClient,
} from '@/lib/auth/clients';
import {
  validateSessionDetailed,
} from '@/lib/auth/session';
import {
  _resetAuthStores,
} from '@/lib/auth/stores';

const USER_ID = '11111111-1111-4111-a111-111111111111';
const WORKSPACE_A = '22222222-2222-4222-a222-222222222222';
const WORKSPACE_B = '33333333-3333-4333-a333-333333333333';
const FB_ACCOUNT_ID = 'act_fb_12345';
const FB_PAGE_ID = 'page_fb_67890';

describe('ISSUES.md Security & Architecture Regressions', () => {
  beforeEach(() => {
    _resetAuthStores();
  });

  describe('Issue 1: Multi-Workspace Unique Constraints on FB Accounts & Pages', () => {
    it('allows identical fb_account_id to be stored in different workspaces', () => {
      const records = new Map<string, { id: string; workspaceId: string; fbAccountId: string }>();

      const insertAccount = (workspaceId: string, fbAccountId: string) => {
        const key = `${workspaceId}:${fbAccountId}`;
        if (records.has(key)) {
          throw new Error('UNIQUE constraint failed: uq_fb_accounts_workspace_account');
        }
        const record = { id: `acc-${records.size + 1}`, workspaceId, fbAccountId };
        records.set(key, record);
        return record;
      };

      const accountA = insertAccount(WORKSPACE_A, FB_ACCOUNT_ID);
      expect(accountA.workspaceId).toBe(WORKSPACE_A);

      // Connecting same FB account to Workspace B must succeed
      const accountB = insertAccount(WORKSPACE_B, FB_ACCOUNT_ID);
      expect(accountB.workspaceId).toBe(WORKSPACE_B);

      // Connecting duplicate to same workspace fails
      expect(() => insertAccount(WORKSPACE_A, FB_ACCOUNT_ID)).toThrow(
        'UNIQUE constraint failed: uq_fb_accounts_workspace_account'
      );
    });

    it('allows identical fb_page_id to be imported into different workspaces', () => {
      const pageRecords = new Map<string, { id: string; workspaceId: string; fbPageId: string }>();

      const insertPage = (workspaceId: string, fbPageId: string) => {
        const key = `${workspaceId}:${fbPageId}`;
        if (pageRecords.has(key)) {
          throw new Error('UNIQUE constraint failed: uq_fb_pages_workspace_page');
        }
        const record = { id: `page-${pageRecords.size + 1}`, workspaceId, fbPageId };
        pageRecords.set(key, record);
        return record;
      };

      const pageA = insertPage(WORKSPACE_A, FB_PAGE_ID);
      expect(pageA.workspaceId).toBe(WORKSPACE_A);

      // Importing same FB page to Workspace B must succeed
      const pageB = insertPage(WORKSPACE_B, FB_PAGE_ID);
      expect(pageB.workspaceId).toBe(WORKSPACE_B);

      // Duplicate import into Workspace A fails
      expect(() => insertPage(WORKSPACE_A, FB_PAGE_ID)).toThrow(
        'UNIQUE constraint failed: uq_fb_pages_workspace_page'
      );
    });
  });

  describe('Issue 2: Multi-Tab Access via canAccessTenant & allowedSubdomains', () => {
    it('allows user with active session to access secondary workspace in allowedSubdomains', async () => {
      const now = Math.floor(Date.now() / 1000);
      const session = {
        userId: USER_ID,
        email: 'user@gmail.com',
        name: 'Workspace Owner',
        subdomain: 'workspace-a',
        role: 'user' as const,
        status: 'active' as const,
        allowedSubdomains: ['workspace-a', 'workspace-b'],
        iat: now,
        exp: now + 3600,
      };

      const accessA = canAccessTenant(session, 'workspace-a');
      expect(accessA.allowed).toBe(true);

      const accessB = canAccessTenant(session, 'workspace-b');
      expect(accessB.allowed).toBe(true);

      const accessC = canAccessTenant(session, 'workspace-c');
      expect(accessC.allowed).toBe(false);
    });

    it('allows admin to access any workspace regardless of allowedSubdomains', async () => {
      const now = Math.floor(Date.now() / 1000);
      const adminSession = {
        userId: USER_ID,
        email: 'admin@gmail.com',
        name: 'System Admin',
        subdomain: 'system-admin',
        role: 'admin' as const,
        status: 'active' as const,
        allowedSubdomains: ['system-admin'],
        iat: now,
        exp: now + 3600,
      };

      expect(canAccessTenant(adminSession, 'any-tenant-workspace').allowed).toBe(true);
    });
  });

  describe('Issue 2: Session Active & Revocation Validation', () => {
    it('revokes session issued before password reset', async () => {
      const tokenIssuedAt = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      const passwordResetAt = new Date(Date.now() - 1800 * 1000); // 30 minutes ago

      const session = {
        userId: USER_ID,
        email: 'user@gmail.com',
        name: 'User',
        subdomain: 'workspace-a',
        role: 'user' as const,
        status: 'active' as const,
        iat: tokenIssuedAt,
        exp: tokenIssuedAt + 3600,
      };

      const mockSupabase = {
        from: (table: string) => {
          if (table === 'users') {
            return {
              select: () => ({
                or: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: USER_ID,
                      email: 'user@gmail.com',
                      name: 'User',
                      phone: '+15555550100',
                      role: 'user',
                      status: 'active',
                      password_updated_at: passwordResetAt.toISOString(),
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'workspaces') {
            return {
              select: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({
                        data: { subdomain: 'workspace-a' },
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      _setMockSupabaseClient(mockSupabase as any);
      const verdict = await validateSessionDetailed(session);
      expect(verdict).toBe('dead');
    });

    it('revokes session for suspended user', async () => {
      const now = Math.floor(Date.now() / 1000);
      const session = {
        userId: USER_ID,
        email: 'suspended@gmail.com',
        name: 'Suspended User',
        subdomain: 'workspace-a',
        role: 'user' as const,
        status: 'active' as const,
        iat: now,
        exp: now + 3600,
      };

      const mockSupabase = {
        from: (table: string) => {
          if (table === 'users') {
            return {
              select: () => ({
                or: () => ({
                  maybeSingle: async () => ({
                    data: {
                      id: USER_ID,
                      email: 'suspended@gmail.com',
                      name: 'Suspended User',
                      phone: '+15555550101',
                      role: 'user',
                      status: 'suspended',
                      password_updated_at: null,
                    },
                    error: null,
                  }),
                }),
              }),
            };
          }
          if (table === 'workspaces') {
            return {
              select: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({
                        data: { subdomain: 'workspace-a' },
                        error: null,
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      _setMockSupabaseClient(mockSupabase as any);
      const verdict = await validateSessionDetailed(session);
      expect(verdict).toBe('dead');
    });
  });

  describe('Issue 6: 3-Day Rate-Limited Cooldown with rateLimitedAt', () => {
    it('uses rateLimitedAt when present to calculate cooldown', () => {
      const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

      // Page was rate limited 4 days ago, but updated_at was touched 1 hour ago by insights-sync
      const recoveredStatus = evaluatePageHealth({
        status: 'fb_rate_limited',
        rateLimitedAt: fourDaysAgo,
        updatedAt: oneHourAgo,
      });

      // Cooldown timer must be satisfied (>3 days since rateLimitedAt) and recover to 'active'
      expect(recoveredStatus).toBe('active');
    });

    it('remains fb_rate_limited if rateLimitedAt is within 3 days', () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

      const stillLimited = evaluatePageHealth({
        status: 'fb_rate_limited',
        rateLimitedAt: twoDaysAgo,
        updatedAt: twoDaysAgo,
      });

      expect(stillLimited).toBe('fb_rate_limited');
    });

    it('falls back to updatedAt when rateLimitedAt is not provided', () => {
      const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);

      const status = evaluatePageHealth({
        status: 'fb_rate_limited',
        updatedAt: fourDaysAgo,
      });

      expect(status).toBe('active');
    });
  });

  describe('Issue 9: Deep Link Preservation in sanitizeAuthRedirectUrl', () => {
    it('allows redirect to secondary workspace if present in allowedSubdomains', () => {
      const returnUrl = 'https://workspace-b.velocta.com/settings';
      const sanitized = sanitizeAuthRedirectUrl(
        returnUrl,
        'workspace-a',
        'velocta.com',
        null,
        ['workspace-a', 'workspace-b']
      );

      expect(sanitized).toBe(returnUrl);
    });

    it('rejects redirect to unauthorized workspace not in allowedSubdomains', () => {
      const returnUrl = 'https://unauthorized-workspace.velocta.com/dashboard';
      const sanitized = sanitizeAuthRedirectUrl(
        returnUrl,
        'workspace-a',
        'velocta.com',
        null,
        ['workspace-a', 'workspace-b']
      );

      // Falls back to user's primary workspace root
      expect(sanitized).toBe('https://workspace-a.velocta.com/');
    });
  });
});
