import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createServerQueryClient,
  getRequestBaseUrl,
  getServerBaseUrl,
  prefetchServerQueries,
  serverApiFetch,
} from '@/lib/data/server';
import {
  resetReportErrorTransport,
  setReportErrorTransport,
  type ReportErrorContext,
} from '@/lib/report-error';

/** Controllable stand-in for `next/headers` (request scope in tests). */
const headerMocks = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  cookieHeader: '',
  throwOnHeaders: false,
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    toString: () => headerMocks.cookieHeader,
  }),
  headers: async () => {
    if (headerMocks.throwOnHeaders) {
      throw new Error('no request scope');
    }
    return {
      get: (name: string) => headerMocks.headers.get(name.toLowerCase()) ?? null,
    };
  },
}));

function setRequestHeaders(entries: Record<string, string>): void {
  headerMocks.headers.clear();
  for (const [name, value] of Object.entries(entries)) {
    headerMocks.headers.set(name.toLowerCase(), value);
  }
}

const WALLED_VERCEL_URL = 'asdf-v2pn-shahzebhuyar-4438.vercel.app';

describe('getServerBaseUrl', () => {
  const originalVercelUrl = process.env.VERCEL_URL;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    delete process.env.VERCEL_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalVercelUrl !== undefined) {
      process.env.VERCEL_URL = originalVercelUrl;
    } else {
      delete process.env.VERCEL_URL;
    }
    if (originalAppUrl !== undefined) {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    } else {
      delete process.env.NEXT_PUBLIC_APP_URL;
    }
  });

  it('prefers VERCEL_URL over NEXT_PUBLIC_APP_URL (the current deployment wins)', () => {
    vi.stubEnv(
      'VERCEL_URL',
      'fbuploadpro-git-feat-pages-dedicated-redesign-velocta.vercel.app'
    );
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.fbuploadpro.com');
    expect(getServerBaseUrl()).toBe(
      'https://fbuploadpro-git-feat-pages-dedicated-redesign-velocta.vercel.app'
    );
  });

  it('uses VERCEL_URL alone as an https origin', () => {
    vi.stubEnv('VERCEL_URL', 'fbuploadpro-git-main-velocta.vercel.app');
    expect(getServerBaseUrl()).toBe('https://fbuploadpro-git-main-velocta.vercel.app');
  });

  it('falls back to NEXT_PUBLIC_APP_URL when VERCEL_URL is unset', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.fbuploadpro.com');
    expect(getServerBaseUrl()).toBe('https://app.fbuploadpro.com');
  });

  it('falls back to localhost when neither variable is set', () => {
    expect(getServerBaseUrl()).toBe('http://localhost:3000');
  });

  it('strips trailing slashes from both origins', () => {
    vi.stubEnv('VERCEL_URL', 'preview.example.vercel.app///');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.fbuploadpro.com///');
    expect(getServerBaseUrl()).toBe('https://preview.example.vercel.app');
    vi.unstubAllEnvs();
    delete process.env.VERCEL_URL;
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.fbuploadpro.com///');
    expect(getServerBaseUrl()).toBe('https://app.fbuploadpro.com');
  });
});

describe('getRequestBaseUrl (spec 170 F1)', () => {
  const originalVercelUrl = process.env.VERCEL_URL;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const reported: Array<{ error: unknown; context: ReportErrorContext | undefined }> =
    [];

  beforeEach(() => {
    delete process.env.VERCEL_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    headerMocks.headers.clear();
    headerMocks.cookieHeader = '';
    headerMocks.throwOnHeaders = false;
    reported.length = 0;
    setReportErrorTransport((error, context) => {
      reported.push({ error, context });
    });
  });

  afterEach(() => {
    resetReportErrorTransport();
    vi.unstubAllEnvs();
    if (originalVercelUrl !== undefined) {
      process.env.VERCEL_URL = originalVercelUrl;
    } else {
      delete process.env.VERCEL_URL;
    }
    if (originalAppUrl !== undefined) {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    } else {
      delete process.env.NEXT_PUBLIC_APP_URL;
    }
  });

  it('prefers the request host over VERCEL_URL (the wall-gated deployment URL)', async () => {
    vi.stubEnv('VERCEL_URL', WALLED_VERCEL_URL);
    setRequestHeaders({
      host: 'beekainternational.fbuploadpro.com',
      'x-forwarded-proto': 'https',
    });
    await expect(getRequestBaseUrl()).resolves.toBe(
      'https://beekainternational.fbuploadpro.com'
    );
    expect(reported).toHaveLength(0);
  });

  it('takes the first forwarded proto when several are present', async () => {
    setRequestHeaders({
      host: 'beekainternational.fbuploadpro.com',
      'x-forwarded-proto': 'https, http',
    });
    await expect(getRequestBaseUrl()).resolves.toBe(
      'https://beekainternational.fbuploadpro.com'
    );
  });

  it('uses http for a localhost host with no forwarded proto', async () => {
    setRequestHeaders({ host: 'localhost:3000' });
    await expect(getRequestBaseUrl()).resolves.toBe('http://localhost:3000');
  });

  it('falls back to getServerBaseUrl when no host header is present', async () => {
    vi.stubEnv('VERCEL_URL', WALLED_VERCEL_URL);
    await expect(getRequestBaseUrl()).resolves.toBe(
      `https://${WALLED_VERCEL_URL}`
    );
    expect(reported).toHaveLength(0);
  });

  it('falls back to getServerBaseUrl when headers() throws, and reports it', async () => {
    vi.stubEnv('VERCEL_URL', WALLED_VERCEL_URL);
    headerMocks.throwOnHeaders = true;
    await expect(getRequestBaseUrl()).resolves.toBe(
      `https://${WALLED_VERCEL_URL}`
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context?.source).toBe('data-server-headers');
  });
});

describe('serverApiFetch loopback origin (spec 170 F1)', () => {
  const originalVercelUrl = process.env.VERCEL_URL;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const reported: Array<{ error: unknown; context: ReportErrorContext | undefined }> =
    [];
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const jsonFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  beforeEach(() => {
    delete process.env.VERCEL_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    headerMocks.headers.clear();
    headerMocks.cookieHeader = '';
    headerMocks.throwOnHeaders = false;
    reported.length = 0;
    calls.length = 0;
    setReportErrorTransport((error, context) => {
      reported.push({ error, context });
    });
  });

  afterEach(() => {
    resetReportErrorTransport();
    vi.unstubAllEnvs();
    if (originalVercelUrl !== undefined) {
      process.env.VERCEL_URL = originalVercelUrl;
    } else {
      delete process.env.VERCEL_URL;
    }
    if (originalAppUrl !== undefined) {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    } else {
      delete process.env.NEXT_PUBLIC_APP_URL;
    }
  });

  it('loops back to the request host, not the wall-gated VERCEL_URL, forwarding cookies', async () => {
    vi.stubEnv('VERCEL_URL', WALLED_VERCEL_URL);
    headerMocks.cookieHeader = 'fbup_session=session-123';
    setRequestHeaders({
      host: 'beekainternational.fbuploadpro.com',
      'x-forwarded-proto': 'https',
    });
    const data = await serverApiFetch(
      '/api/tenant/beekainternational/accounts?page=1&limit=30',
      { fetchFn: jsonFetch }
    );
    expect(data).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://beekainternational.fbuploadpro.com/api/tenant/beekainternational/accounts?page=1&limit=30'
    );
    expect(
      (calls[0]?.init.headers as Record<string, string> | undefined)?.Cookie
    ).toBe('fbup_session=session-123');
    expect(reported).toHaveLength(0);
  });

  it('an explicit baseUrl still wins over the request host', async () => {
    setRequestHeaders({
      host: 'beekainternational.fbuploadpro.com',
      'x-forwarded-proto': 'https',
    });
    await serverApiFetch('/api/tenant/beekainternational/accounts', {
      baseUrl: 'https://explicit.example',
      fetchFn: jsonFetch,
    });
    expect(calls[0]?.url).toBe(
      'https://explicit.example/api/tenant/beekainternational/accounts'
    );
  });

  it('an absolute URL skips the loopback origin entirely', async () => {
    headerMocks.throwOnHeaders = true;
    const data = await serverApiFetch('https://other.example/api/ping', {
      fetchFn: jsonFetch,
    });
    expect(data).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('https://other.example/api/ping');
    // headers() is never read for an absolute URL, so nothing is reported.
    expect(reported).toHaveLength(0);
  });

  it('the Vercel Authentication wall response (200 HTML) fails loudly, not silently', async () => {
    const wallFetch: typeof fetch = async () => {
      return new Response(
        '<!DOCTYPE html><html><head><title>Vercel Authentication</title></head></html>',
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      );
    };
    setRequestHeaders({
      host: 'beekainternational.fbuploadpro.com',
      'x-forwarded-proto': 'https',
    });
    await expect(
      serverApiFetch('/api/tenant/beekainternational/accounts', {
        schema: z.object({ ok: z.boolean() }),
        fetchFn: wallFetch,
      })
    ).rejects.toThrow('The server returned a response that was not valid JSON.');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context?.source).toBe('data-server');
  });

  it('a 401 from the app throws session-expired', async () => {
    const unauthorizedFetch: typeof fetch = async () => {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    setRequestHeaders({
      host: 'beekainternational.fbuploadpro.com',
      'x-forwarded-proto': 'https',
    });
    await expect(
      serverApiFetch('/api/tenant/beekainternational/accounts', {
        fetchFn: unauthorizedFetch,
      })
    ).rejects.toThrow('Your session expired. Sign in again');
  });
});

describe('prefetchServerQueries (spec 170 F1)', () => {
  const reported: Array<{ error: unknown; context: ReportErrorContext | undefined }> =
    [];

  beforeEach(() => {
    reported.length = 0;
    setReportErrorTransport((error, context) => {
      reported.push({ error, context });
    });
  });

  afterEach(() => {
    resetReportErrorTransport();
  });

  it('populates the dehydrated cache so the browser makes no fetch on mount', async () => {
    const client = createServerQueryClient('beekainternational');
    const accounts = [{ id: 'a1', displayName: 'Beeka' }];
    const state = await prefetchServerQueries(client, [
      {
        queryKey: ['tenant', 'beekainternational', 'accounts', 'list', { page: 1 }],
        queryFn: async () => ({ accounts }),
      },
    ]);
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]?.state.status).toBe('success');
    expect(state.queries[0]?.state.data).toEqual({ accounts });
    expect(reported).toHaveLength(0);
  });

  it('a failed entry leaves its key out but is reported, and the other entry still dehydrates', async () => {
    const client = createServerQueryClient('beekainternational');
    const state = await prefetchServerQueries(client, [
      {
        queryKey: ['tenant', 'beekainternational', 'accounts', 'list', { page: 1 }],
        queryFn: async () => {
          throw new Error('accounts down');
        },
      },
      {
        queryKey: ['tenant', 'beekainternational', 'settings', 'byoc'],
        queryFn: async () => ({ enabled: true }),
      },
    ]);
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]?.state.data).toEqual({ enabled: true });
    expect(reported).toHaveLength(1);
    expect(reported[0]?.context?.source).toBe('data-server-prefetch');
    expect((reported[0]?.error as Error | undefined)?.message).toBe(
      'accounts down'
    );
  });
});
