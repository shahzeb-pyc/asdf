import { NextResponse } from 'next/server';
import {
  getSessionSecret,
  getTokenEncryptionKey,
  type DatabaseClient,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { getB2Config, getR2Config } from '@/lib/storage';

export type HealthStatus = 'ok' | 'degraded' | 'unhealthy';

export interface HealthPayload {
  status: HealthStatus;
  timestamp: string;
  checks: {
    database: boolean;
    auth: boolean;
    config: boolean;
  };
}

export interface HealthProbeDeps {
  /** Injectable fetch for the Supabase Auth probe (tests). */
  fetchFn?: typeof fetch;
  /** Injectable env snapshot (tests). Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Injectable Auth probe override (tests). */
  checkAuth?: () => Promise<boolean>;
  /** Injectable config override (tests). */
  checkConfig?: () => boolean;
  /** Injectable DB probe override (tests). */
  checkDatabase?: () => Promise<boolean>;
}

const AUTH_PROBE_TIMEOUT_MS = 1000;
const DEV_FALLBACK_TOKEN_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function isPlaceholder(value: string | undefined): boolean {
  return !value || value.includes('placeholder');
}

/** Boolean only: is TOKEN_ENCRYPTION_KEY present and well-formed? Never returns the value or the failure reason. */
export function isTokenKeyConfigured(
  env: Record<string, string | undefined>
): boolean {
  const raw = env.TOKEN_ENCRYPTION_KEY;
  if (!raw || raw.trim().length === 0) return false;
  if (env.NODE_ENV === 'production' && raw.trim() === DEV_FALLBACK_TOKEN_KEY) {
    return false;
  }
  try {
    // Contracts parsing: throws when the key is unusable in production mode.
    getTokenEncryptionKey({ TOKEN_ENCRYPTION_KEY: raw, NODE_ENV: 'production' });
  } catch {
    return false;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 64 && /^[0-9a-fA-F]+$/.test(trimmed)) return true;
  return new TextEncoder().encode(trimmed).length === 32;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) {
    end--;
  }
  return value.slice(0, end);
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function defaultCheckConfig(env: Record<string, string | undefined>): boolean {
  let sessionOk = false;
  try {
    getSessionSecret(env);
    sessionOk = true;
  } catch {
    sessionOk = false;
  }
  const tokenOk = isTokenKeyConfigured(env);
  // Storage is healthy when the ACTIVE backend is configured: R2, B2,
  // or both (spec 259). Either backend alone is enough.
  const storageOk =
    env === (process.env as Record<string, string | undefined>)
      ? getR2Config() !== null || getB2Config() !== null
      : Boolean(
          (env.R2_ACCOUNT_ID &&
            env.R2_ACCESS_KEY_ID &&
            env.R2_SECRET_ACCESS_KEY &&
            env.R2_BUCKET_NAME &&
            env.R2_PUBLIC_URL &&
            isValidUrl(env.R2_PUBLIC_URL)) ||
            (env.B2_APPLICATION_KEY_ID &&
              env.B2_APPLICATION_KEY &&
              env.B2_BUCKET_NAME &&
              env.B2_REGION)
        );
  return sessionOk && tokenOk && storageOk;
}

/**
 * Supabase Auth reachability probe: GET {SUPABASE_URL}/auth/v1/health
 * (the GoTrue health endpoint) with the anon key, 1s budget. Boolean only.
 */
async function defaultCheckAuth(
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch
): Promise<boolean> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL || env.SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
  if (!url || !anonKey || isPlaceholder(url) || isPlaceholder(anonKey)) {
    return false;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${trimTrailingSlashes(url)}/auth/v1/health`, {
      method: 'GET',
      headers: { apikey: anonKey },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeDatabaseWithTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  isFailure: (result: T) => boolean
): Promise<boolean> {
  let timerId: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error('Health probe timeout exceeded budget')),
        timeoutMs
      );
    });
    const result = await Promise.race([run(), timeoutPromise]);
    return !isFailure(result);
  } catch {
    return false;
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

export async function probeHealth(
  client?: DatabaseClient,
  timeoutMs = 2000,
  deps?: HealthProbeDeps
): Promise<{ statusCode: number; payload: HealthPayload }> {
  const timestamp = new Date().toISOString();
  const env = deps?.env ?? (process.env as Record<string, string | undefined>);
  const fetchFn = deps?.fetchFn ?? fetch;

  let database: boolean;
  if (deps?.checkDatabase) {
    database = await deps.checkDatabase();
  } else if (client) {
    database = await probeDatabaseWithTimeout(
      () => client.query('SELECT 1'),
      timeoutMs,
      () => false
    );
  } else if (isPlaceholder(env.SUPABASE_SERVICE_ROLE_KEY)) {
    // Masking fix: getSupabaseAdminClient() falls back to the anon key when
    // the service-role key is missing, which would report a broken service
    // key as healthy. The health probe refuses to trust that fallback.
    console.error('Diagnostic probe failure: service-role key is not configured');
    database = false;
  } else {
    database = await probeDatabaseWithTimeout(
      async () => {
        const supabase = getSupabaseAdminClient();
        if (!supabase) throw new Error('Supabase client is not configured');
        return await supabase
          .from('workspaces')
          .select('id', { head: true, count: 'exact' });
      },
      timeoutMs,
      (result) => Boolean((result as { error?: unknown }).error)
    );
    if (!database) {
      console.error('Diagnostic probe failure: database probe did not succeed');
    }
  }

  const auth = deps?.checkAuth
    ? await deps.checkAuth()
    : await defaultCheckAuth(env, fetchFn);
  const config = deps?.checkConfig
    ? deps.checkConfig()
    : defaultCheckConfig(env);

  const ok = database && auth && config;
  return {
    statusCode: ok ? 200 : 503,
    payload: {
      status: ok ? 'ok' : 'unhealthy',
      timestamp,
      checks: { database, auth, config },
    },
  };
}

export async function GET() {
  const result = await probeHealth();
  return NextResponse.json(result.payload, {
    status: result.statusCode,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}
