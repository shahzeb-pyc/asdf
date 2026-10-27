import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { validateOtpServiceConfig, createPendingSignup, getPendingSignup } from '../../src/lib/otp-service';
import { handleGetPageInsights } from '../../src/app/api/tenant/[subdomain]/pages/[pageId]/insights/route';
import type { GraphFetchFn } from '../../src/lib/insights/page-insights';
import { signSessionToken, encryptToken, type DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('[ISSUE-25] Serverless State Hygiene & Distributed Cache Enforcement', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('OTP Service Serverless Configuration in Production', () => {
    it('throws in production when Supabase / distributed auth credentials are missing', () => {
      process.env = { ...process.env, NODE_ENV: 'production' };
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;

      expect(() => validateOtpServiceConfig()).toThrow(
        /Native Supabase Auth credentials .* are strictly required for authentication and OTP in production/
      );
    });

    it('passes in production when Supabase credentials are configured', () => {
      process.env = {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: 'https://xyz.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'valid-anon-key',
        SUPABASE_SERVICE_ROLE_KEY: 'valid-service-role-key',
      };

      expect(() => validateOtpServiceConfig()).not.toThrow();
    });

    it('warns in production when createPendingSignup fallback is invoked', async () => {
      process.env = {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: 'https://xyz.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'valid-anon-key',
      };

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // This test asserts only the fallback warning. The creation itself is
      // allowed to reject here: with no Upstash configured, the spec-139 B2
      // lockout check fails closed in production and denies the attempt.
      await createPendingSignup({
        name: 'Test Agent',
        phone: '+14155552671',
        email: 'agent.serverless@gmail.com',
        password: 'ValidPassword123!',
      }).catch(() => {});

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[OTP Service] Fallback in-memory pendingSignup used in production')
      );

      warnSpy.mockRestore();
    });
  });

  describe('Insights Live Proxy Serverless Execution (Spec 062)', () => {
    it('returns Cache-Control with no-cache headers in GET insights live proxy response (Spec 062)', async () => {
      process.env.SESSION_SECRET = TEST_SECRET;
      process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

      const userId = '11111111-1111-4111-a111-111111111111';
      const pageId = '22222222-2222-4222-a222-222222222222';
      const fbPageId = '846840138502516';

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

      const sampleEncryptedPageToken = await encryptToken(
        'mock_raw_fb_page_access_token_secret',
        TEST_ENCRYPTION_KEY
      );

      // Rebuilt 2026-10-27: the new proxy reads the destination row via a
      // Supabase-style client and fetches live Graph data (no server cache).
      const chainable = (result: unknown) => {
        const chain: Record<string, unknown> = {};
        chain.select = vi.fn(() => chain);
        chain.eq = vi.fn(() => chain);
        chain.maybeSingle = vi.fn(() => Promise.resolve(result));
        return chain;
      };
      const mockDb = {
        from: vi.fn((table: string) => {
          if (table === 'workspaces') return chainable({ data: { id: 'ws-1' }, error: null });
          return chainable({
            data: {
              id: pageId,
              external_destination_id: fbPageId,
              encrypted_destination_token: sampleEncryptedPageToken,
            },
            error: null,
          });
        }),
      } as unknown as DatabaseClient;

      const mockFetch = vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () =>
          url.includes('/insights?metric=page_follows_country')
            ? { data: [] }
            : url.includes('/insights?metric=page_media_view')
              ? { data: [] }
              : { followers_count: 28900 },
      }));

      const request = new NextRequest(
        `https://acme.fbuploadpro.com/api/tenant/acme/pages/${pageId}/insights?range=28d`,
        {
          headers: {
            cookie: `fbup_session=${token}`,
          },
        }
      );

      const res = await handleGetPageInsights(
        request,
        'acme',
        pageId,
        mockDb as never,
        mockFetch as unknown as GraphFetchFn,
      );

      expect(res.status).toBe(200);
      const cacheControl = res.headers.get('Cache-Control');
      expect(cacheControl).toBeDefined();
      expect(cacheControl).toContain('no-cache');
      expect(cacheControl).toContain('no-store');
    });
  });

  describe('Password Reset OTP Serverless Warning in Production', () => {
    it('warns in production when createPasswordResetOtp fallback is invoked', async () => {
      process.env = {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: 'https://xyz.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'valid-anon-key',
      };

      const { createPasswordResetOtp } = await import('../../src/lib/otp-service');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Same allowance as the signup case above: this asserts the warning;
      // the fail-closed production lockout may reject the creation itself.
      await createPasswordResetOtp('reset.agent@gmail.com').catch(() => {});

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[OTP Service] Fallback in-memory pendingPasswordReset used in production')
      );

      warnSpy.mockRestore();
    });
  });
});

