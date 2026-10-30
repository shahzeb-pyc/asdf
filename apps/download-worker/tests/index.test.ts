import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownloadQueueMessage } from '@fbuploadpro/contracts';
import worker, { type DownloadWorkerEnv } from '../src/index.js';
import { FakeBucket, JOB_ID, USER_ID } from './fakes.js';

const SECRET = 'test-enqueue-secret';

/** Make the dead Supabase endpoint fail fast instead of waiting out the 15 s store timeout. */
function stubDeadNetwork(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockRejectedValue(new Error('connection refused'))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Supabase pointed at a refused local port: store calls fail fast, never hang. */
function makeEnv(overrides: Partial<DownloadWorkerEnv> = {}): DownloadWorkerEnv {
  return {
    MEDIA_BUCKET: new FakeBucket() as unknown as R2Bucket,
    DOWNLOAD_QUEUE: {
      send: async () => undefined,
      sendBatch: async () => undefined,
    } as unknown as Queue,
    SUPABASE_URL: 'http://127.0.0.1:1',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    DOWNLOAD_ENQUEUE_SECRET: SECRET,
    R2_PUBLIC_URL: 'https://media.example.test',
    ...overrides,
  };
}

function enqueueRequest(body: unknown, secret: string | null = SECRET): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (secret !== null) headers.set('x-download-enqueue-secret', secret);
  return new Request('https://worker.example.test/enqueue', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('worker fetch /enqueue', () => {
  it('404s anything that is not POST /enqueue', async () => {
    const response = await worker.fetch(
      new Request('https://worker.example.test/health'),
      makeEnv()
    );
    expect(response.status).toBe(404);
  });

  it('500s when a required binding or secret is missing', async () => {
    const env = makeEnv({ SUPABASE_SERVICE_ROLE_KEY: '' });
    const response = await worker.fetch(enqueueRequest({ jobIds: [JOB_ID] }), env);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('SUPABASE_SERVICE_ROLE_KEY'),
    });
  });

  it('401s a missing or wrong enqueue secret', async () => {
    const env = makeEnv();
    expect(
      (await worker.fetch(enqueueRequest({ jobIds: [JOB_ID] }, null), env)).status
    ).toBe(401);
    expect(
      (await worker.fetch(enqueueRequest({ jobIds: [JOB_ID] }, 'wrong'), env)).status
    ).toBe(401);
  });

  it('400s an invalid enqueue body', async () => {
    const env = makeEnv();
    const response = await worker.fetch(enqueueRequest({ jobIds: ['not-a-uuid'] }), env);
    expect(response.status).toBe(400);
  });

  it('returns 200 with enqueued 0 when the job row cannot be read — never fails the batch', async () => {
    // The store points at a refused port, so fetchJob fails per job;
    // the handler logs and still answers 200 (the web submit must
    // never fail because the consumer is unreachable).
    stubDeadNetwork();
    const env = makeEnv();
    const response = await worker.fetch(enqueueRequest({ jobIds: [JOB_ID] }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enqueued: 0 });
  });
});

describe('worker queue', () => {
  it('throws on a malformed message so the Queue retries it into the DLQ', async () => {
    const batch = {
      queue: 'download-jobs',
      messages: [{ body: { jobId: 'not-a-uuid', userId: USER_ID } }],
    } as unknown as MessageBatch<DownloadQueueMessage>;
    await expect(worker.queue(batch, makeEnv())).rejects.toThrow(/Malformed/);
  });

  it('throws when a required binding is missing instead of acking the batch', async () => {
    const batch = {
      queue: 'download-jobs',
      messages: [{ body: { jobId: JOB_ID, userId: USER_ID } }],
    } as unknown as MessageBatch<DownloadQueueMessage>;
    const env = makeEnv({ MEDIA_BUCKET: undefined as unknown as R2Bucket });
    await expect(worker.queue(batch, env)).rejects.toThrow(/misconfigured/);
  });

  it('acks a malformed DLQ message without throwing', async () => {
    const batch = {
      queue: 'download-jobs-dlq',
      messages: [{ body: { jobId: 'not-a-uuid', userId: USER_ID } }],
    } as unknown as MessageBatch<DownloadQueueMessage>;
    await expect(worker.queue(batch, makeEnv())).resolves.toBeUndefined();
  });
});

describe('worker scheduled', () => {
  it('never throws when every cron step fails (dead DB)', async () => {
    stubDeadNetwork();
    await expect(
      worker.scheduled({} as unknown as ScheduledEvent, makeEnv())
    ).resolves.toBeUndefined();
  });

  it('throws when a required binding is missing', async () => {
    const env = makeEnv({ DOWNLOAD_QUEUE: undefined as unknown as Queue });
    await expect(
      worker.scheduled({} as unknown as ScheduledEvent, env)
    ).rejects.toThrow(/misconfigured/);
  });
});

describe('worker fetch /enqueue and cron gaps', () => {
  it('500s listing every missing binding and secret', async () => {
    const env = makeEnv({
      SUPABASE_URL: '',
      SUPABASE_SERVICE_ROLE_KEY: '',
      DOWNLOAD_ENQUEUE_SECRET: '',
      R2_PUBLIC_URL: '',
    });
    const response = await worker.fetch(enqueueRequest({ jobIds: [JOB_ID] }), env);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string };
    for (const name of [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'DOWNLOAD_ENQUEUE_SECRET',
      'R2_PUBLIC_URL',
    ]) {
      expect(body.error).toContain(name);
    }
  });

  it('400s a body that is not JSON', async () => {
    const env = makeEnv();
    const request = new Request('https://worker.example.test/enqueue', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-download-enqueue-secret': SECRET,
      },
      body: 'not json',
    });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON' });
  });

  it('enqueues a still-queued job and reports enqueued 1', async () => {
    const sent: unknown[] = [];
    const row = {
      id: JOB_ID,
      user_id: USER_ID,
      source_url: 'https://cdn.example.com/v.mp4',
      source_platform: 'direct',
      target_folder_id: null,
      status: 'queued',
      progress_percent: 0,
      total_bytes: null,
      downloaded_bytes: 0,
      media_id: null,
      error_code: null,
      error_message: null,
      attempts: 0,
      claimed_at: null,
      claimed_by: null,
      created_at: '2026-10-30T00:00:00.000Z',
      updated_at: '2026-10-30T00:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(row), { status: 200 }))
    );
    const env = makeEnv({
      DOWNLOAD_QUEUE: {
        send: async (message: unknown) => {
          sent.push(message);
        },
        sendBatch: async () => undefined,
      } as unknown as Queue,
    });
    const response = await worker.fetch(enqueueRequest({ jobIds: [JOB_ID] }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enqueued: 1 });
    expect(sent).toEqual([{ jobId: JOB_ID, userId: USER_ID }]);
  });
});

describe('worker queue extractor URL validation', () => {
  const batch = {
    queue: 'download-jobs',
    messages: [{ body: { jobId: JOB_ID, userId: USER_ID } }],
  } as unknown as MessageBatch<DownloadQueueMessage>;

  it('rejects a non-https extractor URL before processing', async () => {
    const env = makeEnv({ DOWNLOADER_EXTRACTOR_API_URL: 'http://ext.example.com' });
    await expect(worker.queue(batch, env)).rejects.toThrow(/must be https/);
  });

  it('rejects an https extractor URL pointing at a private address', async () => {
    const env = makeEnv({ DOWNLOADER_EXTRACTOR_API_URL: 'https://127.0.0.1/x' });
    await expect(worker.queue(batch, env)).rejects.toThrow(/rejected/);
  });

  it('trims a valid extractor URL instead of rejecting it', async () => {
    const env = makeEnv({ DOWNLOADER_EXTRACTOR_API_URL: '  https://ext.example.com  ' });
    // A malformed message still throws its own validation error, which
    // proves the extractor URL itself passed validation.
    const bad = {
      queue: 'download-jobs',
      messages: [{ body: { jobId: 'not-a-uuid', userId: USER_ID } }],
    } as unknown as MessageBatch<DownloadQueueMessage>;
    await expect(worker.queue(bad, env)).rejects.toThrow(/Malformed/);
  });
});

describe('worker scheduled success path', () => {
  it('sweeps a queued job into the Queue when its user has a free slot', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (url.includes('/rest/v1/download_worker_heartbeats')) {
          return new Response(JSON.stringify([{}]), { status: 200 });
        }
        if (url.includes('/rest/v1/media_download_jobs') && method === 'HEAD') {
          return new Response(null, { headers: { 'content-range': '*/0' } });
        }
        if (url.includes('/rest/v1/media_download_jobs') && method === 'GET') {
          return new Response(JSON.stringify([{ id: JOB_ID, user_id: USER_ID }]), {
            status: 200,
          });
        }
        if (url.includes('/rest/v1/media_download_jobs') && method === 'PATCH') {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      })
    );
    const env = makeEnv({
      DOWNLOAD_QUEUE: {
        send: async (message: unknown) => {
          sent.push(message);
        },
        sendBatch: async () => undefined,
      } as unknown as Queue,
    });
    await expect(
      worker.scheduled({} as unknown as ScheduledEvent, env)
    ).resolves.toBeUndefined();
    expect(sent).toEqual([{ jobId: JOB_ID, userId: USER_ID }]);
  });
});
