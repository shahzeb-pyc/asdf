/**
 * Typed API client (spec 137 §3.1) — the only way browser code talks
 * to the app's API.
 *
 * `apiFetch` owns URL construction (including the tenant base path),
 * headers, exactly one JSON parse per response, and the error
 * taxonomy: every call either returns schema-validated typed data or
 * throws an `ApiError`. It never retries and never swallows a failure.
 * An `AbortSignal` passed in (e.g. React Query's) is forwarded to
 * `fetch` untouched.
 *
 * Session-expiry navigation (session-global-check spec §2.3): a
 * 401 always throws a `session-expired` ApiError, but it only
 * navigates to login from foreground mutations. Queries, polls,
 * and refetches (GET) never navigate — their 401 surfaces as a
 * retryable error in that query, so one failed background call
 * cannot yank the whole page. `bounceOnUnauthorized` overrides
 * the method default either way for call sites that need the
 * other behaviour. The global session check (not this client) is
 * what bounces a proven-dead session in the background.
 */

import type { z } from 'zod';
import {
  abortedError,
  httpError,
  networkError,
  parseError,
  sessionExpiredError,
  type ApiError,
} from './errors';
import { handleSessionExpired } from './session-expired';
import { reportError } from '../report-error';

export type ApiQueryParams = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface ApiFetchOptions<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Zod schema the response is validated against. Mandatory in spirit:
   *  calls without one return `unknown` and must narrow before use. */
  schema?: S;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  query?: ApiQueryParams;
  /** Forwarded to `fetch` as-is (React Query passes its own signal). */
  signal?: AbortSignal;
  /** Test seam: replaces the global `fetch`. */
  fetchFn?: typeof fetch;
  /**
   * Whether a 401 from this call navigates to login (session-global-
   * check spec §2.3). Defaults by method: mutations navigate,
   * GETs do not. Pass `false` to keep a foreground mutation from
   * navigating, or `true` to make a GET navigate.
   */
  bounceOnUnauthorized?: boolean;
}

/**
 * Build a tenant API path — `/api/tenant/<subdomain><path>`.
 * Call sites must never hand-build this string again.
 */
export function buildTenantApiPath(subdomain: string, path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `/api/tenant/${encodeURIComponent(subdomain)}${cleanPath}`;
}

/** Append query params to a path, skipping null/undefined values. */
export function buildUrl(path: string, query?: ApiQueryParams): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  const queryString = params.toString();
  if (!queryString) return path;
  return `${path}?${queryString}`;
}

function isJsonBody(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === 'object' &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    !(body instanceof ArrayBuffer) &&
    !(body instanceof URLSearchParams)
  );
}

function serializeBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (isJsonBody(body)) return JSON.stringify(body);
  return body as BodyInit;
}

function buildHeaders(body: unknown, extra?: Record<string, string>): HeadersInit {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (isJsonBody(body)) headers['Content-Type'] = 'application/json';
  return { ...headers, ...extra };
}

function isAbortRejection(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

interface ServerErrorShape {
  message: string;
  code: string | undefined;
}

/** Extract the server's message/code from an error body, whatever of
 *  the app's three error shapes it used: `{error}`, `{error, message}`,
 *  or `{code, message}`. */
function readServerError(parsed: unknown, status: number): ServerErrorShape {
  const fallback = `Request failed with status ${status}`;
  if (parsed === null || typeof parsed !== 'object') return { message: fallback, code: undefined };
  const body = parsed as Record<string, unknown>;
  const errorField = typeof body.error === 'string' ? body.error : undefined;
  const messageField = typeof body.message === 'string' ? body.message : undefined;
  const codeField = typeof body.code === 'string' ? body.code : undefined;
  const code = codeField ?? (messageField !== undefined ? errorField : undefined);
  const message = messageField ?? errorField ?? fallback;
  return { message, code };
}

async function performRequest(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (error) {
    if (isAbortRejection(error, signal)) throw abortedError(error);
    throw networkError(error);
  }
}

async function readResponseText(
  response: Response,
  signal?: AbortSignal
): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    if (isAbortRejection(error, signal)) throw abortedError(error);
    throw networkError(error);
  }
}

/** The single JSON parse every response goes through. */
function parseJsonBody(rawText: string): { parsed: unknown; parsedOk: boolean } {
  if (rawText.length === 0) return { parsed: undefined, parsedOk: true };
  try {
    return { parsed: JSON.parse(rawText) as unknown, parsedOk: true };
  } catch {
    return { parsed: undefined, parsedOk: false };
  }
}

function throwForErrorResponse(
  response: Response,
  parsed: unknown,
  parsedOk: boolean,
  method: string,
  bounceOnUnauthorized?: boolean
): never {
  const server = readServerError(parsedOk ? parsed : undefined, response.status);
  const errorOptions = {
    cause: parsed,
    ...(server.code !== undefined ? { code: server.code } : {}),
  };
  if (response.status === 401) {
    // Session-global-check spec §2.3: only foreground mutations
    // navigate on 401 by default. A GET 401 (query, poll, refetch)
    // still throws session-expired, but navigating on it is what
    // turned one failed background call into a full-page bounce.
    const shouldBounce = bounceOnUnauthorized ?? method !== 'GET';
    if (shouldBounce) {
      void handleSessionExpired();
    }
    throw sessionExpiredError(errorOptions);
  }
  throw httpError(response.status, server.message, errorOptions);
}

function parseSuccessResponse(
  response: Response,
  rawText: string,
  parsed: unknown,
  parsedOk: boolean,
  schema: z.ZodTypeAny | undefined,
  path: string,
  method: string
): unknown {
  if (rawText.length === 0) {
    if (!schema) return undefined;
    const error = parseError('The server returned an empty response.', {
      status: response.status,
    });
    reportError(error, { source: 'api-client', path, method });
    throw error;
  }
  if (!parsedOk) {
    const error = parseError('The server returned a response that was not valid JSON.', {
      status: response.status,
      cause: rawText,
    });
    reportError(error, { source: 'api-client', path, method });
    throw error;
  }
  if (schema) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const error: ApiError = parseError(
        'The server returned data in an unexpected shape.',
        { status: response.status, cause: result.error, issues: result.error.issues }
      );
      reportError(error, { source: 'api-client', path, method });
      throw error;
    }
    return result.data;
  }
  return parsed;
}

export async function apiFetch<S extends z.ZodTypeAny>(
  path: string,
  options: ApiFetchOptions<S> & { schema: S }
): Promise<z.infer<S>>;
export async function apiFetch(path: string, options?: ApiFetchOptions): Promise<unknown>;
export async function apiFetch(
  path: string,
  options: ApiFetchOptions = {}
): Promise<unknown> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const url = buildUrl(path, options.query);
  const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET');

  const init: RequestInit = {
    method,
    headers: buildHeaders(options.body, options.headers),
  };
  const bodyInit = serializeBody(options.body);
  if (bodyInit !== undefined) init.body = bodyInit;
  if (options.signal) init.signal = options.signal;

  const response = await performRequest(fetchFn, url, init, options.signal);
  const rawText = await readResponseText(response, options.signal);
  const { parsed, parsedOk } = parseJsonBody(rawText);
  if (!response.ok) {
    throwForErrorResponse(response, parsed, parsedOk, method, options.bounceOnUnauthorized);
  }
  return parseSuccessResponse(
    response,
    rawText,
    parsed,
    parsedOk,
    options.schema,
    path,
    method
  );
}

type SchemaOption<S extends z.ZodTypeAny> = ApiFetchOptions<S> & { schema: S };
type NoSchemaOption = Omit<ApiFetchOptions, 'schema'>;

export function apiGet<S extends z.ZodTypeAny>(
  path: string,
  options: SchemaOption<S>
): Promise<z.infer<S>>;
export function apiGet(path: string, options?: NoSchemaOption): Promise<unknown>;
export function apiGet(path: string, options: ApiFetchOptions = {}): Promise<unknown> {
  return apiFetch(path, { ...options, method: 'GET' });
}

export function apiPost<S extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  options: SchemaOption<S>
): Promise<z.infer<S>>;
export function apiPost(
  path: string,
  body?: unknown,
  options?: NoSchemaOption
): Promise<unknown>;
export function apiPost(
  path: string,
  body?: unknown,
  options: ApiFetchOptions = {}
): Promise<unknown> {
  return apiFetch(path, { ...options, method: 'POST', body });
}

export function apiPut<S extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  options: SchemaOption<S>
): Promise<z.infer<S>>;
export function apiPut(
  path: string,
  body?: unknown,
  options?: NoSchemaOption
): Promise<unknown>;
export function apiPut(
  path: string,
  body?: unknown,
  options: ApiFetchOptions = {}
): Promise<unknown> {
  return apiFetch(path, { ...options, method: 'PUT', body });
}

export function apiPatch<S extends z.ZodTypeAny>(
  path: string,
  body: unknown,
  options: SchemaOption<S>
): Promise<z.infer<S>>;
export function apiPatch(
  path: string,
  body?: unknown,
  options?: NoSchemaOption
): Promise<unknown>;
export function apiPatch(
  path: string,
  body?: unknown,
  options: ApiFetchOptions = {}
): Promise<unknown> {
  return apiFetch(path, { ...options, method: 'PATCH', body });
}

export function apiDelete<S extends z.ZodTypeAny>(
  path: string,
  options: SchemaOption<S>
): Promise<z.infer<S>>;
export function apiDelete(path: string, options?: NoSchemaOption): Promise<unknown>;
export function apiDelete(path: string, options: ApiFetchOptions = {}): Promise<unknown> {
  return apiFetch(path, { ...options, method: 'DELETE' });
}

/** Typed verb helpers — the call-site surface of the client. */
export const api = {
  get: apiGet,
  post: apiPost,
  put: apiPut,
  patch: apiPatch,
  delete: apiDelete,
};
