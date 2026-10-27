import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken, type DatabaseClient } from '@fbuploadpro/contracts';

/**
 * Spec 139 Wave B — error-logging sweep (audit B3/B19/C1).
 *
 * Representative sites: a thrown / failed downstream call must produce
 * (a) the same client response as before — or the new generic shape
 * where the old body leaked a raw provider/PostgREST error — and
 * (b) a `logServerError` call so the failure reaches PostHog/logs.
 */
vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
  captureServerException: vi.fn(),
}));

import { handleCheckDuplicates } from '../../src/app/api/tenant/[subdomain]/media/check-duplicates/route';
import { handleGetDownloadJobs } from '../../src/app/api/tenant/[subdomain]/downloader/route';
import { handleListQueueItems } from '../../src/app/api/tenant/[subdomain]/publishing/queue/route';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { logServerError } from '@/lib/server-analytics';

const mockLogServerError = vi.mocked(logServerError);

const TEST_SECRET = 'error-logging-sweep-secret-key-1234567890';
const userId = '11111111-1111-4111-a111-111111111111';
let validSessionCookie: string;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.SESSION_SECRET = TEST_SECRET;

  const token = await signSessionToken(
    {
      userId,
      email: 'alexander@gmail.com',
      name: 'Alex Acme',
      subdomain: 'acme',
      role: 'user',
      status: 'active',
    },
    TEST_SECRET
  );
  validSessionCookie = `fbup_session=${token}`;
});

function authedRequest(url: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const headers = new Headers(init?.headers);
  headers.set('cookie', validSessionCookie);
  return new NextRequest(url, { ...init, headers });
}

describe('C1 — media/check-duplicates no longer leaks the PostgREST error', () => {
  it('returns the generic 500 shape and logs the provider detail server-side', async () => {
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'or', 'is', 'in']) {
      builder[method] = vi.fn(() => builder);
    }
    builder.then = (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown
    ) =>
      Promise.resolve({
        data: null,
        error: { message: 'postgrest boom: relation media_items exploded' },
      }).then(onFulfilled, onRejected);
    const mockSupabase = { from: vi.fn(() => builder) };

    const req = authedRequest('http://localhost:3000/api/tenant/acme/media/check-duplicates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        entries: [{ clientKey: 'file-1', name: 'video.mp4', fileSize: 1234 }],
      }),
    });

    const res = await handleCheckDuplicates(req, 'acme', mockSupabase as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Failed to check duplicates' });
    expect(JSON.stringify(body)).not.toContain('postgrest boom');
    expect(mockLogServerError).toHaveBeenCalledWith(
      expect.stringContaining('check-duplicates'),
      expect.anything(),
      expect.objectContaining({ source: 'media-check-duplicates' })
    );
  });
});

describe('C1 — downloader GET no longer leaks the raw error message', () => {
  it('returns { error: "Internal Error" } only, and logs the thrown error', async () => {
    const mockDb: Partial<DatabaseClient> = {
      query: vi.fn().mockRejectedValue(new Error('pg connection reset by peer')),
    };

    const req = authedRequest('http://localhost:3000/api/tenant/acme/downloader');
    const res = await handleGetDownloadJobs(req, 'acme', mockDb as DatabaseClient);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Internal Error' });
    expect(JSON.stringify(body)).not.toContain('pg connection');
    expect(mockLogServerError).toHaveBeenCalledWith(
      expect.stringContaining('downloader'),
      expect.any(Error),
      expect.objectContaining({ source: 'downloader-jobs' })
    );
  });
});

describe('B19 — queue list counters: failure still serves zero counts, but logs', () => {
  it('logs when the unified status-count query fails', async () => {
    const mockDb: Partial<DatabaseClient> = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM workspaces')) return Promise.resolve([{ id: 'ws_123' }]);
        if (sql.includes('SELECT COUNT(*) AS total')) return Promise.resolve([{ total: 0 }]);
        if (sql.includes('GROUP BY qi.status')) {
          return Promise.reject(new Error('count boom'));
        }
        return Promise.resolve([]);
      }),
    };

    const req = authedRequest('http://localhost:3000/api/tenant/acme/publishing/queue');
    const res = await handleListQueueItems(req, 'acme', mockDb as DatabaseClient);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queuedCount).toBe(0);
    expect(body.publishedCount).toBe(0);
    expect(mockLogServerError).toHaveBeenCalledWith(
      expect.stringContaining('status-count'),
      expect.any(Error),
      expect.objectContaining({ source: 'publishing-queue-list' })
    );
  });
});

describe('B19 — workspace resolver: DB failure still resolves null, but logs', () => {
  it('logs a legacy query failure', async () => {
    const mockDb: Partial<DatabaseClient> = {
      query: vi.fn().mockRejectedValue(new Error('DB failure')),
    };

    const result = await resolveTenantWorkspaceId(mockDb as DatabaseClient, 'acme', userId);
    expect(result).toBeNull();
    expect(mockLogServerError).toHaveBeenCalledWith(
      expect.stringContaining('workspace-resolver'),
      expect.any(Error),
      expect.objectContaining({ source: 'workspace-resolver' })
    );
  });

  it('logs a Supabase error result (distinct from a missing workspace)', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'db down' },
    });
    const eqOwner = vi.fn().mockReturnValue({ maybeSingle });
    const eqSubdomain = vi.fn().mockReturnValue({ eq: eqOwner });
    const mockSupabase = {
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq: eqSubdomain }) }),
    };

    const result = await resolveTenantWorkspaceId(mockSupabase as never, 'acme', userId);
    expect(result).toBeNull();
    expect(mockLogServerError).toHaveBeenCalledWith(
      expect.stringContaining('workspace-resolver'),
      expect.objectContaining({ message: 'db down' }),
      expect.objectContaining({ source: 'workspace-resolver' })
    );
  });
});
