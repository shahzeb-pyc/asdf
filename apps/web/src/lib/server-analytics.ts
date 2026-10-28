/**
 * Server-side analytics (Next.js route handlers / server components).
 *
 * Uses posthog-node. Reads POSTHOG_KEY / POSTHOG_HOST from process.env
 * (server-only — never exposed to the browser). All helpers are safe no-ops
 * when the key is not configured, so the app runs fine without PostHog.
 */
import { PostHog } from 'posthog-node';

const POSTHOG_KEY = process.env.POSTHOG_KEY;
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!POSTHOG_KEY) return null;
  if (!client) {
    client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      // Flush immediately: serverless functions may not survive to a timer.
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return client;
}

interface ErrorInfo {
  message: string;
  stack?: string | undefined;
  /** Facebook Graph error code, when the thrown value carries one. */
  code?: number | undefined;
  subcode?: number | undefined;
  /** Publish-flow step the failure was recorded at, when carried. */
  step?: string | undefined;
  httpStatus?: number | undefined;
  fbtraceId?: string | undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Structured fields a thrown value may carry. Only these named fields
 * are picked up — never tokens, secrets, or request bodies. A plain
 * object without a message no longer collapses to "[object Object]".
 */
function structuredFields(record: Record<string, unknown>): Omit<ErrorInfo, 'message' | 'stack'> {
  return {
    code: finiteNumber(record.code),
    subcode: finiteNumber(record.subcode),
    step: nonEmptyString(record.step),
    // Discovery helpers attach `.status`; Graph calls attach `.httpStatus`.
    httpStatus: finiteNumber(record.httpStatus) ?? finiteNumber(record.status),
    fbtraceId: nonEmptyString(record.fbtraceId),
  };
}

function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      ...structuredFields(error as unknown as Record<string, unknown>),
    };
  }
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return {
      message: nonEmptyString(record.message) ?? 'Unknown error',
      ...structuredFields(record),
    };
  }
  return { message: String(error) };
}

/**
 * Capture an exception server-side. Flushes immediately so serverless
 * invocations don't lose the event.
 */
export async function captureServerException(
  error: unknown,
  context?: Record<string, unknown>
): Promise<void> {
  const ph = getClient();
  if (!ph) return;
  const info = toErrorInfo(error);
  try {
    ph.capture({
      distinctId: 'server',
      event: '$exception',
      properties: {
        $exception_message: info.message,
        $exception_stack: info.stack,
        // Structured diagnostics, when present — these survive even
        // when the caller passes an already-converted info object,
        // because toErrorInfo above re-extracts them from it.
        ...(info.code !== undefined ? { graph_code: info.code } : {}),
        ...(info.subcode !== undefined ? { graph_subcode: info.subcode } : {}),
        ...(info.step !== undefined ? { publish_step: info.step } : {}),
        ...(info.httpStatus !== undefined ? { http_status: info.httpStatus } : {}),
        ...(info.fbtraceId !== undefined ? { fbtrace_id: info.fbtraceId } : {}),
        ...context,
      },
    });
    await ph.flush();
  } catch {
    // Never let telemetry break the request.
  }
}

/**
 * Drop-in replacement for console.error at high-value error sites:
 * keeps the console log AND sends a structured event to PostHog.
 * Fire-and-forget — never throws, never blocks the caller on failure.
 */
export function logServerError(
  message: string,
  error?: unknown,
  context?: Record<string, unknown>
): void {
  console.error(message, error ?? '');
  const info = error !== undefined ? toErrorInfo(error) : { message };
  void captureServerException(info, { log_message: message, ...context });
}
