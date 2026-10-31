import type { ThreadsPublishNowStep } from '@fbuploadpro/contracts';

/**
 * Threads container publish, extracted verbatim from the Threads
 * Publish Now route (apps/web/src/app/api/tenant/[subdomain]
 * /threads/publish-now/route.ts) so the state machine is testable
 * with a mocked Threads API. The route keeps its POST logic and
 * imports everything here; behaviour is unchanged. Poll options
 * exist only for tests: production callers omit them and get
 * the spec values (every 10 seconds, up to 12 polls, 2 minutes).
 */

const GRAPH_BASE_URL = 'https://graph.threads.net/v1.0';
const GRAPH_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 10_000;
const POLL_MAX_ATTEMPTS = 12;

const STEPS: ReadonlySet<string> = new Set([
  'container-create',
  'container-status',
  'container-publish',
  'media-fetch',
  'reply',
  'publish',
]);

export interface ThreadsGraphFailure {
  code?: number | undefined;
  subcode?: number | undefined;
  message: string;
  step?: ThreadsPublishNowStep | undefined;
  httpStatus?: number | undefined;
  fbtraceId?: string | undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function toThreadsGraphFailure(error: unknown): ThreadsGraphFailure {
  const record = (error ?? {}) as Record<string, unknown>;
  return {
    code: finiteNumber(record.code),
    subcode: finiteNumber(record.subcode),
    message: nonEmptyString(record.message) ?? 'Publishing failed. Please try again.',
    step:
      typeof record.step === 'string' && STEPS.has(record.step)
        ? (record.step as ThreadsPublishNowStep)
        : undefined,
    httpStatus: finiteNumber(record.httpStatus) ?? finiteNumber(record.status),
    fbtraceId: nonEmptyString(record.fbtraceId),
  };
}

function steppedError(message: string, step: ThreadsPublishNowStep): Error {
  const error = new Error(message);
  (error as unknown as Record<string, unknown>).step = step;
  return error;
}

export function threadsFriendlyReason(error: unknown): string {
  const failure = toThreadsGraphFailure(error);
  if (failure.code === 190) {
    return 'Your Threads connection has expired. Reconnect the account and try again.';
  }
  return failure.message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphRequest(
  path: string,
  accessToken: string,
  init: { method: string; body?: Record<string, unknown> },
  step: ThreadsPublishNowStep
): Promise<Record<string, unknown>> {
  const response = await fetch(`${GRAPH_BASE_URL}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: {
      message?: string;
      code?: number;
      error_subcode?: number;
      fbtrace_id?: string;
    };
  } & Record<string, unknown>;
  if (!response.ok || data.error) {
    throw {
      message: data.error?.message ?? 'Threads could not complete this request. Please try again.',
      code: data.error?.code,
      subcode: data.error?.error_subcode,
      step,
      httpStatus: response.status,
      fbtraceId: data.error?.fbtrace_id,
    };
  }
  return data;
}

async function createContainer(params: {
  threadsUserId: string;
  accessToken: string;
  mediaType: 'TEXT' | 'IMAGE' | 'VIDEO';
  text?: string | undefined;
  imageUrl?: string | undefined;
  videoUrl?: string | undefined;
  replyToId?: string | undefined;
}): Promise<string> {
  const body: Record<string, unknown> = { media_type: params.mediaType };
  if (params.text) body.text = params.text;
  if (params.imageUrl) body.image_url = params.imageUrl;
  if (params.videoUrl) body.video_url = params.videoUrl;
  if (params.replyToId) body.reply_to_id = params.replyToId;
  const data = await graphRequest(
    `/${encodeURIComponent(params.threadsUserId)}/threads`,
    params.accessToken,
    { method: 'POST', body },
    'container-create'
  );
  if (typeof data.id !== 'string' || !data.id) {
    throw steppedError('Threads could not prepare this post. Please try again.', 'container-create');
  }
  return data.id;
}

async function getContainerStatus(
  containerId: string,
  accessToken: string
): Promise<string | null> {
  try {
    const data = await graphRequest(
      `/${encodeURIComponent(containerId)}?fields=status,error_message`,
      accessToken,
      { method: 'GET' },
      'container-status'
    );
    return typeof data.status === 'string' ? data.status : null;
  } catch (error) {
    const failure = toThreadsGraphFailure(error);
    // Initial 404s are expected while the container propagates
    // (worker publisher, same rule): keep polling inside budget.
    if (failure.httpStatus === 404 || failure.code === 24) return null;
    throw error;
  }
}

async function publishContainer(params: {
  threadsUserId: string;
  accessToken: string;
  containerId: string;
}): Promise<string> {
  const data = await graphRequest(
    `/${encodeURIComponent(params.threadsUserId)}/threads_publish`,
    params.accessToken,
    { method: 'POST', body: { creation_id: params.containerId } },
    'container-publish'
  );
  if (typeof data.id !== 'string' || !data.id) {
    throw steppedError('Threads could not publish this post. Please try again.', 'container-publish');
  }
  return data.id;
}

/**
 * One container through the full state machine. Returns the
 * published media id. Throws on every failure — including
 * "still preparing" after the poll budget, which the caller
 * reports as a failed row with that specific reason.
 */
export async function publishOneThreadsContainer(params: {
  threadsUserId: string;
  accessToken: string;
  mediaType: 'TEXT' | 'IMAGE' | 'VIDEO';
  text?: string | undefined;
  imageUrl?: string | undefined;
  videoUrl?: string | undefined;
  replyToId?: string | undefined;
  poll?: { intervalMs?: number; maxAttempts?: number } | undefined;
}): Promise<string> {
  const pollIntervalMs = params.poll?.intervalMs ?? POLL_INTERVAL_MS;
  const pollMaxAttempts = params.poll?.maxAttempts ?? POLL_MAX_ATTEMPTS;
  const containerId = await createContainer(params);
  let status: string | null = null;
  for (let attempt = 0; attempt < pollMaxAttempts; attempt += 1) {
    status = await getContainerStatus(containerId, params.accessToken);
    if (status === 'FINISHED' || status === 'PUBLISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw steppedError(
        'Threads could not prepare this post. Check the media and try again.',
        'container-status'
      );
    }
    if (attempt < pollMaxAttempts - 1) await sleep(pollIntervalMs);
  }
  if (status === 'PUBLISHED') return containerId;
  if (status !== 'FINISHED') {
    throw steppedError(
      'Threads is still preparing this post. Check your Threads profile before retrying, so you do not post it twice.',
      'container-status'
    );
  }
  try {
    return await publishContainer({
      threadsUserId: params.threadsUserId,
      accessToken: params.accessToken,
      containerId,
    });
  } catch (error) {
    // The 24/4279009 propagation trap (worker publisher, same
    // rule): re-read the container status BEFORE any second
    // publish attempt — never a blind re-publish.
    const failure = toThreadsGraphFailure(error);
    const ambiguous =
      (failure.code === 24 && failure.subcode === 4279009) ||
      (failure.code === 24 && failure.httpStatus === 404);
    if (!ambiguous) throw error;
    const rechecked = await getContainerStatus(containerId, params.accessToken);
    if (rechecked === 'PUBLISHED') return containerId;
    if (rechecked === 'FINISHED') {
      return await publishContainer({
        threadsUserId: params.threadsUserId,
        accessToken: params.accessToken,
        containerId,
      });
    }
    throw error;
  }
}

export async function postThreadsReply(params: {
  threadsUserId: string;
  accessToken: string;
  postId: string;
  message: string;
  poll?: { intervalMs?: number; maxAttempts?: number } | undefined;
}): Promise<void> {
  await publishOneThreadsContainer({
    threadsUserId: params.threadsUserId,
    accessToken: params.accessToken,
    mediaType: 'TEXT',
    text: params.message,
    replyToId: params.postId,
    poll: params.poll,
  });
}

export async function threadsMediaUrlReachable(mediaUrl: string): Promise<boolean> {
  try {
    const head = await fetch(mediaUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000),
    });
    if (head.ok) return true;
    if (head.status === 405 || head.status === 501) {
      const ranged = await fetch(mediaUrl, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(15_000),
      });
      return ranged.ok;
    }
    return false;
  } catch {
    return false;
  }
}

export async function threadsMediaImageTooLarge(mediaUrl: string): Promise<boolean> {
  try {
    const head = await fetch(mediaUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15_000),
    });
    const size = head.headers.get('content-length');
    const parsed = size ? Number.parseInt(size, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 8 * 1024 * 1024;
  } catch {
    return false;
  }
}
