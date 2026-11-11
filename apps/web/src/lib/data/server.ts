/**
 * Server-first data helpers (spec 137 §3.2.4) — server code only;
 * never import this module from a client component.
 *
 * The rule: every route's initial data is fetched in its server
 * component, in this preference order —
 *   1. the existing server-side data functions in `src/lib/server/`
 *      (the same code the API routes call; no HTTP round-trip), via
 *      `fetchServerFirst({ serverFn, … })`;
 *   2. where no server function exists, `serverApiFetch` — the
 *      cookie-forwarding server variant of the typed API client.
 *
 * The server variant shares PR-A1a's zod schemas and error taxonomy,
 * but differs from the browser client in exactly one way: it NEVER
 * redirects and never touches the client 401 handler. A server-side
 * 401 throws a `session-expired` ApiError and the segment's
 * layout/boundary path performs the redirect.
 *
 * Hand-off: `createServerQueryClient` + `prefetchServerQueries`
 * prefetch a route's initial data into a throwaway server QueryClient
 * and dehydrate it; the route renders `<DataHydration>` (provider.tsx)
 * with that state so client islands read from the cache.
 */

import { dehydrate, QueryClient, type DehydratedState } from '@tanstack/react-query';
import type { z } from 'zod';
import {
  abortedError,
  httpError,
  networkError,
  parseError,
  sessionExpiredError,
  type ApiError,
} from '../api/errors';
import { reportError } from '../report-error';
import { createQueryClient } from './query-client';

export interface ServerApiFetchOptions<S extends z.ZodTypeAny = z.ZodTypeAny> {
  schema?: S;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Absolute origin override (tests). Defaults to `getServerBaseUrl()`. */
  baseUrl?: string;
  /** Cookie header override (tests). Defaults to the request cookies. */
  cookieHeader?: string;
  signal?: AbortSignal;
  /** Test seam: replaces the global `fetch`. */
  fetchFn?: typeof fetch;
}

/** Strip trailing slashes with a plain scan, not a regex: Sonar's
 * super-linear-backtracking rule flags the `/\/+$/` pattern. */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

/** Origin the server variant calls back into our own API on.
 * Fallback only — see `getRequestBaseUrl()`: on Vercel this is a
 * `*.vercel.app` deployment URL, which Vercel Authentication gates,
 * so it must never be the loopback origin when a request host exists. */
export function getServerBaseUrl(): string {
  // The current deployment's own URL must win: on Vercel previews
  // NEXT_PUBLIC_APP_URL is the production URL, so preferring it would
  // send every server-side prefetch to production instead of this
  // deployment's own API.
  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) return stripTrailingSlashes(`https://${vercelUrl}`);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) return stripTrailingSlashes(appUrl);
  return 'http://localhost:3000';
}

/**
 * Loopback origin for server-side API calls (spec 170 F1).
 *
 * The incoming request's own host wins over `getServerBaseUrl()`:
 * on Vercel `VERCEL_URL` is a `*.vercel.app` deployment URL gated by
 * Vercel Authentication, so a loopback there is 302-redirected to the
 * SSO wall, which answers 200 HTML — `serverApiFetch` then fails JSON
 * parsing and the prefetch silently dehydrates nothing (the browser
 * refetches on mount). The request arrived on an unwalled host (the
 * tenant custom domain), so looping back to that same host reaches
 * the app. No request context (tests, scripts) falls back to
 * `getServerBaseUrl()`; an explicit `baseUrl` still wins everywhere.
 */
export async function getRequestBaseUrl(): Promise<string> {
  try {
    const { headers } = await import('next/headers');
    const store = await headers();
    const host = store.get('host');
    if (host) {
      const forwardedProto = store
        .get('x-forwarded-proto')
        ?.split(',')[0]
        ?.trim();
      const isLocal =
        host.startsWith('localhost') ||
        host.startsWith('127.') ||
        host.startsWith('[::1]');
      const protocol = forwardedProto ?? (isLocal ? 'http' : 'https');
      return stripTrailingSlashes(`${protocol}://${host}`);
    }
  } catch {
    // No request context (tests, scripts, static generation): the
    // env fallback below is the designed default, not an error, so
    // nothing is reported here. A prefetch that then fails on the
    // fallback origin is still reported once, with its query key,
    // by prefetchServerQueries — that is the single report per
    // failure this module's contract promises.
  }
  return getServerBaseUrl();
}

async function resolveCookieHeader(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) return explicit;
  try {
    const { cookies } = await import('next/headers');
    const store = await cookies();
    return store.toString();
  } catch (error) {
    reportError(error, { source: 'data-server-cookies' });
    return '';
  }
}

function isAbortRejection(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function mapFetchError(error: unknown, signal?: AbortSignal): ApiError {
  if (isAbortRejection(error, signal)) return abortedError(error);
  return networkError(error);
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

function readServerMessage(parsed: unknown, status: number): { message: string; code: string | undefined } {
  const fallback = `Request failed with status ${status}`;
  if (parsed === null || typeof parsed !== 'object') {
    return { message: fallback, code: undefined };
  }
  const body = parsed as Record<string, unknown>;
  const errorField = typeof body.error === 'string' ? body.error : undefined;
  const messageField = typeof body.message === 'string' ? body.message : undefined;
  const codeField = typeof body.code === 'string' ? body.code : undefined;
  const code = codeField ?? (messageField !== undefined ? errorField : undefined);
  const message = messageField ?? errorField ?? fallback;
  return { message, code };
}

export async function serverApiFetch<S extends z.ZodTypeAny>(
  path: string,
  options: ServerApiFetchOptions<S> & { schema: S }
): Promise<z.infer<S>>;
export async function serverApiFetch(
  path: string,
  options?: ServerApiFetchOptions
): Promise<unknown>;
export async function serverApiFetch(
  path: string,
  options: ServerApiFetchOptions = {}
): Promise<unknown> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  // Absolute URLs skip the loopback origin entirely; relative paths
  // loop back to the request's own host (getRequestBaseUrl).
  const url = path.startsWith('http')
    ? path
    : `${options.baseUrl ?? (await getRequestBaseUrl())}${path.startsWith('/') ? path : `/${path}`}`;
  const method = options.method ?? (options.body !== undefined ? 'POST' : 'GET');
  const cookieHeader = await resolveCookieHeader(options.cookieHeader);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (isJsonBody(options.body)) headers['Content-Type'] = 'application/json';
  if (cookieHeader) headers.Cookie = cookieHeader;
  Object.assign(headers, options.headers);

  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    init.body = isJsonBody(options.body)
      ? JSON.stringify(options.body)
      : (options.body as BodyInit);
  }
  if (options.signal) init.signal = options.signal;

  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch (error) {
    throw mapFetchError(error, options.signal);
  }

  let rawText: string;
  try {
    rawText = await response.text();
  } catch (error) {
    throw mapFetchError(error, options.signal);
  }

  let parsed: unknown;
  let parsedOk = true;
  if (rawText.length === 0) {
    parsed = undefined;
  } else {
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      parsed = undefined;
      parsedOk = false;
    }
  }

  if (!response.ok) {
    const server = readServerMessage(parsedOk ? parsed : undefined, response.status);
    const errorOptions = {
      cause: parsed,
      ...(server.code !== undefined ? { code: server.code } : {}),
    };
    if (response.status === 401) throw sessionExpiredError(errorOptions);
    throw httpError(response.status, server.message, errorOptions);
  }

  if (rawText.length === 0) {
    if (!options.schema) return undefined;
    const error = parseError('The server returned an empty response.', {
      status: response.status,
    });
    reportError(error, { source: 'data-server', path, method });
    throw error;
  }
  if (!parsedOk) {
    const error = parseError('The server returned a response that was not valid JSON.', {
      status: response.status,
      cause: rawText,
    });
    reportError(error, { source: 'data-server', path, method });
    throw error;
  }
  if (options.schema) {
    const result = options.schema.safeParse(parsed);
    if (!result.success) {
      const error: ApiError = parseError(
        'The server returned data in an unexpected shape.',
        { status: response.status, cause: result.error, issues: result.error.issues }
      );
      reportError(error, { source: 'data-server', path, method });
      throw error;
    }
    return result.data;
  }
  return parsed;
}

export interface ServerFirstOptions<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Preference 1: an existing `src/lib/server/` data function. */
  serverFn?: (() => Promise<z.infer<S>>) | undefined;
  /** Preference 2: an API path for the cookie-forwarding server variant. */
  path?: string | undefined;
  schema: S;
  fetchOptions?: Omit<ServerApiFetchOptions<S>, 'schema'> | undefined;
}

/**
 * Fetch initial data server-first (spec §3.2.4 preference order):
 * the `lib/server` function when one exists, otherwise the
 * cookie-forwarding server API variant.
 */
export async function fetchServerFirst<S extends z.ZodTypeAny>(
  options: ServerFirstOptions<S>
): Promise<z.infer<S>> {
  if (options.serverFn) return options.serverFn();
  if (options.path) {
    return serverApiFetch(options.path, {
      ...options.fetchOptions,
      schema: options.schema,
    }) as Promise<z.infer<S>>;
  }
  throw new Error(
    'fetchServerFirst requires either a serverFn (preferred) or a path.'
  );
}

/** A fresh QueryClient for one server render (never shared across requests). */
export function createServerQueryClient(subdomain?: string): QueryClient {
  return createQueryClient(subdomain);
}

export interface ServerPrefetchEntry {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
}

/**
 * Prefetch a route's initial data set (in parallel) into the server
 * client and return the dehydrated state for `<DataHydration>`.
 *
 * Never throws: a failed entry leaves its key out of the dehydrated
 * state and the client island fetches on mount instead. The failure
 * is still reported through `reportError` — a prefetch that dies
 * silently is how the accounts prefetch stayed dead (spec 170 F1:
 * the Vercel Authentication wall on the loopback origin) with
 * nothing in the server logs to show for it.
 */
export async function prefetchServerQueries(
  client: QueryClient,
  entries: readonly ServerPrefetchEntry[]
): Promise<DehydratedState> {
  await Promise.all(
    entries.map((entry) =>
      client.prefetchQuery({
        queryKey: entry.queryKey as unknown[],
        queryFn: entry.queryFn,
      })
    )
  );
  for (const entry of entries) {
    const state = client.getQueryState(entry.queryKey as unknown[]);
    if (state?.status === 'error') {
      reportError(state.error, {
        source: 'data-server-prefetch',
        queryKey: entry.queryKey,
      });
    }
  }
  return dehydrate(client);
}
