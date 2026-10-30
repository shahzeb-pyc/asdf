import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSupabaseClient, SupabaseJobStore } from '../src/store.js';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const MEDIA_ID = '33333333-3333-4333-8333-333333333333';

function jobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

function installFetch(
  handler: (req: CapturedRequest) => Response | null
): { requests: CapturedRequest[]; restore: () => void } {
  const requests: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    let url: string;
    let method = init?.method ?? 'GET';
    let rawBody = init?.body;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      const req = input as Request;
      url = req.url;
      method = req.method;
      rawBody = await req.clone().text().catch(() => undefined);
    }
    let body: unknown;
    if (typeof rawBody === 'string' && rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const captured: CapturedRequest = { url, method, body };
    requests.push(captured);
    const res = handler(captured);
    if (res) return res;
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function store(): SupabaseJobStore {
  return new SupabaseJobStore(createSupabaseClient('https://example.supabase.co', 'service-key'));
}

describe('SupabaseJobStore over stubbed fetch', () => {
  let restore: () => void = () => undefined;
  beforeEach(() => {
    restore = () => undefined;
  });
  afterEach(() => {
    restore();
    vi.unstubAllGlobals();
  });

  it('fetchJob parses a row, including checkpoint columns and legacy status', async () => {
    const { restore: stop } = installFetch((req) => {
      if (req.url.includes('/rest/v1/media_download_jobs') && req.method === 'GET') {
        return jsonResponse(
          jobRow({
            status: 'processing',
            progress_percent: 42,
            total_bytes: 1000,
            downloaded_bytes: 420,
            attempts: 2,
            claimed_at: '2026-10-30T01:00:00.000Z',
            claimed_by: 'cf-download-consumer',
            pending_media_id: MEDIA_ID,
            r2_upload_id: 'upload-1',
            checkpoint_parts: [
              { partNumber: 1, etag: 'abc' },
              { partNumber: 'bad', etag: 'def' },
              { partNumber: 2 },
            ],
            checkpoint_bytes: 8388608,
            checkpoint_stream_url: 'https://cdn.example.com/v.mp4',
            last_progress_at: '2026-10-30T01:05:00.000Z',
          })
        );
      }
      return null;
    });
    restore = stop;
    const record = await store().fetchJob(JOB_ID);
    expect(record).not.toBeNull();
    expect(record?.status).toBe('downloading');
    expect(record?.progressPercent).toBe(42);
    expect(record?.attempts).toBe(2);
    expect(record?.pendingMediaId).toBe(MEDIA_ID);
    expect(record?.checkpoint).toEqual({
      uploadId: 'upload-1',
      parts: [{ partNumber: 1, etag: 'abc' }],
      bytes: 8388608,
      streamUrl: 'https://cdn.example.com/v.mp4',
    });
    expect(record?.lastProgressAt).toBe('2026-10-30T01:05:00.000Z');
  });

  it('fetchJob returns null for a malformed row and throws on a DB error', async () => {
    const { restore: stop } = installFetch((req) => {
      if (req.url.includes('/rest/v1/media_download_jobs') && req.method === 'GET') {
        return jsonResponse({ id: 'not-a-uuid' });
      }
      return null;
    });
    restore = stop;
    await expect(store().fetchJob(JOB_ID)).resolves.toBeNull();

    const { restore: stop2 } = installFetch(() =>
      jsonResponse(
        { code: 'PGRST999', message: 'boom', details: '', hint: '' },
        400
      )
    );
    restore = stop2;
    await expect(store().fetchJob(JOB_ID)).rejects.toThrow('fetchJob failed: boom');
  });

  it('updateJob maps a patch to snake_case, including checkpoint set and clear', async () => {
    const seen: CapturedRequest[] = [];
    const { restore: stop } = installFetch((req) => {
      if (req.url.includes('/rest/v1/media_download_jobs') && req.method === 'PATCH') {
        seen.push(req);
        return jsonResponse([]);
      }
      return null;
    });
    restore = stop;
    const s = store();
    await s.updateJob(JOB_ID, {
      status: 'downloading',
      progressPercent: 50,
      downloadedBytes: 500,
      checkpoint: {
        uploadId: 'u1',
        parts: [{ partNumber: 1, etag: 'e1' }],
        bytes: 100,
        streamUrl: 'https://cdn.example.com/v.mp4',
      },
      lastProgressAt: '2026-10-30T02:00:00.000Z',
    });
    expect(seen[0]?.body).toMatchObject({
      status: 'downloading',
      progress_percent: 50,
      downloaded_bytes: 500,
      r2_upload_id: 'u1',
      checkpoint_parts: [{ partNumber: 1, etag: 'e1' }],
      checkpoint_bytes: 100,
      checkpoint_stream_url: 'https://cdn.example.com/v.mp4',
      last_progress_at: '2026-10-30T02:00:00.000Z',
    });

    await s.updateJob(JOB_ID, { checkpoint: null });
    expect(seen[1]?.body).toMatchObject({
      r2_upload_id: null,
      checkpoint_parts: [],
      checkpoint_bytes: 0,
      checkpoint_stream_url: null,
    });
  });

  it('insertMediaItems upserts with ON CONFLICT DO NOTHING and skips empty lists', async () => {
    const seen: CapturedRequest[] = [];
    const { restore: stop } = installFetch((req) => {
      if (req.url.includes('/rest/v1/media_items') && req.method === 'POST') {
        seen.push(req);
        return jsonResponse([]);
      }
      return null;
    });
    restore = stop;
    const s = store();
    await s.insertMediaItems([]);
    expect(seen).toHaveLength(0);
    await s.insertMediaItems([
      {
        id: MEDIA_ID,
        userId: USER_ID,
        folderId: null,
        name: 'v.mp4',
        fileSize: 123,
        mimeType: 'video/mp4',
        mediaType: 'video',
        storageKey: 'users/u/media/m/v.mp4',
        url: 'https://media.example.com/v.mp4',
        thumbnailKey: null,
        thumbnailUrl: null,
        durationSeconds: null,
        aspectRatio: null,
        captionText: 'hi',
      },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toContain('on_conflict=id');
    expect(seen[0]?.body).toMatchObject([
      { id: MEDIA_ID, user_id: USER_ID, file_size: 123, caption_text: 'hi' },
    ]);
  });

  it('claimJobs passes worker/user/limit to the RPC and skips malformed rows', async () => {
    let rpcBody: unknown;
    const { restore: stop } = installFetch((req) => {
      if (req.url.includes('/rpc/claim_download_jobs')) {
        rpcBody = req.body;
        return jsonResponse([jobRow({ status: 'resolving' }), { id: 'bad' }]);
      }
      return null;
    });
    restore = stop;
    const records = await store().claimJobs('cf-download-consumer', USER_ID, 3);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('resolving');
    expect(rpcBody).toMatchObject({
      p_worker_id: 'cf-download-consumer',
      p_user_id: USER_ID,
      p_limit: 3,
    });
  });
});

describe('SupabaseJobStore sweep, reclaim, and errors', () => {
  let restore: () => void = () => undefined;
  beforeEach(() => {
    restore = () => undefined;
  });
  afterEach(() => {
    restore();
    vi.unstubAllGlobals();
  });

  it('upsertHeartbeat writes the worker id, sweep returns oldest queued, count reads exact', async () => {
    const seen: CapturedRequest[] = [];
    const { restore: stop } = installFetch((req) => {
      if (req.url.includes('/rest/v1/download_worker_heartbeats')) {
        seen.push(req);
        return jsonResponse([{}]);
      }
      if (
        req.url.includes('/rest/v1/media_download_jobs') &&
        (req.method === 'GET' || req.method === 'HEAD')
      ) {
        if (req.url.includes('select=id%2Cuser_id') || req.url.includes('select=id,user_id')) {
          return jsonResponse([
            { id: JOB_ID, user_id: USER_ID },
            { id: 'bad', user_id: 7 },
          ]);
        }
        // Exact-count head request: the count rides the content-range header.
        return new Response(null, { headers: { 'content-range': '*/3' } });
      }
      return null;
    });
    restore = stop;
    const s = store();
    await s.upsertHeartbeat('cf-download-consumer');
    expect(seen[0]?.body).toMatchObject({ worker_id: 'cf-download-consumer' });

    const swept = await s.sweepQueuedJobs(50);
    expect(swept).toEqual([{ id: JOB_ID, userId: USER_ID }]);

    await expect(s.countActiveJobs(USER_ID)).resolves.toBe(3);
  });

  it('reclaimStaleJobs requeues both silent-with-progress and never-progress jobs', async () => {
    const calls: CapturedRequest[] = [];
    const { restore: stop } = installFetch((req) => {
      if (req.url.includes('/rest/v1/media_download_jobs') && req.method === 'PATCH') {
        calls.push(req);
        if (req.url.includes('last_progress_at=is.null')) {
          return jsonResponse([{ id: 'a' }]);
        }
        return jsonResponse([{ id: 'b' }, { id: 'c' }]);
      }
      return null;
    });
    restore = stop;
    await expect(store().reclaimStaleJobs(30)).resolves.toBe(3);
    expect(calls).toHaveLength(2);
    // Both updates flip the row back to queued and clear the claim;
    // the first filters on a stale progress write, the second on a
    // null progress write with a stale claim.
    for (const call of calls) {
      expect(call.body).toMatchObject({ status: 'queued', claimed_at: null, claimed_by: null });
    }
    expect(calls[0]?.url).toContain('last_progress_at=lt.');
    expect(calls[1]?.url).toContain('last_progress_at=is.null');
  });

  it('updateJob and claimJobs surface DB errors as thrown errors', async () => {
    const { restore: stop } = installFetch(() =>
      jsonResponse({ code: 'X', message: 'db down', details: '', hint: '' }, 500)
    );
    restore = stop;
    const s = store();
    await expect(s.updateJob(JOB_ID, { status: 'failed' })).rejects.toThrow(
      'updateJob failed: db down'
    );
    await expect(s.claimJobs('w', USER_ID, 3)).rejects.toThrow('claim_download_jobs failed');
  });
});
