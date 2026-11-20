import { NextResponse, type NextRequest } from 'next/server';
import {
  checkRateLimit,
  extractClientIp,
  RATE_LIMIT_WINDOW_MS,
} from './rate-limiter';

/**
 * Shared request guards for API routes (spec 139 Wave B, audit B1/C2):
 * IP rate limiting with the codebase's existing 429 shape, and a capped
 * streaming JSON body reader so no route buffers an unbounded body.
 *
 * The 429 shape matches the auth routes exactly:
 * `{ error, retryAfterSeconds }` plus a `Retry-After` header.
 */

/** Default cap for ordinary JSON request bodies (64 KiB). */
export const DEFAULT_JSON_BODY_LIMIT_BYTES = 64 * 1024;

/** Cap for legitimately large JSON payloads such as bulk enqueue (1 MiB). */
export const LARGE_JSON_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * Checks the per-IP rate limit for a route. Returns a 429 response when the
 * caller is over the limit, or null when the request may proceed.
 *
 * `options.scope` replaces the bare-IP key segment with a caller-chosen
 * bucket (e.g. `ws:<subdomain>`): callers whose legitimate burst exceeds
 * the per-IP cap — one workspace discovering pages across all its accounts
 * at once — scope the bucket per workspace instead of per IP. Without it
 * the key is exactly as before, so every other route is unaffected.
 */
export async function enforceIpRateLimit(
  request: NextRequest,
  keyPrefix: string,
  maxRequests: number,
  options: { windowMs?: number; scope?: string } = {}
): Promise<NextResponse | null> {
  const { windowMs = RATE_LIMIT_WINDOW_MS, scope } = options;
  const result = await checkRateLimit(
    scope ? `${keyPrefix}:${scope}` : `${keyPrefix}:ip:${extractClientIp(request.headers)}`,
    maxRequests,
    windowMs
  );
  if (result.allowed) return null;
  return NextResponse.json(
    {
      error: `Too many requests. Please wait ${result.retryAfterSeconds} seconds before trying again.`,
      retryAfterSeconds: result.retryAfterSeconds,
    },
    {
      status: 429,
      headers: { 'Retry-After': String(result.retryAfterSeconds) },
    }
  );
}

/** The standard 413 response for an oversized JSON body. */
export function bodyTooLargeResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Request body is too large.' },
    { status: 413 }
  );
}

export type ReadJsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'too-large' | 'invalid-json' };

/**
 * Reads and parses a JSON request body with a hard size cap.
 *
 * Streams the body and stops as soon as the cap is exceeded (the pattern
 * established by the csp-report route), so an oversized body is never
 * buffered in full. A declared Content-Length above the cap is rejected
 * before any bytes are read.
 */
export async function readJsonBody(
  request: NextRequest,
  maxBytes: number = DEFAULT_JSON_BODY_LIMIT_BYTES
): Promise<ReadJsonBodyResult> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false, reason: 'too-large' };
  }

  if (!request.body) {
    return { ok: false, reason: 'invalid-json' };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, reason: 'too-large' };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
}
