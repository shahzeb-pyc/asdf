/**
 * Server-side Instagram Reel publish (web route use — the Auto Repost
 * setup flow's immediate latest-reel post for Instagram targets).
 *
 * Instagram's model is the opposite of Facebook's: Meta fetches the
 * media from a public URL, so no bytes are streamed here. Create a
 * REELS container from the resolved no-watermark TikTok URL, poll its
 * status until FINISHED, then publish it. This mirrors the worker's
 * Instagram publisher container flow, in a web-route shape (short
 * poll interval, bounded polls) like facebook-reel.ts is the web
 * shape of the worker's Facebook reel upload.
 *
 * Failure discipline: errors carry a plain-language message (never
 * a token, never raw Graph detail beyond code/subcode for logging
 * by callers). An auth error (190) is the plain expired message.
 * If the container is still processing when the poll budget runs
 * out, the caller treats the post as pending — the same
 * failure-stays-pending semantics as the Facebook immediate post.
 */

const GRAPH_BASE_URL = 'https://graph.instagram.com/v26.0';

export class InstagramReelError extends Error {
  readonly step: string;
  readonly httpStatus: number | null;
  readonly code: number | undefined;
  readonly errorSubcode: number | undefined;
  constructor(
    step: string,
    message: string,
    httpStatus: number | null = null,
    graph?: { code?: number | undefined; errorSubcode?: number | undefined }
  ) {
    super(message);
    this.name = 'InstagramReelError';
    this.step = step;
    this.httpStatus = httpStatus;
    this.code = graph?.code;
    this.errorSubcode = graph?.errorSubcode;
  }
}

export const INSTAGRAM_REEL_EXPIRED_MESSAGE =
  'This Instagram account has expired. Reconnect the account and try again.';

type FetchFn = typeof fetch;

type GraphErrorBody = {
  error?: { message?: string; code?: number; error_subcode?: number };
};

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
    throw new InstagramReelError(step, 'Instagram could not complete this request. Please try again.');
  }
  const data = (await res.json().catch(() => ({}))) as GraphErrorBody & Record<string, unknown>;
  if (!res.ok || data.error) {
    const code = data.error?.code;
    const message =
      code === 190
        ? INSTAGRAM_REEL_EXPIRED_MESSAGE
        : (data.error?.message ?? 'Instagram could not complete this request. Please try again.');
    throw new InstagramReelError(step, message, res.status, {
      code,
      errorSubcode: data.error?.error_subcode,
    });
  }
  return data;
}

export async function publishInstagramReel(params: {
  igUserId: string;
  accessToken: string;
  videoUrl: string;
  caption: string;
  coverUrl?: string | null;
  fetchFn?: FetchFn;
  /** Poll interval between container status reads (tests pass 0). */
  pollIntervalMs?: number;
  /** Max status reads before giving up as still-processing. */
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<string> {
  const {
    igUserId,
    accessToken,
    videoUrl,
    caption,
    coverUrl,
    fetchFn = fetch,
    pollIntervalMs = 5_000,
    maxPolls = 12,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = params;
  const encodedIgUserId = encodeURIComponent(igUserId);

  const created = await graphRequest(
    `${GRAPH_BASE_URL}/${encodedIgUserId}/media`,
    accessToken,
    {
      method: 'POST',
      body: {
        media_type: 'REELS',
        video_url: videoUrl,
        caption,
        ...(coverUrl ? { cover_url: coverUrl } : {}),
      },
    },
    'reel-container-create',
    fetchFn
  );
  const containerId = created.id;
  if (typeof containerId !== 'string' || !containerId) {
    throw new InstagramReelError(
      'reel-container-create',
      'Instagram could not prepare this reel. Please try again.'
    );
  }

  let statusCode = '';
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    const status = await graphRequest(
      `${GRAPH_BASE_URL}/${encodeURIComponent(containerId)}?fields=status_code`,
      accessToken,
      { method: 'GET' },
      'reel-container-status',
      fetchFn
    );
    statusCode = typeof status.status_code === 'string' ? status.status_code : '';
    if (statusCode === 'FINISHED' || statusCode === 'PUBLISHED') break;
    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      throw new InstagramReelError(
        'reel-container-status',
        'Instagram could not prepare this reel. Check the video and try again.'
      );
    }
    if (attempt < maxPolls - 1) await sleep(pollIntervalMs);
  }
  if (statusCode === 'PUBLISHED') return containerId;
  if (statusCode !== 'FINISHED') {
    throw new InstagramReelError(
      'reel-container-status',
      'Instagram is still preparing this reel. It will be tried again at the next check.'
    );
  }

  try {
    const published = await graphRequest(
      `${GRAPH_BASE_URL}/${encodedIgUserId}/media_publish`,
      accessToken,
      { method: 'POST', body: { creation_id: containerId } },
      'reel-publish',
      fetchFn
    );
    const mediaId = published.id;
    if (typeof mediaId !== 'string' || !mediaId) {
      throw new InstagramReelError(
        'reel-publish',
        'Instagram could not publish this reel. Please try again.'
      );
    }
    return mediaId;
  } catch (err) {
    // Ambiguous failure: re-read the container before deciding —
    // PUBLISHED means the reel is live despite the error, so the
    // caller must settle it published, never publish it twice.
    if (err instanceof InstagramReelError && err.step === 'reel-publish') {
      const recheck = await graphRequest(
        `${GRAPH_BASE_URL}/${encodeURIComponent(containerId)}?fields=status_code`,
        accessToken,
        { method: 'GET' },
        'reel-container-status',
        fetchFn
      ).catch(() => null);
      if (recheck && recheck.status_code === 'PUBLISHED') return containerId;
    }
    throw err;
  }
}
