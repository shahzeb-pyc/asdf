import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getSupabaseAdminClient,
  fetchWithAdminTimeout,
  SUPABASE_ADMIN_FETCH_TIMEOUT_MS,
  _resetMockSupabaseClients,
} from '../../src/lib/auth/clients';

/**
 * Spec 139: admin client must fail fast in production without a
 * service-role key (never silently degrade to the anon key), reuse a
 * cached singleton per resolved config, and bound requests with a
 * default fetch timeout.
 */
describe('getSupabaseAdminClient (spec 139)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    _resetMockSupabaseClients();
  });

  afterEach(() => {
    process.env = originalEnv;
    _resetMockSupabaseClients();
    vi.restoreAllMocks();
  });

  function setEnv(overrides: Record<string, string | undefined>): void {
    process.env = { ...process.env, ...overrides } as NodeJS.ProcessEnv;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete process.env[key];
      }
    }
  }

  /** A Supabase JWT carrying the given role claim (signature unverified, as in the factory check). */
  function jwtWithRole(role: string): string {
    const encode = (value: unknown): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'test', role })}.sig`;
  }

  describe('production fail-fast', () => {
    it('throws in production when only the anon key is set (no anon fallback)', () => {
      setEnv({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-value',
        SUPABASE_SERVICE_ROLE_KEY: undefined,
      });

      expect(() => getSupabaseAdminClient()).toThrow(
        /SUPABASE_SERVICE_ROLE_KEY are strictly required in production/
      );
    });

    it('throws in production when the service-role key is a placeholder', () => {
      setEnv({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-value',
        SUPABASE_SERVICE_ROLE_KEY: 'placeholder-service-role-key',
      });

      expect(() => getSupabaseAdminClient()).toThrow(
        /SUPABASE_SERVICE_ROLE_KEY are strictly required in production/
      );
    });

    it('throws in production when no Supabase keys are set at all', () => {
      setEnv({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: undefined,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
      });

      expect(() => getSupabaseAdminClient()).toThrow(
        /SUPABASE_SERVICE_ROLE_KEY are strictly required in production/
      );
    });

    it('returns a client in production when the service-role key is configured', () => {
      setEnv({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-value',
        SUPABASE_SERVICE_ROLE_KEY: jwtWithRole('service_role'),
      });

      expect(getSupabaseAdminClient()).not.toBeNull();
    });

    it('throws in production when the service-role slot holds an anon JWT (entitlement rebuild: the role claim must prove privilege)', () => {
      setEnv({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-value',
        SUPABASE_SERVICE_ROLE_KEY: jwtWithRole('anon'),
      });

      expect(() => getSupabaseAdminClient()).toThrow(/not a service-role key/);
    });

    it('throws in production when the service-role slot holds a non-JWT value', () => {
      setEnv({
        NODE_ENV: 'production',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-value',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value',
      });

      expect(() => getSupabaseAdminClient()).toThrow(/not a service-role key/);
    });
  });

  describe('non-production behaviour (preserved)', () => {
    it('falls back to the anon key outside production', () => {
      setEnv({
        NODE_ENV: 'test',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-value',
        SUPABASE_SERVICE_ROLE_KEY: undefined,
      });

      expect(getSupabaseAdminClient()).not.toBeNull();
    });

    it('returns null outside production when nothing is configured', () => {
      setEnv({
        NODE_ENV: 'test',
        NEXT_PUBLIC_SUPABASE_URL: undefined,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
        SUPABASE_SERVICE_ROLE_KEY: undefined,
      });

      expect(getSupabaseAdminClient()).toBeNull();
    });
  });

  describe('singleton caching', () => {
    it('returns the same instance for repeated calls with the same config', () => {
      setEnv({
        NODE_ENV: 'test',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value',
      });

      const first = getSupabaseAdminClient();
      const second = getSupabaseAdminClient();
      expect(first).not.toBeNull();
      expect(second).toBe(first);
    });

    it('rebuilds the client when the resolved config changes', () => {
      setEnv({
        NODE_ENV: 'test',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value',
      });
      const first = getSupabaseAdminClient();

      setEnv({ SUPABASE_SERVICE_ROLE_KEY: 'a-different-service-role-key' });
      const second = getSupabaseAdminClient();

      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
    });

    it('rebuilds the client after _resetMockSupabaseClients (the _resetAuthStores seam)', () => {
      setEnv({
        NODE_ENV: 'test',
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value',
      });
      const first = getSupabaseAdminClient();

      _resetMockSupabaseClients();
      const second = getSupabaseAdminClient();

      expect(second).not.toBeNull();
      expect(second).not.toBe(first);
    });
  });

  describe('fetch timeout', () => {
    it('exposes a sane server-side default timeout', () => {
      expect(SUPABASE_ADMIN_FETCH_TIMEOUT_MS).toBe(15_000);
    });

    it('supplies an AbortSignal when the caller provides none', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('ok'));

      await fetchWithAdminTimeout('https://example.supabase.co/rest/v1/');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal?.aborted).toBe(false);
    });

    it('keeps a caller-provided AbortSignal (per-call override wins)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('ok'));
      const controller = new AbortController();

      await fetchWithAdminTimeout('https://example.supabase.co/rest/v1/', {
        signal: controller.signal,
      });

      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(init.signal).toBe(controller.signal);
    });
  });
});
