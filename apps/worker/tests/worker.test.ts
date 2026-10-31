import { describe, expect, it, vi, afterEach } from 'vitest';
import worker, { handleScheduled, type Env } from '../src/index.js';

const VALID_WORKER_TOKEN_KEY =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

function healthyWorkerDb() {
  return {
    from: vi.fn(() => ({
      select: vi.fn().mockResolvedValue({ error: null }),
    })),
  };
}

function healthyWorkerEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    TOKEN_ENCRYPTION_KEY: VALID_WORKER_TOKEN_KEY,
    __TEST_DB__: healthyWorkerDb(),
    ...overrides,
  };
}

describe('Cloudflare Worker Health Probing', () => {
  const dummyCtx = {} as ExecutionContext;

  it('GET /health returns 200 OK with boolean checks when DB and config pass', async () => {
    const request = new Request('https://worker.internal/health', {
      method: 'GET',
    });

    const response = await worker.fetch(request, healthyWorkerEnv(), dummyCtx);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const data = (await response.json()) as Record<string, unknown>;
    expect(data.status).toBe('ok');
    expect(data.worker).toBe('fbuploadpro-worker');
    expect(data.checks).toEqual({ database: true, config: true, heartbeat: true });
    expect(Object.keys(data).sort()).toEqual(['checks', 'status', 'timestamp', 'worker']);
    expect(new Date(String(data.timestamp)).getTime()).not.toBeNaN();
  });

  it('GET /health returns 503 when TOKEN_ENCRYPTION_KEY is removed', async () => {
    const env = healthyWorkerEnv();
    delete env.TOKEN_ENCRYPTION_KEY;
    const request = new Request('https://worker.internal/health', { method: 'GET' });

    const response = await worker.fetch(request, env, dummyCtx);
    expect(response.status).toBe(503);
    const data = (await response.json()) as { status: string; checks: Record<string, boolean> };
    expect(data.status).toBe('unhealthy');
    expect(data.checks).toEqual({ database: true, config: false, heartbeat: true });
  });

  it('GET /health returns 503 and leaks no detail when the database probe fails', async () => {
    const failingDb = {
      from: vi.fn(() => ({
        select: vi
          .fn()
          .mockResolvedValue({ error: new Error('connect postgres://admin:secretpw@10.0.0.1/db') }),
      })),
    };
    const env = healthyWorkerEnv({ __TEST_DB__: failingDb });
    const request = new Request('https://worker.internal/health', { method: 'GET' });

    const response = await worker.fetch(request, env, dummyCtx);
    expect(response.status).toBe(503);
    const text = await response.text();
    const data = JSON.parse(text) as { status: string; checks: Record<string, boolean> };
    expect(data.checks.database).toBe(false);
    expect(text).not.toContain('secretpw');
    expect(text).not.toContain('10.0.0.1');
    expect(text).not.toContain('postgres://');
  });

  it('GET /health returns 503 when the database is unconfigured', async () => {
    const env: Env = { ENVIRONMENT: 'test' };
    const request = new Request('https://worker.internal/health', { method: 'GET' });

    const response = await worker.fetch(request, env, dummyCtx);
    expect(response.status).toBe(503);
    const data = (await response.json()) as { checks: Record<string, boolean> };
    expect(data.checks).toEqual({ database: false, config: false, heartbeat: false });
  });

  it('unhandled routes return 404 Not Found fallback', async () => {
    const request = new Request('https://worker.internal/unknown-endpoint', {
      method: 'GET',
    });

    const response = await worker.fetch(request, healthyWorkerEnv(), dummyCtx);
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toBe('application/json');

    const data = await response.json();
    expect(data).toEqual({
      error: 'Not Found',
    });
  });

  // Spec 139: /health must not report healthy when the claimer is dead.
  function heartbeatDb(lastSuccessAt: string | null, hasRow = true) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'worker_heartbeats') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: hasRow ? { last_success_at: lastSuccessAt } : null,
                  error: null,
                })),
              })),
            })),
          };
        }
        return {
          select: vi.fn().mockResolvedValue({ error: null }),
        };
      }),
    };
  }

  it('GET /health returns 503 when the heartbeat is stale (>180s since last success)', async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const env = healthyWorkerEnv({ __TEST_DB__: heartbeatDb(stale) });
    const request = new Request('https://worker.internal/health', { method: 'GET' });
    const response = await worker.fetch(request, env, dummyCtx);
    expect(response.status).toBe(503);
    const data = (await response.json()) as { status: string; checks: Record<string, boolean> };
    expect(data.status).toBe('unhealthy');
    expect(data.checks).toEqual({ database: true, config: true, heartbeat: false });
  });

  it('GET /health returns 200 when the heartbeat is fresh', async () => {
    const fresh = new Date(Date.now() - 10 * 1000).toISOString();
    const env = healthyWorkerEnv({ __TEST_DB__: heartbeatDb(fresh) });
    const request = new Request('https://worker.internal/health', { method: 'GET' });
    const response = await worker.fetch(request, env, dummyCtx);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { checks: Record<string, boolean> };
    expect(data.checks.heartbeat).toBe(true);
  });

  it('GET /health degrades gracefully on cold start (no heartbeat row yet)', async () => {
    const env = healthyWorkerEnv({ __TEST_DB__: heartbeatDb(null, false) });
    const request = new Request('https://worker.internal/health', { method: 'GET' });
    const response = await worker.fetch(request, env, dummyCtx);
    expect(response.status).toBe(200);
    const data = (await response.json()) as { checks: Record<string, boolean> };
    expect(data.checks.heartbeat).toBe(true);
  });

  it('non-GET methods on /health return 404 Not Found', async () => {
    const request = new Request('https://worker.internal/health', {
      method: 'POST',
    });

    const response = await worker.fetch(request, healthyWorkerEnv(), dummyCtx);
    expect(response.status).toBe(404);
  });
});

describe('Worker Heartbeat (Spec 116)', () => {
  const controller = {
    cron: '* * * * *',
    scheduledTime: Date.now(),
    noRetry: () => {},
  } as unknown as ScheduledController;
  const ctx = {} as ExecutionContext;

  function heartbeatCaptureDb() {
    const upserts: Record<string, unknown>[] = [];
    // ADU tick talks Supabase chains, not rpc: model an empty store
    // so every ADU stage is a no-op success. The heartbeat table
    // keeps its recording upsert.
    const aduChain: any = {
      select: () => aduChain,
      eq: () => aduChain,
      lt: () => aduChain,
      gt: () => aduChain,
      order: () => aduChain,
      limit: () => aduChain,
      update: () => aduChain,
      insert: () => aduChain,
      delete: () => aduChain,
      in: () => aduChain,
      single: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        resolve({ data: [], error: null });
      },
    };
    const db = {
      from: vi.fn((table: string) => {
        if (table === 'worker_heartbeats') {
          return {
            upsert: vi.fn(async (row: Record<string, unknown>) => {
              upserts.push(row);
              return { error: null };
            }),
          };
        }
        return aduChain;
      }),
      query: vi.fn().mockResolvedValue([]),
      // Spec 122 superseded the empty-registry assumption in the test
      // below: the default registry now registers Facebook, so a claim
      // tick calls the claim RPC (returning no due items here).
      rpc: vi.fn(async () => ({ data: [], error: null })),
    };
    return { db, upserts };
  }

  it('records a heartbeat with the skip reason when TOKEN_ENCRYPTION_KEY is missing', async () => {
    const { db, upserts } = heartbeatCaptureDb();
    const env: Env = { ENVIRONMENT: 'test' };

    await handleScheduled(controller, env, ctx, { db: db as never });

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.worker_name).toBe('fbuploadpro-worker');
    expect(upserts[0]?.last_skip_reason).toBe('missing_token_encryption_key');
    expect(upserts[0]?.last_success_at).toBeUndefined();
    expect(typeof upserts[0]?.last_run_at).toBe('string');
  });

  it('records a success heartbeat with claimed/enqueued counts after a claimer tick', async () => {
    const { db, upserts } = heartbeatCaptureDb();
    const env: Env = {
      ENVIRONMENT: 'test',
      TOKEN_ENCRYPTION_KEY: VALID_WORKER_TOKEN_KEY,
    };

    // Spec 122: the default registry registers Facebook, so the tick
    // needs lane queue producers (previously the empty registry meant
    // no lane was ever entered and no queues were required).
    const queues = {
      fast: { sendBatch: vi.fn(async () => undefined) },
      heavy: { sendBatch: vi.fn(async () => undefined) },
    };
    await handleScheduled(controller, env, ctx, { db: db as never, queues });

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.last_skip_reason).toBeNull();
    expect(typeof upserts[0]?.last_success_at).toBe('string');
    expect(upserts[0]?.last_claimed_count).toBe(0);
    // Spec 139: a full tick write omits last_settled_count when unset —
    // forcing 0 wiped the publish consumers' settled count every tick.
    expect(upserts[0]?.last_settled_count).toBeUndefined();
    // Spec 121: per-lane enqueued counters ride the tick heartbeat.
    expect(upserts[0]?.last_enqueued_fast).toBe(0);
    expect(upserts[0]?.last_enqueued_heavy).toBe(0);
  });
});

describe('Spec 139: scheduled-wrapper error capture uses waitUntil', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('captures a claim-tick failure via PostHog with ctx.waitUntil and still heartbeats claim_error', async () => {
    const controller = {
      cron: '* * * * *',
      scheduledTime: Date.now(),
      noRetry: () => {},
    } as unknown as ScheduledController;
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const waitUntil = vi.fn((_p: Promise<unknown>) => {});
    const ctx = { waitUntil, passThroughOnException: () => {} } as unknown as ExecutionContext;

    const upserts: Record<string, unknown>[] = [];
    const db = {
      from: vi.fn(() => ({
        upsert: vi.fn(async (row: Record<string, unknown>) => {
          upserts.push(row);
          return { error: null };
        }),
      })),
      rpc: vi.fn(async () => ({ data: [], error: null })),
    };
    const registry = {
      platforms: () => {
        throw new Error('registry boom');
      },
    };
    const env: Env = {
      ENVIRONMENT: 'test',
      TOKEN_ENCRYPTION_KEY: VALID_WORKER_TOKEN_KEY,
      POSTHOG_KEY: 'test-key',
    };

    await expect(
      handleScheduled(controller, env, ctx, {
        db: db as never,
        registry: registry as never,
      })
    ).rejects.toThrow('registry boom');

    expect(fetchMock).toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalled();
    expect(upserts.some((r) => r.last_skip_reason === 'claim_error')).toBe(true);
  });
});
