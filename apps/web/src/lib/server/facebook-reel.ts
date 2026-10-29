/**
 * Server-side Facebook Reel upload (web route use).
 *
 * Same 3-phase video_reels shape as the worker's fb-client and the
 * Publish Now route: start an upload session, stream the video
 * bytes from the source URL to Facebook's upload host, then finish
 * with video_state PUBLISHED. Bytes are streamed, never handed to
 * Facebook as a URL to fetch — the source (tikwm CDN) URL is fetched
 * here, server-side.
 *
 * Used by the TikTok mirror setup flow for the immediate latest-reel
 * post. The ongoing hourly posts use the worker's fb-client path.
 */

const GRAPH_BASE_URL = 'https://graph.facebook.com/v26.0';
const MEDIA_FETCH_TIMEOUT_MS = 300_000;

export class FacebookReelError extends Error {
  readonly step: string;
  readonly httpStatus: number | null;
  constructor(step: string, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'FacebookReelError';
    this.step = step;
    this.httpStatus = httpStatus;
  }
}

type FetchFn = typeof fetch;

async function graphPost(
  url: string,
  pageToken: string,
  body: Record<string, unknown>,
  step: string,
  fetchFn: FetchFn
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pageToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new FacebookReelError(step, 'Facebook could not complete this request. Please try again.');
  }
  const data = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number };
  };
  if (!res.ok || data.error) {
    throw new FacebookReelError(
      step,
      data.error?.message ?? 'Facebook could not complete this request. Please try again.',
      res.status
    );
  }
  return data;
}

export async function publishFacebookReel(params: {
  pageId: string;
  pageToken: string;
  videoUrl: string;
  caption: string;
  fetchFn?: FetchFn;
}): Promise<string> {
  const { pageId, pageToken, videoUrl, caption } = params;
  const fetchFn = params.fetchFn ?? fetch;
  const encodedPageId = encodeURIComponent(pageId);

  const start = await graphPost(
    `${GRAPH_BASE_URL}/${encodedPageId}/video_reels`,
    pageToken,
    { upload_phase: 'start' },
    'reel-start',
    fetchFn
  );
  const videoId = start.video_id;
  const uploadUrl = start.upload_url;
  if (typeof videoId !== 'string' || !videoId || typeof uploadUrl !== 'string' || !uploadUrl) {
    throw new FacebookReelError('reel-start', 'The reel could not be uploaded. Please try again.');
  }

  let videoRes: Response;
  try {
    videoRes = await fetchFn(videoUrl, {
      signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new FacebookReelError('media-fetch', 'The video could not be uploaded to Facebook.');
  }
  if (!videoRes.ok || !videoRes.body) {
    throw new FacebookReelError('media-fetch', 'The video could not be uploaded to Facebook.');
  }

  const uploadRes = await fetchFn(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${pageToken}`,
      offset: '0',
      'Content-Type': 'application/octet-stream',
    },
    body: videoRes.body,
    duplex: 'half',
  } as RequestInit);
  if (!uploadRes.ok) {
    const uploadData = (await uploadRes.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    throw new FacebookReelError(
      'reel-upload',
      uploadData.error?.message ?? 'The reel could not be uploaded. Please try again.',
      uploadRes.status
    );
  }

  const finish = await graphPost(
    `${GRAPH_BASE_URL}/${encodedPageId}/video_reels`,
    pageToken,
    {
      upload_phase: 'finish',
      video_state: 'PUBLISHED',
      description: caption,
      video_id: videoId,
    },
    'reel-finish',
    fetchFn
  );
  const postId = finish.post_id ?? finish.id ?? finish.video_id ?? videoId;
  if (typeof postId !== 'string' || !postId) {
    throw new FacebookReelError('reel-finish', 'The reel could not be completed. Please try again.');
  }
  return postId;
}
