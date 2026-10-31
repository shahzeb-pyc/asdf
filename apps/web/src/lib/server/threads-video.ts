/**
 * Server-side Threads video publish (web route use — the Auto Repost
 * setup post). Same async shape as the worker's Threads publisher,
 * but self-contained for a Next route: create a VIDEO container with
 * the public video URL, poll its status, then publish on FINISHED.
 * Meta fetches `video_url` itself — there is NO upload endpoint and
 * no byte streaming here, unlike the Facebook reel path.
 *
 * Caption rule (Threads, contracts): at most 500 UTF-8-weighted
 * characters and 5 links. An over-long caption is rejected BEFORE
 * any fetch, with the plain contracts message — the caller records
 * the reel skipped, never truncated and never silently dropped.
 */

import { validateThreadsText } from '@fbuploadpro/contracts';

const GRAPH_BASE_URL = 'https://graph.threads.net/v1.0';

export class ThreadsVideoError extends Error {
  readonly step: string;
  readonly httpStatus: number | null;
  constructor(step: string, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'ThreadsVideoError';
    this.step = step;
    this.httpStatus = httpStatus;
  }
}

type FetchFn = typeof fetch;

interface GraphErrorBody {
  error?: { message?: string };
}

async function graphRequest(
  url: string,
  accessToken: string,
  init: { method: string; body?: Record<string, unknown> },
  step: string,
  fetchFn: FetchFn
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ThreadsVideoError(step, 'Threads could not complete this request. Please try again.');
  }
  const data = (await res.json().catch(() => ({}))) as GraphErrorBody & Record<string, unknown>;
  if (!res.ok || data.error) {
    throw new ThreadsVideoError(
      step,
      data.error?.message ?? 'Threads could not complete this request. Please try again.',
      res.status
    );
  }
  return data;
}

export async function publishThreadsVideo(params: {
  threadsUserId: string;
  accessToken: string;
  videoUrl: string;
  caption: string;
  fetchFn?: FetchFn;
  /** Injected in tests so polling does not sleep for real. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pollIntervalMs?: number | undefined;
  maxPolls?: number | undefined;
}): Promise<string> {
  const { threadsUserId, accessToken, videoUrl, caption } = params;
  const fetchFn = params.fetchFn ?? fetch;
  const sleep = params.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = params.pollIntervalMs ?? 15_000;
  const maxPolls = params.maxPolls ?? 12;

  const captionError = validateThreadsText(caption);
  if (captionError) {
    throw new ThreadsVideoError('caption', captionError);
  }

  const encodedUserId = encodeURIComponent(threadsUserId);
  const created = await graphRequest(
    `${GRAPH_BASE_URL}/${encodedUserId}/threads`,
    accessToken,
    {
      method: 'POST',
      body: {
        media_type: 'VIDEO',
        video_url: videoUrl,
        ...(caption ? { text: caption } : {}),
      },
    },
    'container-create',
    fetchFn
  );
  const containerId = created.id;
  if (typeof containerId !== 'string' || !containerId) {
    throw new ThreadsVideoError('container-create', 'Threads could not start this video. Please try again.');
  }

  let status = '';
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const statusData = await graphRequest(
      `${GRAPH_BASE_URL}/${encodeURIComponent(containerId)}?fields=status,error_message`,
      accessToken,
      { method: 'GET' },
      'container-status',
      fetchFn
    );
    status = typeof statusData.status === 'string' ? statusData.status : '';
    if (status === 'FINISHED') break;
    if (status === 'PUBLISHED') return containerId;
    if (status === 'ERROR') {
      throw new ThreadsVideoError(
        'container-status',
        typeof statusData.error_message === 'string' && statusData.error_message
          ? statusData.error_message
          : 'Threads could not prepare this video. Please try again.'
      );
    }
    if (status === 'EXPIRED') {
      throw new ThreadsVideoError('container-status', 'Threads could not prepare this video. Please try again.');
    }
    if (poll < maxPolls - 1) await sleep(pollIntervalMs);
  }
  if (status !== 'FINISHED') {
    throw new ThreadsVideoError(
      'container-status',
      'Threads is still preparing this video. It stays pending and will be retried on the next check.'
    );
  }

  const published = await graphRequest(
    `${GRAPH_BASE_URL}/${encodedUserId}/threads_publish`,
    accessToken,
    { method: 'POST', body: { creation_id: containerId } },
    'threads-publish',
    fetchFn
  );
  const mediaId = published.id;
  if (typeof mediaId !== 'string' || !mediaId) {
    throw new ThreadsVideoError('threads-publish', 'Threads could not publish this video. Please try again.');
  }
  return mediaId;
}
