/**
 * Spec 168 — regression: password login must not poison the admin client.
 * REAL supabase-js clients + stubbed fetch (no live Supabase): canned
 * /auth/v1/token session; PostgREST/RPC calls record their Authorization header.
 * The negative control proves the test can catch the bug.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetMockSupabaseClients, getSupabaseAdminClient, getSupabaseAuthClient } from './clients';

const URL = 'https://spec168-test.supabase.co';
const SERVICE_KEY = 'spec168-service-role-key';
const ANON_KEY = 'spec168-anon-key';
const USER_JWT = 'spec168-user-jwt';
const SESSION = { access_token: USER_JWT, token_type: 'Bearer', expires_in: 3600, refresh_token: 'spec168-refresh', user: { id: '11111111-1111-4111-a111-111111111111', email: 'client@gmail.com', user_metadata: {}, app_metadata: {}, aud: 'authenticated', created_at: '2026-11-11T00:00:00Z' } };

function authzOf(init?: RequestInit): string | null {
  const h = init?.headers;
  if (!h) return null;
  if (typeof (h as Headers).get === 'function') return (h as Headers).get('Authorization');
  const r = h as Record<string, string>;
  return r.Authorization ?? r.authorization ?? null;
}

function stubFetch(seen: string[]) {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url?: unknown }).url ?? input);
    if (url.includes('/auth/v1/token')) return json(SESSION);
    if (url.includes('/rest/v1/')) {
      const a = authzOf(init);
      if (a) seen.push(a);
      return json([]);
    }
    return json({});
  });
}

describe('spec 168: admin client is not poisoned by password login', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    _resetMockSupabaseClients();
  });

  it('login via the auth client leaves the admin client on the service key', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', stubFetch(seen));
    const authClient = getSupabaseAuthClient();
    const adminClient = getSupabaseAdminClient();
    expect(authClient).not.toBeNull();
    expect(adminClient).not.toBeNull();
    const { error } = await authClient!.auth.signInWithPassword({ email: 'client@gmail.com', password: 'correct-password' });
    expect(error).toBeNull();
    expect((await adminClient!.rpc('adu_hub_list', {})).error).toBeNull();
    expect(seen).toContain(`Bearer ${SERVICE_KEY}`);
    expect(seen).not.toContain(`Bearer ${USER_JWT}`);
  });

  it('NEGATIVE CONTROL: sign-in ON the admin client sends the user JWT to the DB', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', stubFetch(seen));
    const adminClient = getSupabaseAdminClient();
    expect(adminClient).not.toBeNull();
    const { error } = await adminClient!.auth.signInWithPassword({ email: 'client@gmail.com', password: 'correct-password' });
    expect(error).toBeNull();
    await adminClient!.rpc('adu_hub_list', {});
    expect(seen).toContain(`Bearer ${USER_JWT}`);
  });

  it('getSupabaseAuthClient is fresh per call and null without config', () => {
    expect(getSupabaseAuthClient()).not.toBe(getSupabaseAuthClient());
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    expect(getSupabaseAuthClient()).toBeNull();
  });
});
