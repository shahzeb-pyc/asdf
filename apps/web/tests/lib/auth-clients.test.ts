/**
 * @file auth-clients.test.ts
 * @description Privilege proof for the Supabase admin client
 * (entitlement rebuild): a non-service key in the service-role slot
 * must fail loudly in production instead of building a client that
 * silently reads zero rows under RLS — zero rows is exactly what
 * "Free" looks like, so an unchecked key turns every paid user Free.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetMockSupabaseClients,
  getSupabaseAdminClient,
  getSupabaseKeyRole,
} from '@/lib/auth/clients';

function makeKey(role: string | null): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload: Record<string, unknown> = { sub: 'test', iss: 'https://ref.supabase.co/auth/v1' };
  if (role !== null) payload.role = role;
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`;
}

const SAVED_ENV = { ...process.env };

beforeEach(() => {
  _resetMockSupabaseClients();
  vi.unstubAllEnvs();
});

afterEach(() => {
  const restore = (key: string, saved: string | undefined): void => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  };
  restore('NEXT_PUBLIC_SUPABASE_URL', SAVED_ENV.NEXT_PUBLIC_SUPABASE_URL);
  restore('SUPABASE_SERVICE_ROLE_KEY', SAVED_ENV.SUPABASE_SERVICE_ROLE_KEY);
  restore('NEXT_PUBLIC_SUPABASE_ANON_KEY', SAVED_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  _resetMockSupabaseClients();
  vi.unstubAllEnvs();
});

describe('getSupabaseKeyRole', () => {
  it('reads service_role from a service key', () => {
    expect(getSupabaseKeyRole(makeKey('service_role'))).toBe('service_role');
  });

  it('reads anon from an anon key', () => {
    expect(getSupabaseKeyRole(makeKey('anon'))).toBe('anon');
  });

  it('returns null for a non-JWT value', () => {
    expect(getSupabaseKeyRole('not-a-jwt')).toBeNull();
    expect(getSupabaseKeyRole('sbp_somepublishablekey')).toBeNull();
  });

  it('returns null when the payload carries no role claim', () => {
    expect(getSupabaseKeyRole(makeKey(null))).toBeNull();
  });

  it('returns null for malformed base64 payloads', () => {
    expect(getSupabaseKeyRole('eyJhbGciOiJIUzI1NiJ9.!!!.sig')).toBeNull();
  });
});

describe('getSupabaseAdminClient privilege proof (production)', () => {
  function useProductionEnv(key: string): void {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://ref.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = key;
  }

  it('throws for an anon key in the service-role slot', () => {
    useProductionEnv(makeKey('anon'));
    expect(() => getSupabaseAdminClient()).toThrow(/not a service-role key/);
  });

  it('throws for a non-JWT key in the service-role slot', () => {
    useProductionEnv('not-a-jwt');
    expect(() => getSupabaseAdminClient()).toThrow(/not a service-role key/);
  });

  it('throws for a placeholder key in the service-role slot', () => {
    useProductionEnv('placeholder-service-key');
    expect(() => getSupabaseAdminClient()).toThrow();
  });

  it('builds a client for a genuine service-role key', () => {
    useProductionEnv(makeKey('service_role'));
    expect(getSupabaseAdminClient()).not.toBeNull();
  });
});

describe('getSupabaseAdminClient outside production (unchanged)', () => {
  it('keeps the dev fallback: an anon key still builds a client locally', () => {
    vi.stubEnv('NODE_ENV', 'test');
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://ref.supabase.co';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = makeKey('anon');
    expect(getSupabaseAdminClient()).not.toBeNull();
  });

  it('returns null when no key exists outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://ref.supabase.co';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(getSupabaseAdminClient()).toBeNull();
  });
});
