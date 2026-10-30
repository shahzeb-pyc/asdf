/**
 * Workers-native fetch timeout helpers (spec 149 backend revision §3.1).
 * Ported from apps/web/src/lib/http/fetch-with-timeout.ts with no
 * behaviour change: `fetchWithTimeout` bounds a whole small exchange,
 * `fetchWithTimeoutToHeaders` bounds only the time to response headers
 * so a slow media body is never aborted mid-stream. `setTimeout`
 * inside one invocation is allowed in Workers.
 */

/** Budget for remote-media / download fetches (time-to-headers). */
export const MEDIA_FETCH_TIMEOUT_MS = 15_000;

type FetchFn = typeof fetch;

export function composeTimeoutSignal(
  callerSignal: AbortSignal | null | undefined,
  timeoutMs: number
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) {
    return timeoutSignal;
  }
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = MEDIA_FETCH_TIMEOUT_MS,
  fetchFn: FetchFn = globalThis.fetch
): Promise<Response> {
  return fetchFn(input, {
    ...init,
    signal: composeTimeoutSignal(init?.signal, timeoutMs),
  });
}

export async function fetchWithTimeoutToHeaders(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = MEDIA_FETCH_TIMEOUT_MS,
  fetchFn: FetchFn = globalThis.fetch
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init?.signal;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason);
    } else if (typeof callerSignal.addEventListener === 'function') {
      callerSignal.addEventListener(
        'abort',
        () => controller.abort(callerSignal.reason),
        { once: true }
      );
    }
  }
  const timer = setTimeout(() => {
    controller.abort(
      new Error(`Fetch timed out after ${timeoutMs}ms waiting for response headers`)
    );
  }, timeoutMs);
  try {
    return await fetchFn(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a resolve body (HTML page / JSON payload) with a hard cap.
 * Returns null when the body exceeds the cap or cannot be read —
 * callers treat that as "cannot resolve", never as a buffered whole
 * body. A hostile or huge page must not be able to blow the 128 MB
 * isolate (§3.4).
 */
export async function readBoundedText(
  response: Response,
  maxBytes: number
): Promise<string | null> {
  const declared = response.headers.get('content-length');
  if (declared) {
    const parsed = Number.parseInt(declared, 10);
    if (!Number.isNaN(parsed) && parsed > maxBytes) return null;
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) return null;
    return new TextDecoder().decode(buffer);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number
): Promise<unknown | null> {
  const text = await readBoundedText(response, maxBytes);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
