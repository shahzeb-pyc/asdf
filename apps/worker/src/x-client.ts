import {
  InternalError,
  X_GIF_MAX_BYTES,
  X_IMAGE_MAX_BYTES,
  X_VIDEO_MAX_BYTES,
} from '@fbuploadpro/contracts';

// ==========================================
// X API client (spec 127)
// ==========================================
//
// Thin client over X API v2 (https://api.x.com/2) covering exactly what
// the X publisher and the token-refresh job need: chunked media upload,
// POST /2/tweets, the authorising user's timeline (for the D10
// duplicate-403 verification), GET /2/users/me, media alt-text
// metadata, and the OAuth 2.0 token endpoint (refresh grant; the
// connect flow's code exchange runs server-side in the web app).
//
// Media bytes STREAM: `uploadMediaChunked` reads the source response
// body incrementally and appends ~5 MB segments as they fill — a large
// file is never buffered whole in worker memory. (The single exception
// is a source that reports no Content-Length: the initialize call
// needs the total byte count up front, so segments are counted into
// memory as they are read, then appended. R2 public URLs report a
// length, so the streaming path is the production path.)
//
// Rate-limit state (`x-rate-limit-limit/-remaining/-reset`) is parsed
// from every response and returned/thrown alongside the result so the
// publisher can meter usage and set this item's retry delay (spec 127
// Scope.6, as amended by migration 20261102160000: no destination
// gate is fed from these headers anymore).

const X_API_BASE_URL = 'https://api.x.com/2';

/** Chunked-upload segment size (~5 MB per spec 127 Scope.3). */
export const X_MEDIA_SEGMENT_BYTES = 5 * 1024 * 1024;

const DEFAULT_STATUS_POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_STATUS_POLLS = 30;

export interface XRateLimitInfo {
  limit?: number | undefined;
  remaining?: number | undefined;
  /** Epoch seconds when the current window resets. */
  resetEpochSeconds?: number | undefined;
}

export function parseXRateLimitHeaders(headers?: Headers | null): XRateLimitInfo | undefined {
  if (!headers) return undefined;
  const num = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const info: XRateLimitInfo = {
    limit: num('x-rate-limit-limit'),
    remaining: num('x-rate-limit-remaining'),
    resetEpochSeconds: num('x-rate-limit-reset'),
  };
  if (info.limit === undefined && info.remaining === undefined && info.resetEpochSeconds === undefined) {
    return undefined;
  }
  return info;
}

export interface XApiErrorBody {
  title?: string | undefined;
  detail?: string | undefined;
  type?: string | undefined;
  /** OAuth-style error code (e.g. `invalid_grant`) when the token endpoint reports one. */
  error?: string | undefined;
}

export class XApiError extends Error {
  public readonly status: number;
  public readonly title: string | undefined;
  public readonly detail: string | undefined;
  public readonly errorCode: string | undefined;
  public readonly rateLimit: XRateLimitInfo | undefined;

  constructor(status: number, body: XApiErrorBody, rateLimit?: XRateLimitInfo) {
    const message =
      body.detail ?? body.title ?? body.error ?? `X API error: HTTP ${status}`;
    super(message);
    this.name = 'XApiError';
    this.status = status;
    this.title = body.title;
    this.detail = body.detail;
    this.errorCode = body.error;
    this.rateLimit = rateLimit;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** X's duplicate-content rejection (403) — the D10 verify path keys off this. */
  isDuplicateContent(): boolean {
    if (this.status !== 403) return false;
    const haystack = `${this.title ?? ''} ${this.detail ?? ''} ${this.message}`.toLowerCase();
    return haystack.includes('duplicate');
  }
}

export interface XCreateTweetPayload {
  text: string;
  mediaIds?: string[] | undefined;
  poll?: { options: string[]; durationMinutes: number } | undefined;
  quoteTweetId?: string | undefined;
  replySettings?: string | undefined;
}

export interface XTweet {
  id: string;
  text: string;
}

export interface XTokenResponse {
  accessToken: string;
  refreshToken?: string | null | undefined;
  expiresIn?: number | undefined;
  scope?: string | undefined;
}

export interface IXClient {
  createTweet(
    accessToken: string,
    payload: XCreateTweetPayload
  ): Promise<{ id: string; rateLimit?: XRateLimitInfo | undefined }>;
  getUserTimeline(
    accessToken: string,
    userId: string,
    maxResults?: number
  ): Promise<{ tweets: XTweet[]; rateLimit?: XRateLimitInfo | undefined }>;
  getMe(
    accessToken: string
  ): Promise<{ id: string; name: string; username: string; avatarUrl?: string | null | undefined }>;
  uploadMediaChunked(
    accessToken: string,
    input: {
      sourceUrl: string;
      mediaType: string;
      mediaCategory: string;
    }
  ): Promise<{ mediaId: string; rateLimit?: XRateLimitInfo | undefined }>;
  setMediaMetadata(accessToken: string, mediaId: string, altText: string): Promise<void>;
  refreshAccessToken(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<XTokenResponse>;
}

/**
 * Per-category byte caps (spec 127 Scope.3 conservative v1 limits, from
 * contracts). Enforced in `uploadMediaChunked` once the total byte count
 * is known and BEFORE the initialize call — an oversize file fails
 * permanently without any upload traffic.
 */
const MEDIA_CATEGORY_MAX_BYTES: Record<string, number> = {
  tweet_image: X_IMAGE_MAX_BYTES,
  tweet_gif: X_GIF_MAX_BYTES,
  tweet_video: X_VIDEO_MAX_BYTES,
};

function assertMediaWithinLimit(mediaCategory: string, totalBytes: number): void {
  const maxBytes = MEDIA_CATEGORY_MAX_BYTES[mediaCategory];
  if (maxBytes !== undefined && totalBytes > maxBytes) {
    throw new XApiError(413, {
      error: 'media_too_large',
      detail:
        `This file is ${totalBytes} bytes, over the ${maxBytes}-byte limit ` +
        'for this kind of post on X.',
    });
  }
}

export interface XClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  segmentSizeBytes?: number;
  statusPollIntervalMs?: number;
  maxStatusPolls?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

function trimTrailingSlashes(str: string): string {
  let end = str.length;
  while (end > 0 && str.codePointAt(end - 1) === 47) end--;
  return str.slice(0, end);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface XEnvelope<T> {
  data?: T;
  errors?: Array<{ title?: string; detail?: string; type?: string }>;
  title?: string;
  detail?: string;
  type?: string;
  error?: string;
}

export class XClient implements IXClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly segmentSizeBytes: number;
  private readonly statusPollIntervalMs: number;
  private readonly maxStatusPolls: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options?: XClientOptions) {
    this.baseUrl = trimTrailingSlashes(options?.baseUrl ?? X_API_BASE_URL);
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    this.segmentSizeBytes = options?.segmentSizeBytes ?? X_MEDIA_SEGMENT_BYTES;
    this.statusPollIntervalMs = options?.statusPollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS;
    this.maxStatusPolls = options?.maxStatusPolls ?? DEFAULT_MAX_STATUS_POLLS;
    this.sleepFn = options?.sleepFn ?? sleepMs;
  }

  // ---------- tweets ----------

  async createTweet(
    accessToken: string,
    payload: XCreateTweetPayload
  ): Promise<{ id: string; rateLimit?: XRateLimitInfo | undefined }> {
    const body: Record<string, unknown> = { text: payload.text };
    if (payload.mediaIds && payload.mediaIds.length > 0) {
      body.media = { media_ids: payload.mediaIds };
    }
    if (payload.poll) {
      body.poll = {
        options: payload.poll.options,
        duration_minutes: payload.poll.durationMinutes,
      };
    }
    if (payload.quoteTweetId) body.quote_tweet_id = payload.quoteTweetId;
    if (payload.replySettings) body.reply_settings = payload.replySettings;

    const { data, rateLimit } = await this.request<{ id: string; text: string }>(
      '/tweets',
      accessToken,
      { method: 'POST', body }
    );
    if (!data?.id) {
      throw new InternalError('Invalid create-tweet response from X: missing id');
    }
    return { id: data.id, ...(rateLimit ? { rateLimit } : {}) };
  }

  async getUserTimeline(
    accessToken: string,
    userId: string,
    maxResults = 10
  ): Promise<{ tweets: XTweet[]; rateLimit?: XRateLimitInfo | undefined }> {
    const path = `/users/${encodeURIComponent(userId)}/tweets?max_results=${maxResults}&exclude=retweets`;
    const { data, rateLimit } = await this.request<XTweet[]>(path, accessToken, {
      method: 'GET',
    });
    return { tweets: Array.isArray(data) ? data : [], ...(rateLimit ? { rateLimit } : {}) };
  }

  async getMe(
    accessToken: string
  ): Promise<{ id: string; name: string; username: string; avatarUrl?: string | null | undefined }> {
    const { data } = await this.request<{
      id: string;
      name: string;
      username: string;
      profile_image_url?: string;
    }>('/users/me?user.fields=profile_image_url', accessToken, { method: 'GET' });
    if (!data?.id) {
      throw new InternalError('Invalid users/me response from X: missing id');
    }
    return {
      id: data.id,
      name: data.name,
      username: data.username,
      avatarUrl: data.profile_image_url ?? null,
    };
  }

  // ---------- media ----------

  async uploadMediaChunked(
    accessToken: string,
    input: { sourceUrl: string; mediaType: string; mediaCategory: string }
  ): Promise<{ mediaId: string; rateLimit?: XRateLimitInfo | undefined }> {
    const sourceRes = await this.fetchFn(input.sourceUrl);
    if (!sourceRes.ok || !sourceRes.body) {
      throw new InternalError(
        `Failed to fetch media from source: HTTP ${sourceRes.status}`
      );
    }
    const contentLengthHeader = sourceRes.headers.get('content-length');
    const totalBytes = contentLengthHeader ? Number(contentLengthHeader) : Number.NaN;

    if (Number.isFinite(totalBytes) && totalBytes >= 0) {
      assertMediaWithinLimit(input.mediaCategory, totalBytes);
      const mediaId = await this.initializeUpload(accessToken, {
        mediaType: input.mediaType,
        mediaCategory: input.mediaCategory,
        totalBytes,
      });
      await this.appendStream(accessToken, mediaId, sourceRes.body);
      const finalized = await this.finalizeAndAwait(accessToken, mediaId);
      return { mediaId, ...(finalized.rateLimit ? { rateLimit: finalized.rateLimit } : {}) };
    }

    // No Content-Length: the initialize call needs the total up front,
    // so segments are read (and held) while counting, then appended.
    // Documented fallback only — R2 URLs report a length.
    const segments: Uint8Array[] = [];
    let counted = 0;
    for await (const segment of this.readSegments(sourceRes.body)) {
      segments.push(segment);
      counted += segment.byteLength;
    }
    assertMediaWithinLimit(input.mediaCategory, counted);
    const mediaId = await this.initializeUpload(accessToken, {
      mediaType: input.mediaType,
      mediaCategory: input.mediaCategory,
      totalBytes: counted,
    });
    for (let i = 0; i < segments.length; i++) {
      await this.appendSegment(accessToken, mediaId, i, segments[i] as Uint8Array);
    }
    const finalized = await this.finalizeAndAwait(accessToken, mediaId);
    return { mediaId, ...(finalized.rateLimit ? { rateLimit: finalized.rateLimit } : {}) };
  }

  async setMediaMetadata(accessToken: string, mediaId: string, altText: string): Promise<void> {
    await this.request('/media/metadata', accessToken, {
      method: 'POST',
      body: { media_id: mediaId, alt_text: { text: altText } },
    });
  }

  private async initializeUpload(
    accessToken: string,
    input: { mediaType: string; mediaCategory: string; totalBytes: number }
  ): Promise<string> {
    const { data } = await this.request<{ id?: string; media_id?: string }>(
      '/media/upload/initialize',
      accessToken,
      {
        method: 'POST',
        body: {
          media_type: input.mediaType,
          media_category: input.mediaCategory,
          total_bytes: input.totalBytes,
          shared: false,
        },
      }
    );
    const mediaId = data?.id ?? data?.media_id;
    if (!mediaId) {
      throw new InternalError('Invalid media initialize response from X: missing media id');
    }
    return mediaId;
  }

  /** Streams the body into ~segmentSize appends — never holds more than one segment plus the in-flight chunk. */
  private async appendStream(
    accessToken: string,
    mediaId: string,
    body: ReadableStream<Uint8Array>
  ): Promise<void> {
    let segmentIndex = 0;
    for await (const segment of this.readSegmentsFromBody(body)) {
      await this.appendSegment(accessToken, mediaId, segmentIndex, segment);
      segmentIndex++;
    }
  }

  private async *readSegments(
    body: ReadableStream<Uint8Array>
  ): AsyncGenerator<Uint8Array> {
    yield* this.readSegmentsFromBody(body);
  }

  private async *readSegmentsFromBody(
    body: ReadableStream<Uint8Array>
  ): AsyncGenerator<Uint8Array> {
    const segmentSize = this.segmentSizeBytes;
    const reader = body.getReader();
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;

    const drainFullSegments = function* (): Generator<Uint8Array> {
      while (pendingBytes >= segmentSize) {
        const merged = mergeChunks(pending, segmentSize);
        pending = merged.rest;
        pendingBytes -= segmentSize;
        yield merged.segment;
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        pending.push(value);
        pendingBytes += value.byteLength;
        yield* drainFullSegments();
      }
    }
    if (pendingBytes > 0) {
      const merged = mergeChunks(pending, pendingBytes);
      yield merged.segment;
    }
  }

  private async appendSegment(
    accessToken: string,
    mediaId: string,
    segmentIndex: number,
    segment: Uint8Array
  ): Promise<void> {
    const form = new FormData();
    form.set('segment_index', String(segmentIndex));
    form.set('media', new Blob([segment.slice().buffer as ArrayBuffer]), 'segment.bin');
    const res = await this.fetchFn(
      `${this.baseUrl}/media/upload/${encodeURIComponent(mediaId)}/append`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
      }
    );
    if (!res.ok) {
      throw await this.toApiError(res);
    }
  }

  private async finalizeAndAwait(
    accessToken: string,
    mediaId: string
  ): Promise<{ rateLimit?: XRateLimitInfo | undefined }> {
    const finalize = await this.request<{
      processing_info?: {
        state?: string;
        check_after_secs?: number;
        error?: { message?: string };
      };
    }>(`/media/upload/${encodeURIComponent(mediaId)}/finalize`, accessToken, {
      method: 'POST',
    });
    let rateLimit = finalize.rateLimit;
    let processing = finalize.data?.processing_info;
    let polls = 0;
    while (
      processing &&
      (processing.state === 'pending' || processing.state === 'in_progress') &&
      polls < this.maxStatusPolls
    ) {
      const waitMs =
        processing.check_after_secs !== undefined
          ? processing.check_after_secs * 1000
          : this.statusPollIntervalMs;
      await this.sleepFn(waitMs);
      const status = await this.request<{
        processing_info?: { state?: string; check_after_secs?: number; error?: { message?: string } };
      }>(`/media/upload?media_id=${encodeURIComponent(mediaId)}`, accessToken, {
        method: 'GET',
      });
      rateLimit = status.rateLimit ?? rateLimit;
      processing = status.data?.processing_info;
      polls++;
      if (processing?.state === 'failed') {
        throw new InternalError(
          `X media processing failed for ${mediaId}: ${processing.error?.message ?? 'unknown error'}`
        );
      }
    }
    if (processing && processing.state !== 'succeeded') {
      throw new InternalError(`X media ${mediaId} did not finish processing in time`);
    }
    return { ...(rateLimit ? { rateLimit } : {}) };
  }

  // ---------- OAuth token endpoint ----------

  async refreshAccessToken(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<XTokenResponse> {
    const basic = base64Encode(`${input.clientId}:${input.clientSecret}`);
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
    });
    const res = await this.fetchFn(`${this.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const rateLimit = parseXRateLimitHeaders(res.headers);
    const json = (await parseJsonSafe(res)) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      title?: string;
      detail?: string;
      type?: string;
      error?: string;
    };
    if (!res.ok || !json.access_token) {
      throw new XApiError(
        res.status,
        { title: json.title, detail: json.detail, type: json.type, error: json.error },
        rateLimit
      );
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      ...(json.expires_in !== undefined ? { expiresIn: json.expires_in } : {}),
      ...(json.scope !== undefined ? { scope: json.scope } : {}),
    };
  }

  // ---------- plumbing ----------

  private async request<T>(
    path: string,
    accessToken: string,
    init: { method: string; body?: Record<string, unknown> }
  ): Promise<{ data: T | undefined; rateLimit?: XRateLimitInfo | undefined }> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const rateLimit = parseXRateLimitHeaders(res.headers);
    if (!res.ok) {
      throw await this.toApiError(res, rateLimit);
    }
    const json = (await parseJsonSafe(res)) as XEnvelope<T>;
    return { data: json.data as T | undefined, ...(rateLimit ? { rateLimit } : {}) };
  }

  private async toApiError(
    res: Response,
    knownRateLimit?: XRateLimitInfo
  ): Promise<XApiError> {
    const rateLimit = knownRateLimit ?? parseXRateLimitHeaders(res.headers);
    const json = (await parseJsonSafe(res)) as XEnvelope<unknown> & {
      errors?: Array<{ title?: string; detail?: string; type?: string }>;
    };
    const first = json.errors?.[0];
    return new XApiError(
      res.status,
      {
        title: json.title ?? first?.title,
        detail: json.detail ?? first?.detail,
        type: json.type ?? first?.type,
        error: json.error,
      },
      rateLimit
    );
  }
}

async function parseJsonSafe(res: Response): Promise<Record<string, unknown>> {
  try {
    const data = await res.json();
    return (data as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const b of bytes) binary += String.fromCodePoint(b);
  return btoa(binary);
}

/** Splits the head `take` bytes off a chunk list; returns the segment + the remainder chunks. */
function mergeChunks(
  chunks: Uint8Array[],
  take: number
): { segment: Uint8Array; rest: Uint8Array[] } {
  const segment = new Uint8Array(take);
  let offset = 0;
  const rest: Uint8Array[] = [];
  for (const chunk of chunks) {
    if (offset >= take) {
      rest.push(chunk);
      continue;
    }
    const needed = take - offset;
    if (chunk.byteLength <= needed) {
      segment.set(chunk, offset);
      offset += chunk.byteLength;
    } else {
      segment.set(chunk.subarray(0, needed), offset);
      rest.push(chunk.subarray(needed));
      offset += needed;
    }
  }
  return { segment, rest };
}

// ==========================================
// Mock client (test seam, mirrors MockFacebookPublishClient)
// ==========================================

export class MockXClient implements IXClient {
  public tweetsCreated: Array<{ accessToken: string; payload: XCreateTweetPayload }> = [];
  public uploadsStarted: Array<{ sourceUrl: string; mediaType: string; mediaCategory: string }> = [];
  public metadataSet: Array<{ mediaId: string; altText: string }> = [];
  public timelineReads: Array<{ userId: string }> = [];
  public refreshCalls: Array<{ clientId: string; refreshToken: string }> = [];
  /** Ordered call log — tests assert upload-before-tweet within one attempt. */
  public callOrder: string[] = [];

  public nextTweetId = 'tweet-1001';
  public nextMediaId = 'media-2002';
  public timelineTweets: XTweet[] = [];
  public rateLimitToReturn: XRateLimitInfo | undefined;
  public createTweetError: unknown = null;
  public uploadError: unknown = null;
  public refreshError: unknown = null;
  public nextRefresh: XTokenResponse = {
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    expiresIn: 7200,
  };

  async createTweet(
    accessToken: string,
    payload: XCreateTweetPayload
  ): Promise<{ id: string; rateLimit?: XRateLimitInfo | undefined }> {
    this.callOrder.push('createTweet');
    if (this.createTweetError) throw this.createTweetError;
    this.tweetsCreated.push({ accessToken, payload });
    return {
      id: this.nextTweetId,
      ...(this.rateLimitToReturn ? { rateLimit: this.rateLimitToReturn } : {}),
    };
  }

  async getUserTimeline(
    _accessToken: string,
    userId: string
  ): Promise<{ tweets: XTweet[]; rateLimit?: XRateLimitInfo | undefined }> {
    this.callOrder.push('getUserTimeline');
    this.timelineReads.push({ userId });
    return { tweets: this.timelineTweets };
  }

  async getMe(): Promise<{ id: string; name: string; username: string; avatarUrl?: string | null }> {
    return { id: 'x-user-1', name: 'Test User', username: 'testuser', avatarUrl: null };
  }

  async uploadMediaChunked(
    _accessToken: string,
    input: { sourceUrl: string; mediaType: string; mediaCategory: string }
  ): Promise<{ mediaId: string; rateLimit?: XRateLimitInfo | undefined }> {
    this.callOrder.push('uploadMediaChunked');
    if (this.uploadError) throw this.uploadError;
    this.uploadsStarted.push(input);
    return {
      mediaId: this.nextMediaId,
      ...(this.rateLimitToReturn ? { rateLimit: this.rateLimitToReturn } : {}),
    };
  }

  async setMediaMetadata(_accessToken: string, mediaId: string, altText: string): Promise<void> {
    this.callOrder.push('setMediaMetadata');
    this.metadataSet.push({ mediaId, altText });
  }

  async refreshAccessToken(input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<XTokenResponse> {
    this.callOrder.push('refreshAccessToken');
    if (this.refreshError) throw this.refreshError;
    this.refreshCalls.push({ clientId: input.clientId, refreshToken: input.refreshToken });
    return this.nextRefresh;
  }

  reset(): void {
    this.tweetsCreated = [];
    this.uploadsStarted = [];
    this.metadataSet = [];
    this.timelineReads = [];
    this.refreshCalls = [];
    this.callOrder = [];
    this.timelineTweets = [];
    this.createTweetError = null;
    this.uploadError = null;
    this.refreshError = null;
    this.rateLimitToReturn = undefined;
  }
}
