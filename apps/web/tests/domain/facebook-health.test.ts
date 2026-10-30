import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  evaluateGraphApiError,
  evaluateTokenExpiry,
  evaluateAccountHealth,
  evaluatePageHealth,
  signSessionToken,
} from '@fbuploadpro/contracts';
import { handleListAccounts } from '../../src/app/api/tenant/[subdomain]/accounts/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

describe('Facebook Multi-Account Health Monitoring & Expiration (User Story 3 - T066/T067)', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
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

  describe('Graph API Error Evaluation (T067)', () => {
    it('maps OAuth error 190 subcodes 458, 460, 463 to expired/invalid_token and requires re-auth', () => {
      // Subcode 458: App revoked
      const revoked = evaluateGraphApiError(190, 458);
      expect(revoked).not.toBeNull();
      expect(revoked?.accountStatus).toBe('expired');
      expect(revoked?.pageStatus).toBe('invalid_token');
      expect(revoked?.isTransient).toBe(false);
      expect(revoked?.requiresReauth).toBe(true);

      // Subcode 460: Password changed
      const pwdChanged = evaluateGraphApiError(190, 460);
      expect(pwdChanged?.accountStatus).toBe('expired');
      expect(pwdChanged?.pageStatus).toBe('invalid_token');
      expect(pwdChanged?.requiresReauth).toBe(true);

      // Subcode 463: Token expired
      const expired = evaluateGraphApiError(190, 463);
      expect(expired?.accountStatus).toBe('expired');
      expect(expired?.pageStatus).toBe('invalid_token');
      expect(expired?.requiresReauth).toBe(true);

      // Generic error 190
      const generic190 = evaluateGraphApiError(190);
      expect(generic190?.accountStatus).toBe('expired');
      expect(generic190?.pageStatus).toBe('invalid_token');
      expect(generic190?.requiresReauth).toBe(true);
    });

    it('maps error 368 + subcode 1390008 (or default 368) to fb_rate_limited with 3-day auto-recovery', () => {
      const rateLimitBlock = evaluateGraphApiError(368, 1390008);
      expect(rateLimitBlock).not.toBeNull();
      expect(rateLimitBlock?.accountStatus).toBe('active');
      expect(rateLimitBlock?.pageStatus).toBe('fb_rate_limited');
      expect(rateLimitBlock?.isTransient).toBe(true);
      expect(rateLimitBlock?.requiresReauth).toBe(false);
      expect(rateLimitBlock?.cooldownDays).toBe(3);

      const default368 = evaluateGraphApiError(368);
      expect(default368?.pageStatus).toBe('fb_rate_limited');
      expect(default368?.cooldownDays).toBe(3);
    });

    it('maps error 368 + subcode 4854002 to page_checkpoint requiring mobile verification and manual reactivation', () => {
      const checkpoint = evaluateGraphApiError(368, 4854002);
      expect(checkpoint).not.toBeNull();
      expect(checkpoint?.accountStatus).toBe('active');
      expect(checkpoint?.pageStatus).toBe('page_checkpoint');
      expect(checkpoint?.isTransient).toBe(false);
      expect(checkpoint?.requiresReauth).toBe(false);
      expect(checkpoint?.requiresManualVerification).toBe(true);
      expect(checkpoint?.message).toContain('Confirm your identity before you can publish as this Page');
      expect(checkpoint?.message).toContain('mobile');
    });

    it('maps error 368 + subcode 1404082 (duplicate content) as non-transient post failure while keeping pageStatus active', () => {
      const duplicate = evaluateGraphApiError(368, 1404082);
      expect(duplicate).not.toBeNull();
      expect(duplicate?.accountStatus).toBe('active');
      expect(duplicate?.pageStatus).toBe('active');
      expect(duplicate?.isTransient).toBe(false);
      expect(duplicate?.requiresReauth).toBe(false);
      expect(duplicate?.message).toContain("You've already posted this");
    });

    it('auto-turns fb_rate_limited pages to active after 3 days while keeping page_checkpoint and paused until manual reactivation', () => {
      const blockedAt = new Date('2026-10-01T12:00:00Z');
      const after2Days = new Date('2026-10-03T12:00:00Z');
      const after3Days = new Date('2026-10-04T12:00:00Z');

      expect(
        evaluatePageHealth({ status: 'fb_rate_limited', updatedAt: blockedAt }, after2Days)
      ).toBe('fb_rate_limited');
      expect(
        evaluatePageHealth({ status: 'fb_rate_limited', updatedAt: blockedAt }, after3Days)
      ).toBe('active');

      // page_checkpoint never auto-recovers even after 10 days; must be manually turned to active
      const after10Days = new Date('2026-10-11T12:00:00Z');
      expect(
        evaluatePageHealth({ status: 'page_checkpoint', updatedAt: blockedAt }, after10Days)
      ).toBe('page_checkpoint');

      // paused never auto-recovers even after 10 days; remains paused until user toggles active
      expect(
        evaluatePageHealth({ status: 'paused', updatedAt: blockedAt }, after10Days)
      ).toBe('paused');
    });

    it('maps API rate limit codes 4, 17, 32, 341, 613, 80001 as transient errors keeping accountStatus and pageStatus active', () => {
      for (const code of [4, 17, 32, 341, 613, 80001]) {
        const rateLimit = evaluateGraphApiError(code);
        expect(rateLimit).not.toBeNull();
        expect(rateLimit?.accountStatus).toBe('active');
        expect(rateLimit?.pageStatus).toBe('active');
        expect(rateLimit?.isTransient).toBe(true);
        expect(rateLimit?.requiresReauth).toBe(false);
      }
    });

    it('returns null for unrecognized non-OAuth error codes', () => {
      expect(evaluateGraphApiError(500)).toBeNull();
      expect(evaluateGraphApiError(1)).toBeNull();
    });
  });

  describe('Token Expiration Horizons (T067)', () => {
    it('evaluates future expiration horizons as active with days remaining', () => {
      const now = new Date('2026-10-01T12:00:00Z');
      const in30Days = new Date('2026-10-31T12:00:00Z');

      const evaluation = evaluateTokenExpiry(in30Days, now);
      expect(evaluation.isExpired).toBe(false);
      expect(evaluation.status).toBe('active');
      expect(evaluation.daysRemaining).toBe(30);

      const health = evaluateAccountHealth(
        { status: 'active', tokenExpiresAt: in30Days },
        now
      );
      expect(health).toBe('active');
    });

    it('evaluates past expiration horizons as expired with zero days remaining', () => {
      const now = new Date('2026-10-01T12:00:00Z');
      const inPast = new Date('2026-09-15T12:00:00Z');

      const evaluation = evaluateTokenExpiry(inPast, now);
      expect(evaluation.isExpired).toBe(true);
      expect(evaluation.status).toBe('expired');
      expect(evaluation.daysRemaining).toBe(0);

      const health = evaluateAccountHealth(
        { status: 'active', tokenExpiresAt: inPast },
        now
      );
      expect(health).toBe('expired');
    });

    it('preserves disconnected status even if token expiration is in future', () => {
      const now = new Date('2026-10-01T12:00:00Z');
      const inFuture = new Date('2026-11-01T12:00:00Z');

      const health = evaluateAccountHealth(
        { status: 'disconnected', tokenExpiresAt: inFuture },
        now
      );
      expect(health).toBe('disconnected');
    });
  });

  describe('List Connected Accounts Endpoint (GET /api/tenant/[subdomain]/accounts - T068)', () => {
    it('returns sanitized multi-account listing with connected page counts and dynamic health status', async () => {
      const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString();
      const futureDate = new Date(
        Date.now() + 1000 * 60 * 60 * 24 * 30
      ).toISOString();

      const mockDb = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('FROM social_accounts')) {
            return Promise.resolve([
              {
                id: '22222222-2222-4222-a222-222222222222',
                fbAccountId: 'fb_act_active',
                displayName: 'Active Creator Account',
                profile_picture_url:
                  'https://platform-lookaside.fbsbx.com/platform/profilepic/creator.jpg',
                gender: 'female',
                account_link:
                  'https://www.facebook.com/app_scoped_user_id/fb_act_active/',
                status: 'active',
                tokenExpiresAt: futureDate,
                connectedPagesCount: 2,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              {
                id: '33333333-3333-4333-a333-333333333333',
                fbAccountId: 'fb_act_expired',
                displayName: 'Expired Client Account',
                status: 'active', // Raw status in DB is active, but token is past
                tokenExpiresAt: pastDate,
                connectedPagesCount: 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;

      const req = new NextRequest(
        'http://localhost:3000/api/tenant/acme/accounts',
        { headers: { cookie: validSessionCookie } }
      );

      const res = await handleListAccounts(req, 'acme', mockDb);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.total).toBe(2);
      expect(json.accounts).toHaveLength(2);

      const activeAcc = json.accounts.find(
        (a: { id: string }) => a.id === '22222222-2222-4222-a222-222222222222'
      );
      const expiredAcc = json.accounts.find(
        (a: { id: string }) => a.id === '33333333-3333-4333-a333-333333333333'
      );

      expect(activeAcc.status).toBe('active');
      expect(activeAcc.connectedPagesCount).toBe(2);
      expect(activeAcc.profilePictureUrl).toBe(
        'https://platform-lookaside.fbsbx.com/platform/profilepic/creator.jpg'
      );
      expect(activeAcc.gender).toBe('female');
      expect(activeAcc.accountLink).toBe(
        'https://www.facebook.com/app_scoped_user_id/fb_act_active/'
      );

      expect(expiredAcc.status).toBe('expired'); // Evaluated to expired
      expect(expiredAcc.connectedPagesCount).toBe(1);
      expect(expiredAcc.profilePictureUrl).toBeNull();
      expect(expiredAcc.gender).toBeNull();
      expect(expiredAcc.accountLink).toBeNull();

      // Zero token exposure assertion
      const rawString = JSON.stringify(json);
      expect(rawString).not.toContain('encryptedAccessToken');
      expect(rawString).not.toContain('accessToken');
    });

    it('persists expired status back to DB when an account token expiration has passed (ISSUE-24)', async () => {
      const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
      let accountUpdateExecuted = false;

      const mockDb = {
        query: vi.fn().mockImplementation((sql: string, params?: any[]) => {
          if (sql.includes('FROM workspaces')) {
            return Promise.resolve([{ id: 'ws_123' }]);
          }
          if (sql.includes('UPDATE social_accounts') && sql.includes("status = 'expired'")) {
            accountUpdateExecuted = true;
            return Promise.resolve([]);
          }
          if (sql.includes('FROM social_accounts')) {
            return Promise.resolve([
              {
                id: '44444444-4444-4444-a444-444444444444',
                fb_account_id: 'fb_act_expired_sync',
                display_name: 'Sync Expired Account',
                status: 'active', // In DB it is active
                token_expires_at: pastDate,
                connected_pages_count: 0,
                created_at: pastDate,
                updated_at: pastDate,
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      } as unknown as DatabaseClient;

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/accounts', {
        headers: { cookie: validSessionCookie },
      });

      const res = await handleListAccounts(req, 'acme', mockDb);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.accounts[0].status).toBe('expired');
      expect(accountUpdateExecuted).toBe(true);
    });

    it('persists expired status via Supabase client when an account token expiration has passed (ISSUE-24)', async () => {
      const pastDate = new Date(Date.now() - 3600 * 1000).toISOString();
      let supabaseAccountUpdated = false;

      const mockSupabase = {
        from: vi.fn((table: string) => {
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
            const builder: any = {
              // Audit N1: the list route now pages with chained
              // .order().order().range(), so order must return the
              // builder and range must resolve the page.
              order: vi.fn(() => builder),
              range: vi.fn().mockResolvedValue({
                data: [
                  {
                    id: '55555555-5555-5555-a555-555555555555',
                    external_account_id: 'fb_act_sb_expired',
                    display_name: 'SB Expired Account',
                    avatar_url: null,
                    metadata: {},
                    status: 'active',
                    token_expires_at: pastDate,
                    created_at: pastDate,
                    updated_at: pastDate,
                    destinations: [],
                  },
                ],
                error: null,
              }),
            };
            builder.eq = vi.fn(() => builder);
            return {
              select: vi.fn().mockReturnValue(builder),
              update: vi.fn((payload: any) => {
                if (payload.status === 'expired') {
                  supabaseAccountUpdated = true;
                }
                return {
                  eq: vi.fn().mockReturnValue({
                    eq: vi.fn().mockResolvedValue({ error: null }),
                  }),
                };
              }),
            };
          }
          return {};
        }),
      };

      const req = new NextRequest('http://localhost:3000/api/tenant/acme/accounts', {
        headers: { cookie: validSessionCookie },
      });

      const res = await handleListAccounts(req, 'acme', mockSupabase as any);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.accounts[0].status).toBe('expired');
      expect(supabaseAccountUpdated).toBe(true);
    });

    it('rejects cross-tenant access when user belongs to different subdomain', async () => {
      const mockDb = {
        query: vi.fn(),
      } as unknown as DatabaseClient;

      const req = new NextRequest(
        'http://localhost:3000/api/tenant/other-tenant/accounts',
        { headers: { cookie: validSessionCookie } }
      );

      const res = await handleListAccounts(req, 'other-tenant', mockDb);
      expect(res.status).toBe(403);
    });
  });
});
