import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  api,
  apiDelete,
  apiFetch,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  buildTenantApiPath,
  buildUrl,
} from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import {
  registerSessionExpiredHandler,
  resetSessionExpiredGuard,
} from '@/lib/api/session-expired';
import {
  resetReportErrorTransport,
  setReportErrorTransport,
} from '@/lib/report-error';

const WidgetSchema = z.object({
  id: z.string(),
  label: z.string(),
});

interface MockResponseInit {
  status?: number;
  body?: string;
}

function mockResponse({ status = 200, body = '' }: MockResponseInit = {}) {
  const text = vi.fn().mockResolvedValue(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text,
  } as unknown as Response & { text: ReturnType<typeof vi.fn> };
}

function jsonResponse(body: unknown, status = 200) {
  return mockResponse({ status, body: JSON.stringify(body) });
}

function fetchReturning(response: Response) {
  return vi.fn().mockResolvedValue(response) as unknown as typeof fetch &
    ReturnType<typeof vi.fn>;
}

async function captureError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error('Expected the call to throw, but it resolved');
}

describe('buildTenantApiPath', () => {
  it('builds the tenant base path for a path with a leading slash', () => {
    expect(buildTenantApiPath('alpha', '/pages')).toBe('/api/tenant/alpha/pages');
  });

  it('adds the leading slash when missing', () => {
    expect(buildTenantApiPath('alpha', 'pages')).toBe('/api/tenant/alpha/pages');
  });

  it('encodes the subdomain segment', () => {
    expect(buildTenantApiPath('a b', '/x')).toBe('/api/tenant/a%20b/x');
  });
});

describe('buildUrl', () => {
  it('returns the path unchanged without query params', () => {
    expect(buildUrl('/api/workspaces')).toBe('/api/workspaces');
    expect(buildUrl('/api/workspaces', {})).toBe('/api/workspaces');
    expect(buildUrl('/api/workspaces', { a: null, b: undefined })).toBe(
      '/api/workspaces'
    );
  });

  it('serializes string, number and boolean params, skipping nullish ones', () => {
    expect(
      buildUrl('/api/media', { limit: 50, search: 'cat video', exact: true, skip: null })
    ).toBe('/api/media?limit=50&search=cat+video&exact=true');
  });
});

describe('apiFetch request construction', () => {
  it('GETs by default, sends Accept, parses JSON once, returns the body', async () => {
    const response = mockResponse({ body: JSON.stringify({ hello: 'world' }) });
    const fetchFn = fetchReturning(response);
    const result = await apiFetch('/api/workspaces', { fetchFn });
    expect(result).toEqual({ hello: 'world' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspaces');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Accept: 'application/json' });
    expect(init.body).toBeUndefined();
    expect(response.text).toHaveBeenCalledTimes(1);
  });

  it('works against a real Response (single body read)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ real: true }), { status: 200 })
      ) as unknown as typeof fetch;
    await expect(apiFetch('/api/real', { fetchFn })).resolves.toEqual({ real: true });
  });

  it('defaults to POST with a JSON body and Content-Type when a body is given', async () => {
    const fetchFn = fetchReturning(jsonResponse({ ok: true }));
    await apiFetch('/api/things', { body: { name: 'n' }, fetchFn });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(init.body).toBe(JSON.stringify({ name: 'n' }));
  });

  it('merges caller headers over the defaults', async () => {
    const fetchFn = fetchReturning(jsonResponse({}));
    await apiFetch('/api/things', {
      headers: { 'X-Custom': '1', Accept: 'application/vnd.api+json' },
      fetchFn,
    });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({
      Accept: 'application/vnd.api+json',
      'X-Custom': '1',
    });
  });

  it('appends query params to the request URL', async () => {
    const fetchFn = fetchReturning(jsonResponse([]));
    await apiFetch('/api/media', { query: { limit: 10, offset: 0 }, fetchFn });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/media?limit=10&offset=0');
  });

  it('passes a caller AbortSignal through untouched', async () => {
    const fetchFn = fetchReturning(jsonResponse({}));
    const controller = new AbortController();
    await apiFetch('/api/slow', { signal: controller.signal, fetchFn });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('passes string, FormData, Blob, ArrayBuffer and URLSearchParams bodies through unserialized', async () => {
    const bodies: unknown[] = [
      'raw text',
      new FormData(),
      new Blob(['x']),
      new ArrayBuffer(4),
      new URLSearchParams({ a: '1' }),
    ];
    for (const body of bodies) {
      const fetchFn = fetchReturning(jsonResponse({}));
      await apiFetch('/api/upload', { body, fetchFn });
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBe(body);
      expect(init.headers).toEqual({ Accept: 'application/json' });
    }
  });

  it('sends a null body through without a JSON content type', async () => {
    const fetchFn = fetchReturning(jsonResponse({}));
    await apiFetch('/api/things', { method: 'POST', body: null, fetchFn });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeNull();
    expect(init.headers).toEqual({ Accept: 'application/json' });
  });

  it('uses the global fetch when no fetchFn is injected', async () => {
    const globalFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ via: 'global' })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', globalFetch);
    await expect(apiFetch('/api/global')).resolves.toEqual({ via: 'global' });
    expect(globalFetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe('apiFetch schema validation', () => {
  it('returns the parsed type on a schema match (unknown keys stripped)', async () => {
    const fetchFn = fetchReturning(
      jsonResponse({ id: 'w1', label: 'One', extra: 'dropped' })
    );
    const result = await apiFetch('/api/widgets', { schema: WidgetSchema, fetchFn });
    expect(result).toEqual({ id: 'w1', label: 'One' });
  });

  it('throws a parse ApiError (and reports it) on a schema mismatch', async () => {
    const transport = vi.fn();
    setReportErrorTransport(transport);
    const fetchFn = fetchReturning(jsonResponse({ id: 42, label: 'One' }));
    const error = await captureError(
      apiFetch('/api/widgets', { schema: WidgetSchema, fetchFn })
    );
    expect(error.kind).toBe('parse');
    expect(error.status).toBe(200);
    expect(Array.isArray(error.issues)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      source: 'api-client',
      path: '/api/widgets',
    });
    resetReportErrorTransport();
  });

  it('throws a parse ApiError on a non-JSON success body', async () => {
    const fetchFn = fetchReturning(mockResponse({ body: '<html>nope</html>' }));
    const error = await captureError(apiFetch('/api/html', { fetchFn }));
    expect(error.kind).toBe('parse');
    expect(error.message).toContain('not valid JSON');
  });

  it('returns undefined for an empty success body without a schema', async () => {
    const fetchFn = fetchReturning(mockResponse({ status: 204, body: '' }));
    await expect(apiFetch('/api/empty', { fetchFn })).resolves.toBeUndefined();
  });

  it('throws a parse ApiError for an empty success body with a schema', async () => {
    const fetchFn = fetchReturning(mockResponse({ status: 200, body: '' }));
    const error = await captureError(
      apiFetch('/api/empty', { schema: WidgetSchema, fetchFn })
    );
    expect(error.kind).toBe('parse');
    expect(error.message).toContain('empty response');
  });
});

describe('apiFetch error taxonomy', () => {
  it('maps a fetch rejection to a network ApiError', async () => {
    const cause = new TypeError('fetch failed');
    const fetchFn = vi.fn().mockRejectedValue(cause) as unknown as typeof fetch;
    const error = await captureError(apiFetch('/api/down', { fetchFn }));
    expect(error.kind).toBe('network');
    expect(error.cause).toBe(cause);
  });

  it('maps an AbortError rejection to an aborted ApiError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const fetchFn = vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch;
    const error = await captureError(apiFetch('/api/slow', { fetchFn }));
    expect(error.kind).toBe('aborted');
    expect(error.cause).toBe(abortError);
  });

  it('maps a rejection under an aborted signal to aborted, whatever its shape', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error('socket closed')) as unknown as typeof fetch;
    const signal = { aborted: true } as AbortSignal;
    const error = await captureError(apiFetch('/api/slow', { fetchFn, signal }));
    expect(error.kind).toBe('aborted');
  });

  it('maps a body-read rejection to a network ApiError', async () => {
    const response = {
      ok: true,
      status: 200,
      text: vi.fn().mockRejectedValue(new Error('stream died')),
    } as unknown as Response;
    const fetchFn = fetchReturning(response);
    const error = await captureError(apiFetch('/api/stream', { fetchFn }));
    expect(error.kind).toBe('network');
  });

  it('maps an aborted body-read to an aborted ApiError', async () => {
    const abortError = new Error('aborted mid-body');
    abortError.name = 'TimeoutError';
    const response = {
      ok: true,
      status: 200,
      text: vi.fn().mockRejectedValue(abortError),
    } as unknown as Response;
    const fetchFn = fetchReturning(response);
    const error = await captureError(apiFetch('/api/stream', { fetchFn }));
    expect(error.kind).toBe('aborted');
  });

  it('maps a non-2xx {error} body to an http ApiError with the server message', async () => {
    const fetchFn = fetchReturning(jsonResponse({ error: 'Workspace not found' }, 404));
    const error = await captureError(apiFetch('/api/missing', { fetchFn }));
    expect(error.kind).toBe('http');
    expect(error.status).toBe(404);
    expect(error.message).toBe('Workspace not found');
    expect(error.code).toBeUndefined();
  });

  it('prefers message over error and surfaces error as the code', async () => {
    const fetchFn = fetchReturning(
      jsonResponse({ error: 'INVALID_REQUEST', message: 'Invalid JSON payload' }, 400)
    );
    const error = await captureError(apiFetch('/api/bad', { fetchFn }));
    expect(error.kind).toBe('http');
    expect(error.message).toBe('Invalid JSON payload');
    expect(error.code).toBe('INVALID_REQUEST');
  });

  it('reads an explicit code field when present', async () => {
    const fetchFn = fetchReturning(
      jsonResponse({ code: 'NO_SLOTS_CONFIGURED', message: 'No slots' }, 400)
    );
    const error = await captureError(apiFetch('/api/queue', { fetchFn }));
    expect(error.code).toBe('NO_SLOTS_CONFIGURED');
    expect(error.message).toBe('No slots');
  });

  it('falls back to a status message for non-JSON error bodies', async () => {
    const fetchFn = fetchReturning(mockResponse({ status: 502, body: 'Bad Gateway' }));
    const error = await captureError(apiFetch('/api/upstream', { fetchFn }));
    expect(error.kind).toBe('http');
    expect(error.status).toBe(502);
    expect(error.message).toBe('Request failed with status 502');
    expect(error.code).toBeUndefined();
  });

  it('falls back to a status message when the error body is not an object', async () => {
    const fetchFn = fetchReturning(mockResponse({ status: 500, body: '42' }));
    const error = await captureError(apiFetch('/api/odd', { fetchFn }));
    expect(error.kind).toBe('http');
    expect(error.message).toBe('Request failed with status 500');
  });
});

describe('apiFetch 401 handling', () => {
  let unregister: (() => void) | null = null;

  beforeEach(() => {
    resetSessionExpiredGuard();
  });

  afterEach(() => {
    unregister?.();
    unregister = null;
    resetSessionExpiredGuard();
  });

  it('maps a mutation 401 to session-expired and triggers the global handler once', async () => {
    const handler = vi.fn();
    unregister = registerSessionExpiredHandler(handler);
    const fetchFn = fetchReturning(jsonResponse({ error: 'Unauthorized' }, 401));
    const error = await captureError(
      apiFetch('/api/protected', { fetchFn, method: 'POST', body: { a: 1 } })
    );
    expect(error.kind).toBe('session-expired');
    expect(error.status).toBe(401);
    // The handler is fired without blocking the throw; let it run.
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith({ path: '/' });
  });

  it('does not re-trigger the handler for a second racing mutation 401', async () => {
    const handler = vi.fn();
    unregister = registerSessionExpiredHandler(handler);
    const makeFetch = () =>
      fetchReturning(jsonResponse({ error: 'Unauthorized' }, 401));
    await captureError(apiFetch('/api/one', { fetchFn: makeFetch(), method: 'POST' }));
    await captureError(apiFetch('/api/two', { fetchFn: makeFetch(), method: 'POST' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('maps a GET 401 to session-expired but never navigates on it', async () => {
    const handler = vi.fn();
    unregister = registerSessionExpiredHandler(handler);
    const fetchFn = fetchReturning(jsonResponse({ error: 'Unauthorized' }, 401));
    // Default apiFetch method is GET: a background query/poll/
    // refetch 401 must surface as a retryable error in that query,
    // not yank the whole page to login (spec §2.3).
    const error = await captureError(apiFetch('/api/protected', { fetchFn }));
    expect(error.kind).toBe('session-expired');
    expect(error.status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('bounceOnUnauthorized overrides the method default both ways', async () => {
    const handler = vi.fn();
    unregister = registerSessionExpiredHandler(handler);
    const getFetch = fetchReturning(jsonResponse({ error: 'Unauthorized' }, 401));
    await captureError(
      apiFetch('/api/get-bounce', { fetchFn: getFetch, bounceOnUnauthorized: true })
    );
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    resetSessionExpiredGuard();
    const postFetch = fetchReturning(jsonResponse({ error: 'Unauthorized' }, 401));
    await captureError(
      apiFetch('/api/post-no-bounce', {
        fetchFn: postFetch,
        method: 'POST',
        bounceOnUnauthorized: false,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('verb helpers', () => {
  it('apiGet forces GET and honours the schema', async () => {
    const fetchFn = fetchReturning(jsonResponse({ id: 'a', label: 'A' }));
    await expect(apiGet('/x', { schema: WidgetSchema, fetchFn })).resolves.toEqual({
      id: 'a',
      label: 'A',
    });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('GET');
  });

  it('apiGet without a schema returns unknown data', async () => {
    const fetchFn = fetchReturning(jsonResponse({ free: 'form' }));
    await expect(apiGet('/x', { fetchFn })).resolves.toEqual({ free: 'form' });
  });

  it('apiPost sends POST with the body, with and without a schema', async () => {
    const withSchema = fetchReturning(jsonResponse({ id: 'b', label: 'B' }));
    await expect(
      apiPost('/x', { label: 'B' }, { schema: WidgetSchema, fetchFn: withSchema })
    ).resolves.toEqual({ id: 'b', label: 'B' });
    expect((withSchema.mock.calls[0] as [string, RequestInit])[1].method).toBe('POST');

    const noSchema = fetchReturning(jsonResponse({ done: true }));
    await expect(apiPost('/x', { a: 1 }, { fetchFn: noSchema })).resolves.toEqual({
      done: true,
    });
    const bare = fetchReturning(jsonResponse({ done: true }));
    await expect(apiPost('/x', undefined, { fetchFn: bare })).resolves.toEqual({
      done: true,
    });
    expect((bare.mock.calls[0] as [string, RequestInit])[1].body).toBeUndefined();
  });

  it('apiPut and apiPatch send their verbs with bodies', async () => {
    const putFetch = fetchReturning(jsonResponse({ id: 'c', label: 'C' }));
    await expect(
      apiPut('/x', { label: 'C' }, { schema: WidgetSchema, fetchFn: putFetch })
    ).resolves.toEqual({ id: 'c', label: 'C' });
    expect((putFetch.mock.calls[0] as [string, RequestInit])[1].method).toBe('PUT');

    const putBare = fetchReturning(jsonResponse({ ok: 1 }));
    await expect(apiPut('/x', { v: 2 }, { fetchFn: putBare })).resolves.toEqual({
      ok: 1,
    });

    const patchFetch = fetchReturning(jsonResponse({ id: 'd', label: 'D' }));
    await expect(
      apiPatch('/x', { label: 'D' }, { schema: WidgetSchema, fetchFn: patchFetch })
    ).resolves.toEqual({ id: 'd', label: 'D' });
    expect((patchFetch.mock.calls[0] as [string, RequestInit])[1].method).toBe(
      'PATCH'
    );

    const patchBare = fetchReturning(jsonResponse({ ok: 2 }));
    await expect(apiPatch('/x', undefined, { fetchFn: patchBare })).resolves.toEqual({
      ok: 2,
    });
  });

  it('apiDelete sends DELETE, with and without a schema', async () => {
    const withSchema = fetchReturning(jsonResponse({ id: 'e', label: 'E' }));
    await expect(
      apiDelete('/x', { schema: WidgetSchema, fetchFn: withSchema })
    ).resolves.toEqual({ id: 'e', label: 'E' });
    expect((withSchema.mock.calls[0] as [string, RequestInit])[1].method).toBe(
      'DELETE'
    );

    const noSchema = fetchReturning(jsonResponse({ success: true }));
    await expect(apiDelete('/x', { fetchFn: noSchema })).resolves.toEqual({
      success: true,
    });
  });

  it('the api object exposes the same helpers', async () => {
    const fetchFn = fetchReturning(jsonResponse({ id: 'f', label: 'F' }));
    await expect(api.get('/x', { schema: WidgetSchema, fetchFn })).resolves.toEqual({
      id: 'f',
      label: 'F',
    });
    expect(api.post).toBe(apiPost);
    expect(api.put).toBe(apiPut);
    expect(api.patch).toBe(apiPatch);
    expect(api.delete).toBe(apiDelete);
  });
});
