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
