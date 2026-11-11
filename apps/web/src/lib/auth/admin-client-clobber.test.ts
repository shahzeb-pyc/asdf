/**
 * Spec 168 — regression: password login must not poison the admin client.
 * REAL supabase-js clients + stubbed fetch (no live Supabase): canned
 * /auth/v1/token session per login email; PostgREST/RPC calls record their
 * Authorization header. Workspaces stub models RLS auth.uid() = owner_id:
 * B's row is visible to the service key and to B, invisible to A (cross-user
 * poison returns zero rows — the case-1 404).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetMockSupabaseClients, getSupabaseAdminClient, getSupabaseAuthClient } from './clients';

const URL = 'https://spec168-test.supabase.co';
const SERVICE_KEY = 'spec168-service-role-key', ANON_KEY = 'spec168-anon-key';
const JWT_A = 'spec168-user-a-jwt', JWT_B = 'spec168-user-b-jwt';
const USER_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', USER_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKSPACE_B = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', subdomain: 'acme-b', owner_id: USER_B_ID };
const SESSION = { access_token: JWT_A, token_type: 'Bearer', expires_in: 3600, refresh_token: 'spec168-refresh', user: { id: USER_A_ID, email: 'admin@example.com', user_metadata: {}, app_metadata: {}, aud: 'authenticated', created_at: '2026-11-11T00:00:00Z' } };

function authzOf(init?: RequestInit): string | null {
  return init?.headers ? new Headers(init.headers).get('Authorization') : null;
}

function stubFetch(seen: string[]) {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url?: unknown }).url ?? input);
    if (url.includes('/auth/v1/token')) {
      const email = (JSON.parse(String(init?.body ?? '{}')) as { email?: string }).email ?? ''; const isA = email.startsWith('admin@');      return json({ ...SESSION, access_token: isA ? JWT_A : JWT_B, user: { ...SESSION.user, id: isA ? USER_A_ID : USER_B_ID, email } });
    }
    if (url.includes('/rest/v1/')) {
      const a = authzOf(init);
      if (a) seen.push(a);
      if (url.includes('/rest/v1/workspaces')) {
        return json(a === `Bearer ${SERVICE_KEY}` || a === `Bearer ${JWT_B}` ? [WORKSPACE_B] : []);
      }
      return json([]);
    }
    return json({});
  });
}

describe('spec 168: admin client is not poisoned by password login', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', URL); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON_KEY);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); _resetMockSupabaseClients(); });

  it('login via the auth client leaves the admin client on the service key', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', stubFetch(seen));
    const authClient = getSupabaseAuthClient();
    const adminClient = getSupabaseAdminClient();
    expect(authClient).not.toBeNull(); expect(adminClient).not.toBeNull();
    const { error } = await authClient!.auth.signInWithPassword({ email: 'client@gmail.com', password: 'correct-password' });
    expect(error).toBeNull();
    expect((await adminClient!.rpc('adu_hub_list', {})).error).toBeNull();
    expect(seen).toContain(`Bearer ${SERVICE_KEY}`);
    expect(seen).not.toContain(`Bearer ${JWT_B}`);
  });

  it('cross-user: login as A cannot leak into B\'s workspace lookup', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', stubFetch(seen));
    const authClient = getSupabaseAuthClient();
    const adminClient = getSupabaseAdminClient();
    const { error } = await authClient!.auth.signInWithPassword({ email: 'admin@example.com', password: 'correct-password' });
    expect(error).toBeNull();
    const { data, error: lookupError } = await adminClient!.from('workspaces').select('id, subdomain').eq('owner_id', USER_B_ID);
    expect(lookupError).toBeNull(); expect(data).toEqual([WORKSPACE_B]);
    expect(seen).toContain(`Bearer ${SERVICE_KEY}`);
    expect(seen).not.toContain(`Bearer ${JWT_A}`);
  });

  it('NEGATIVE CONTROL: old wiring leaks A\'s JWT into B\'s lookup (case-1 404)', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', stubFetch(seen));
    const adminClient = getSupabaseAdminClient();
    const { error } = await adminClient!.auth.signInWithPassword({ email: 'admin@example.com', password: 'correct-password' });
    expect(error).toBeNull();
    await adminClient!.rpc('adu_hub_list', {});
    expect(seen).toContain(`Bearer ${JWT_A}`);
    const { data } = await adminClient!.from('workspaces').select('id, subdomain').eq('owner_id', USER_B_ID);
    expect(data).toEqual([]);
  });

  it('getSupabaseAuthClient is fresh per call and null without config', () => {
    expect(getSupabaseAuthClient()).not.toBe(getSupabaseAuthClient());
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    expect(getSupabaseAuthClient()).toBeNull();
  });
});
