/**
 * Download jobs API tests (spec 149): POST submits jobs, GET reports
 * open jobs for the tray, retry/cancel mutate job state. The database
 * is an in-memory Supabase-shaped fake — no live Supabase, no engine
 * runs, no media is downloaded. Auth uses a real signed session
 * cookie against the test SESSION_SECRET, exactly like production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  handleCancelDownloadJob,
  handleGetDownloadJobs,
  handleRetryDownloadJob,
  handleSubmitDownloadJobs,
} from '../../src/app/api/tenant/[subdomain]/downloader/route';
import { POST as retryPost } from '../../src/app/api/tenant/[subdomain]/downloader/retry/route';
import { POST as cancelPost } from '../../src/app/api/tenant/[subdomain]/downloader/cancel/route';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const USER_ID = '11111111-1111-4111-a111-111111111111';
const FOLDER_ID = '33333333-3333-4333-a333-333333333333';
const SUBDOMAIN = 'acme';

type Row = Record<string, unknown>;

function fakeUuid(n: number): string {
  return `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

class FakeBuilder {
  private mode: 'select' | 'insert' | 'update' = 'select';
  private insertRows: Row[] = [];
  private updateValues: Row = {};
  private filters: Array<(row: Row) => boolean> = [];
  private limitN: number | null = null;

  constructor(
    private readonly tables: Map<string, Row[]>,
    private readonly table: string,
    private readonly nextId: () => string
  ) {}

  select(): this {
    return this;
  }

  insert(rows: Row[]): this {
    this.mode = 'insert';
    this.insertRows = rows;
    return this;
  }

  update(values: Row): this {
    this.mode = 'update';
    this.updateValues = values;
    return this;
  }

  eq(key: string, value: unknown): this {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  in(key: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[key]));
    return this;
  }

  order(): this {
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const { data } = this.execute();
    return { data: data[0] ?? null, error: null };
  }

  /** Allows `await builder` for list queries (GET, insert-select). */
  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private rows(): Row[] {
    if (!this.tables.has(this.table)) this.tables.set(this.table, []);
    return this.tables.get(this.table) as Row[];
  }

  private execute(): { data: Row[]; error: null } {
    if (this.mode === 'insert') {
      const now = new Date().toISOString();
      const written = this.insertRows.map((row) => ({
        ...row,
        id: this.nextId(),
        created_at: now,
        updated_at: now,
      }));
      this.rows().push(...written);
      return { data: written, error: null };
    }
    if (this.mode === 'update') {
      const matched = this.rows().filter((row) => this.filters.every((f) => f(row)));
      for (const row of matched) Object.assign(row, this.updateValues);
      return { data: matched, error: null };
    }
    let matched = this.rows().filter((row) => this.filters.every((f) => f(row)));
    if (this.limitN !== null) matched = matched.slice(0, this.limitN);
    return { data: matched, error: null };
  }
}

function fakeSupabase() {
  const tables = new Map<string, Row[]>();
  let counter = 1;
  const nextId = () => fakeUuid(counter++);
  tables.set('media_folders', [{ id: FOLDER_ID, user_id: USER_ID }]);
  tables.set('media_download_jobs', []);
  const client = {
    from: (table: string) => new FakeBuilder(tables, table, nextId),
  };
  return { client: client as never, tables };
}

async function sessionCookie(): Promise<string> {
  const token = await signSessionToken(
    {
      userId: USER_ID,
      email: 'alexander@gmail.com',
      name: 'Alex Acme',
      subdomain: SUBDOMAIN,
      role: 'user',
      status: 'active',
    },
    TEST_SECRET
  );
  return `fbup_session=${token}`;
}

function requestWithCookie(cookie: string, url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const JOBS_URL = `http://localhost/api/tenant/${SUBDOMAIN}/downloader`;

function jobRow(id: string, status: string, userId: string = USER_ID): Row {
  const now = new Date().toISOString();
  return {
    id,
    user_id: userId,
    source_url: 'https://example.com/x.mp4',
    source_platform: 'direct',
    target_folder_id: null,
    status,
    progress_percent: status === 'failed' ? 40 : 0,
    total_bytes: null,
    downloaded_bytes: status === 'failed' ? 40 : 0,
    media_id: status === 'done' ? fakeUuid(99) : null,
    error_code: status === 'failed' ? 'DOWNLOAD_FAILED' : null,
    error_message: status === 'failed' ? 'boom' : null,
    attempts: 1,
    claimed_at: null,
    claimed_by: null,
    created_at: now,
    updated_at: now,
  };
}

describe('Download jobs API (spec 149)', () => {
  let cookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    delete process.env.DOWNLOADER_EXTRACTOR_API_URL;
    cookie = await sessionCookie();
  });

  it('POST submits jobs: dedupes, skips invalid links, returns 201', async () => {
    const { client } = fakeSupabase();
    const res = await handleSubmitDownloadJobs(
      requestWithCookie(cookie, JOBS_URL, {
        links: [
          'https://example.com/a.mp4',
          'https://example.com/a.mp4',
          'not-a-link',
          'https://example.com/b.mp4',
        ],
        folderId: FOLDER_ID,
      }),
      SUBDOMAIN,
      client
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      jobs: Array<{ sourceUrl: string; status: string }>;
      skippedDuplicates: number;
      invalidLinks: string[];
    };
    expect(body.jobs).toHaveLength(2);
    expect(body.jobs.every((job) => job.status === 'queued')).toBe(true);
    expect(body.skippedDuplicates).toBe(1);
    expect(body.invalidLinks).toContain('not-a-link');
  });

  it('POST rejects an unknown destination folder with 404', async () => {
    const { client } = fakeSupabase();
    const res = await handleSubmitDownloadJobs(
      requestWithCookie(cookie, JOBS_URL, {
        links: ['https://example.com/a.mp4'],
        folderId: '99999999-9999-4999-8999-999999999999',
      }),
      SUBDOMAIN,
      client
    );
    expect(res.status).toBe(404);
  });

  it('POST with zero valid links returns 400 and writes nothing', async () => {
    const { client, tables } = fakeSupabase();
    const res = await handleSubmitDownloadJobs(
      requestWithCookie(cookie, JOBS_URL, { links: ['not-a-link'] }),
      SUBDOMAIN,
      client
    );
    expect(res.status).toBe(400);
    expect(tables.get('media_download_jobs')).toHaveLength(0);
  });

  it('GET reports only open jobs for the signed-in user', async () => {
    const { client, tables } = fakeSupabase();
    const jobs = tables.get('media_download_jobs') as Row[];
    jobs.push(
      jobRow(fakeUuid(10), 'done'),
      jobRow(fakeUuid(12), 'queued'),
      jobRow(fakeUuid(13), 'queued', '22222222-2222-4222-a222-222222222222')
    );
    const res = await handleGetDownloadJobs(requestWithCookie(cookie, JOBS_URL), SUBDOMAIN, client);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ sourceUrl: string }> };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]?.sourceUrl).toBe('https://example.com/x.mp4');
  });

  it('retry re-queues a failed job and refuses a queued job with 409', async () => {
    const { client, tables } = fakeSupabase();
    const jobs = tables.get('media_download_jobs') as Row[];
    const failedId = fakeUuid(20);
    const queuedId = fakeUuid(21);
    jobs.push(jobRow(failedId, 'failed'), jobRow(queuedId, 'queued'));

    const retried = await handleRetryDownloadJob(
      requestWithCookie(cookie, JOBS_URL, { jobId: failedId }),
      SUBDOMAIN,
      client
    );
    expect(retried.status).toBe(200);
    const retriedBody = (await retried.json()) as { job: { status: string; errorCode: string | null } };
    expect(retriedBody.job.status).toBe('queued');
    expect(retriedBody.job.errorCode).toBeNull();

    const refused = await handleRetryDownloadJob(
      requestWithCookie(cookie, JOBS_URL, { jobId: queuedId }),
      SUBDOMAIN,
      client
    );
    expect(refused.status).toBe(409);
  });

  it('cancel moves an active job to cancelled and refuses a done job', async () => {
    const { client, tables } = fakeSupabase();
    const jobs = tables.get('media_download_jobs') as Row[];
    const activeId = fakeUuid(30);
    const doneId = fakeUuid(31);
    jobs.push(jobRow(activeId, 'downloading'), jobRow(doneId, 'done'));

    const cancelled = await handleCancelDownloadJob(
      requestWithCookie(cookie, JOBS_URL, { jobId: activeId }),
      SUBDOMAIN,
      client
    );
    expect(cancelled.status).toBe(200);
    const cancelledBody = (await cancelled.json()) as { job: { status: string } };
    expect(cancelledBody.job.status).toBe('cancelled');

    const refused = await handleCancelDownloadJob(
      requestWithCookie(cookie, JOBS_URL, { jobId: doneId }),
      SUBDOMAIN,
      client
    );
    expect(refused.status).toBe(409);
  });

  it('retry of another user’s job returns 404', async () => {
    const { client, tables } = fakeSupabase();
    const jobs = tables.get('media_download_jobs') as Row[];
    jobs.push(
      jobRow(fakeUuid(40), 'failed', '22222222-2222-4222-a222-222222222222')
    );
    const res = await handleRetryDownloadJob(
      requestWithCookie(cookie, JOBS_URL, { jobId: fakeUuid(40) }),
      SUBDOMAIN,
      client
    );
    expect(res.status).toBe(404);
  });

  it('rejects unauthenticated requests with 401 and cross-tenant requests with 403', async () => {
    const { client } = fakeSupabase();
    const unauthRes = await handleGetDownloadJobs(
      new NextRequest(JOBS_URL),
      SUBDOMAIN,
      client
    );
    expect(unauthRes.status).toBe(401);

    const crossTenantRes = await handleGetDownloadJobs(
      requestWithCookie(cookie, `http://localhost/api/tenant/other-workspace/downloader`),
      'other-workspace',
      client
    );
    expect(crossTenantRes.status).toBe(403);
  });

  it('the retry and cancel route files export POST handlers', () => {
    expect(typeof retryPost).toBe('function');
    expect(typeof cancelPost).toBe('function');
  });
});

describe('Download jobs API — Cloudflare consumer handoff (spec 149 backend revision)', () => {
  const CONSUMER_URL = 'https://consumer.example.test';
  const ENQUEUE_SECRET = 'enqueue-secret-123';
  let cookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    delete process.env.DOWNLOADER_EXTRACTOR_API_URL;
    cookie = await sessionCookie();
  });

  afterEach(() => {
    delete process.env.DOWNLOAD_CONSUMER_URL;
    delete process.env.DOWNLOAD_ENQUEUE_SECRET;
    vi.unstubAllGlobals();
  });

  function stubEnqueueFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ enqueued: 2 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('submit notifies the consumer with the inserted job ids', async () => {
    process.env.DOWNLOAD_CONSUMER_URL = CONSUMER_URL;
    process.env.DOWNLOAD_ENQUEUE_SECRET = ENQUEUE_SECRET;
    const fetchMock = stubEnqueueFetch();
    const { client } = fakeSupabase();
    const res = await handleSubmitDownloadJobs(
      requestWithCookie(cookie, JOBS_URL, {
        links: ['https://example.com/a.mp4', 'https://example.com/b.mp4'],
        folderId: FOLDER_ID,
      }),
      SUBDOMAIN,
      client
    );
    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${CONSUMER_URL}/enqueue`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-download-enqueue-secret']).toBe(
      ENQUEUE_SECRET
    );
    expect(JSON.parse(String(init.body)) as { jobIds: string[] }).toEqual({
      jobIds: [fakeUuid(1), fakeUuid(2)],
    });
  });

  it('submit still returns 201 when the consumer cannot be reached', async () => {
    process.env.DOWNLOAD_CONSUMER_URL = CONSUMER_URL;
    process.env.DOWNLOAD_ENQUEUE_SECRET = ENQUEUE_SECRET;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('consumer down')));
    const { client } = fakeSupabase();
    const res = await handleSubmitDownloadJobs(
      requestWithCookie(cookie, JOBS_URL, {
        links: ['https://example.com/a.mp4', 'https://example.com/b.mp4'],
        folderId: FOLDER_ID,
      }),
      SUBDOMAIN,
      client
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { jobs: unknown[] };
    expect(body.jobs).toHaveLength(2);
  });

  it('submit does not call the consumer when no consumer URL is configured', async () => {
    const fetchMock = stubEnqueueFetch();
    const { client } = fakeSupabase();
    const res = await handleSubmitDownloadJobs(
      requestWithCookie(cookie, JOBS_URL, {
        links: ['https://example.com/a.mp4'],
        folderId: FOLDER_ID,
      }),
      SUBDOMAIN,
      client
    );
    expect(res.status).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retry of a transient failure keeps its checkpoint and re-notifies', async () => {
    process.env.DOWNLOAD_CONSUMER_URL = CONSUMER_URL;
    process.env.DOWNLOAD_ENQUEUE_SECRET = ENQUEUE_SECRET;
    const fetchMock = stubEnqueueFetch();
    const { client, tables } = fakeSupabase();
    const jobs = tables.get('media_download_jobs') as Row[];
    const failedId = fakeUuid(50);
    const row = jobRow(failedId, 'failed');
    Object.assign(row, {
      pending_media_id: fakeUuid(51),
      r2_upload_id: 'upload-x',
      checkpoint_parts: [{ partNumber: 1, etag: 'etag-1' }],
      checkpoint_bytes: 40,
      checkpoint_stream_url: 'https://cdn.example.com/x.mp4',
      last_progress_at: new Date().toISOString(),
    });
    jobs.push(row);

    const res = await handleRetryDownloadJob(
      requestWithCookie(cookie, JOBS_URL, { jobId: failedId }),
      SUBDOMAIN,
      client
    );
    expect(res.status).toBe(200);
    const retried = jobs[0] as Row;
    expect(retried['status']).toBe('queued');
    expect(retried['error_code']).toBeNull();
    // Transient: progress and checkpoint survive, so the next
    // attempt resumes instead of restarting from byte 0.
    expect(retried['progress_percent']).toBe(40);
    expect(retried['downloaded_bytes']).toBe(40);
    expect(retried['r2_upload_id']).toBe('upload-x');
    expect(retried['checkpoint_bytes']).toBe(40);
    expect(retried['checkpoint_stream_url']).toBe('https://cdn.example.com/x.mp4');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)) as { jobIds: string[] }).toEqual({
      jobIds: [failedId],
    });
  });

  it('retry of a terminal failure clears its checkpoint and resets progress', async () => {
    process.env.DOWNLOAD_CONSUMER_URL = CONSUMER_URL;
    process.env.DOWNLOAD_ENQUEUE_SECRET = ENQUEUE_SECRET;
    stubEnqueueFetch();
    const { client, tables } = fakeSupabase();
    const jobs = tables.get('media_download_jobs') as Row[];
    const failedId = fakeUuid(60);
    const row = jobRow(failedId, 'failed');
    Object.assign(row, {
      error_code: 'FILE_TOO_LARGE',
      error_message: 'This file exceeds the 500 MB maximum size limit.',
      pending_media_id: fakeUuid(61),
      r2_upload_id: 'upload-y',
      checkpoint_parts: [{ partNumber: 1, etag: 'etag-1' }],
      checkpoint_bytes: 40,
      checkpoint_stream_url: 'https://cdn.example.com/x.mp4',
      last_progress_at: new Date().toISOString(),
    });
    jobs.push(row);

    const res = await handleRetryDownloadJob(
      requestWithCookie(cookie, JOBS_URL, { jobId: failedId }),
      SUBDOMAIN,
      client
    );
    expect(res.status).toBe(200);
    const retried = jobs[0] as Row;
    expect(retried['status']).toBe('queued');
    expect(retried['progress_percent']).toBe(0);
    expect(retried['downloaded_bytes']).toBe(0);
    expect(retried['total_bytes']).toBeNull();
    expect(retried['r2_upload_id']).toBeNull();
    expect(retried['checkpoint_parts']).toEqual([]);
    expect(retried['checkpoint_bytes']).toBe(0);
    expect(retried['checkpoint_stream_url']).toBeNull();
    expect(retried['last_progress_at']).toBeNull();
  });

  it('GET reports consumerHealthy true with a fresh heartbeat', async () => {
    const { client, tables } = fakeSupabase();
    tables.set('download_worker_heartbeats', [
      { worker_id: 'cf-download-consumer', heartbeat_at: new Date().toISOString() },
    ]);
    const res = await handleGetDownloadJobs(requestWithCookie(cookie, JOBS_URL), SUBDOMAIN, client);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { consumerHealthy?: boolean };
    expect(body.consumerHealthy).toBe(true);
  });

  it('GET reports consumerHealthy false with a stale or missing heartbeat', async () => {
    const { client, tables } = fakeSupabase();
    tables.set('download_worker_heartbeats', [
      {
        worker_id: 'cf-download-consumer',
        heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(),
      },
    ]);
    const stale = await handleGetDownloadJobs(
      requestWithCookie(cookie, JOBS_URL),
      SUBDOMAIN,
      client
    );
    expect(((await stale.json()) as { consumerHealthy?: boolean }).consumerHealthy).toBe(false);

    const { client: emptyClient } = fakeSupabase();
    const missing = await handleGetDownloadJobs(
      requestWithCookie(cookie, JOBS_URL),
      SUBDOMAIN,
      emptyClient
    );
    expect(((await missing.json()) as { consumerHealthy?: boolean }).consumerHealthy).toBe(false);
  });

  it('GET omits consumerHealthy when the heartbeat cannot be read', async () => {
    const { client } = fakeSupabase();
    const throwingClient = {
      from: (table: string) => {
        if (table === 'download_worker_heartbeats') {
          return {
            select: () => {
              throw new Error('db down');
            },
          };
        }
        return (client as { from: (t: string) => unknown }).from(table);
      },
    } as never;
    const res = await handleGetDownloadJobs(
      requestWithCookie(cookie, JOBS_URL),
      SUBDOMAIN,
      throwingClient
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect('consumerHealthy' in body).toBe(false);
  });
});
