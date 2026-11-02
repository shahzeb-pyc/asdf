// ==========================================
// Instagram API client (spec 124 — Instagram-Login route, D2)
// ==========================================
//
// Thin, mockable client over `graph.instagram.com` for the container
// publishing flow: create container → poll `status_code` → publish.
// Media is ingested by Meta from a public URL (our R2 public URLs) —
// this client never sends media bytes.
//
// Token endpoints (short → long-lived exchange, long-lived refresh)
// live here too, but they are only ever CALLED by the spec 123 connect
// flow (web) and the spec 121 token-refresh job (via the publisher's
// `refreshTokens`); the publish path contains no token calls (D6).

export const INSTAGRAM_GRAPH_BASE_URL = 'https://graph.instagram.com/v26.0';
export const INSTAGRAM_API_BASE_URL = 'https://graph.instagram.com';

export type InstagramContainerStatusCode =
  | 'IN_PROGRESS'
  | 'FINISHED'
  | 'PUBLISHED'
  | 'ERROR'
  | 'EXPIRED';

export interface InstagramGraphErrorData {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

export class InstagramGraphError extends Error {
  public readonly code: number | undefined;
  public readonly errorSubcode: number | undefined;
  public readonly errorType: string | undefined;
  public readonly fbtraceId: string | undefined;
  /** HTTP status for transport-shaped failures (e.g. a container 404). */
  public readonly httpStatus: number | undefined;

  constructor(
    message: string,
    errorData?: InstagramGraphErrorData,
    httpStatus?: number
  ) {
    super(message);
    this.name = 'InstagramGraphError';
    this.code = errorData?.code;
    this.errorSubcode = errorData?.error_subcode;
    this.errorType = errorData?.type;
    this.fbtraceId = errorData?.fbtrace_id;
    this.httpStatus = httpStatus;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface InstagramContainerCreateParams {
  igUserId: string;
  accessToken: string;
  /** Container media type; omit for a single photo. */
  mediaType?: 'REELS' | 'STORIES' | 'CAROUSEL' | undefined;
  imageUrl?: string | undefined;
  videoUrl?: string | undefined;
  caption?: string | undefined;
  isCarouselItem?: boolean | undefined;
  /** Carousel parent: child container ids. */
  children?: string[] | undefined;
  collaborators?: string[] | undefined;
  shareToFeed?: boolean | undefined;
  coverUrl?: string | undefined;
  trialParams?: Record<string, unknown> | undefined;
}

export interface InstagramPublishingLimit {
  /** Posts published in the current window, when the API reports it. */
  usage?: number | undefined;
  /** The account's live total quota for the window (config.total_count). */
  totalCount?: number | undefined;
  raw: Record<string, unknown>;
}

export interface IInstagramPublishClient {
  createContainer(
    params: InstagramContainerCreateParams
  ): Promise<{ containerId: string }>;
  getContainerStatus(
    params: { containerId: string; accessToken: string }
  ): Promise<{ statusCode: InstagramContainerStatusCode; statusMessage?: string | undefined }>;
  publishContainer(
    params: { igUserId: string; accessToken: string; containerId: string }
  ): Promise<{ mediaId: string }>;
  postComment(
    params: { mediaId: string; accessToken: string; message: string }
  ): Promise<{ commentId: string }>;
  getContentPublishingLimit(
    params: { igUserId: string; accessToken: string }
  ): Promise<InstagramPublishingLimit>;
  refreshLongLivedToken(
    params: { accessToken: string }
  ): Promise<{ accessToken: string; expiresIn?: number | undefined }>;
}

export interface InstagramPublishClientOptions {
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
}

function trimTrailingSlashes(str: string): string {
  let end = str.length;
  while (end > 0 && str.codePointAt(end - 1) === 47) end--;
  return str.slice(0, end);
}

export class InstagramPublishClient implements IInstagramPublishClient {
  private readonly baseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options?: InstagramPublishClientOptions) {
    this.baseUrl = trimTrailingSlashes(options?.baseUrl ?? INSTAGRAM_GRAPH_BASE_URL);
    this.apiBaseUrl = trimTrailingSlashes(
      options?.apiBaseUrl ?? INSTAGRAM_API_BASE_URL
    );
    // Workerd brand-checks its native fetch: storing `globalThis.fetch`
    // as an instance field and calling it as `this.fetchFn(...)` binds
    // `this` to this client, and workerd rejects that receiver with
    // "Illegal invocation". Node/bun permit detached fetch, so tests
    // never caught it — every publish died before reaching Instagram.
    // The arrow wrapper calls fetch as a bare identifier, so the
    // receiver is never the client. Do NOT "simplify" this back to
    // `globalThis.fetch`.
    this.fetchFn =
      options?.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  }

  async createContainer(
    params: InstagramContainerCreateParams
  ): Promise<{ containerId: string }> {
    const body: Record<string, unknown> = {};
    if (params.mediaType) body.media_type = params.mediaType;
    if (params.imageUrl) body.image_url = params.imageUrl;
    if (params.videoUrl) body.video_url = params.videoUrl;
    if (params.caption) body.caption = params.caption;
    if (params.isCarouselItem) body.is_carousel_item = true;
    if (params.children) body.children = params.children.join(',');
    if (params.collaborators?.length) body.collaborators = params.collaborators;
    if (params.shareToFeed !== undefined) body.share_to_feed = params.shareToFeed;
    if (params.coverUrl) body.cover_url = params.coverUrl;
    if (params.trialParams) body.trial_params = params.trialParams;

    const data = await this.request(
      `/${encodeURIComponent(params.igUserId)}/media`,
      params.accessToken,
      { method: 'POST', body }
    );
    if (!data.id) {
      throw new InstagramGraphError(
        'Invalid container response from Instagram: missing id'
      );
    }
    return { containerId: String(data.id) };
  }

  async getContainerStatus(params: {
    containerId: string;
    accessToken: string;
  }): Promise<{
    statusCode: InstagramContainerStatusCode;
    statusMessage?: string | undefined;
  }> {
    const data = await this.request(
      `/${encodeURIComponent(params.containerId)}?fields=status_code`,
      params.accessToken,
      { method: 'GET' }
    );
    const statusCode = String(data.status_code ?? '') as InstagramContainerStatusCode;
    if (!statusCode) {
      throw new InstagramGraphError(
        'Invalid container status response from Instagram: missing status_code'
      );
    }
    return {
      statusCode,
      ...(typeof data.status === 'string' ? { statusMessage: data.status } : {}),
    };
  }

  async publishContainer(params: {
    igUserId: string;
    accessToken: string;
    containerId: string;
  }): Promise<{ mediaId: string }> {
    const data = await this.request(
      `/${encodeURIComponent(params.igUserId)}/media_publish`,
      params.accessToken,
      { method: 'POST', body: { creation_id: params.containerId } }
    );
    if (!data.id) {
      throw new InstagramGraphError(
        'Invalid publish response from Instagram: missing id'
      );
    }
    return { mediaId: String(data.id) };
  }

  async postComment(params: {
    mediaId: string;
    accessToken: string;
    message: string;
  }): Promise<{ commentId: string }> {
    const data = await this.request(
      `/${encodeURIComponent(params.mediaId)}/comments`,
      params.accessToken,
      { method: 'POST', body: { message: params.message } }
    );
    if (!data.id) {
      throw new InstagramGraphError(
        'Invalid comment response from Instagram: missing id'
      );
    }
    return { commentId: String(data.id) };
  }

  async getContentPublishingLimit(params: {
    igUserId: string;
    accessToken: string;
  }): Promise<InstagramPublishingLimit> {
    const data = await this.request(
      `/${encodeURIComponent(params.igUserId)}/content_publishing_limit`,
      params.accessToken,
      { method: 'GET' }
    );
    const first = Array.isArray(data.data) ? data.data[0] : undefined;
    const record =
      first && typeof first === 'object'
        ? (first as Record<string, unknown>)
        : data;
    const config =
      record.config && typeof record.config === 'object'
        ? (record.config as Record<string, unknown>)
        : {};
    const usage =
      typeof record.usage === 'number'
        ? record.usage
        : typeof record.quota_usage === 'number'
          ? record.quota_usage
          : undefined;
    const totalCount =
      typeof config.total_count === 'number'
        ? config.total_count
        : typeof record.quota_total === 'number'
          ? record.quota_total
          : undefined;
    return {
      ...(usage !== undefined ? { usage } : {}),
      ...(totalCount !== undefined ? { totalCount } : {}),
      raw: record,
    };
  }

  async refreshLongLivedToken(params: {
    accessToken: string;
  }): Promise<{ accessToken: string; expiresIn?: number | undefined }> {
    const url =
      `${this.apiBaseUrl}/refresh_access_token?grant_type=ig_refresh_token` +
      `&access_token=${encodeURIComponent(params.accessToken)}`;
    const res = await this.fetchFn(url, { method: 'GET' });
    const data = (await this.parseJson(res)) as {
      access_token?: string;
      expires_in?: number;
      error?: InstagramGraphErrorData;
    };
    if (!res.ok || data.error || !data.access_token) {
      throw this.createError(res, data as Record<string, unknown>);
    }
    return {
      accessToken: data.access_token,
      ...(typeof data.expires_in === 'number' ? { expiresIn: data.expires_in } : {}),
    };
  }

  private async request(
    path: string,
    accessToken: string,
    init: { method: string; body?: Record<string, unknown> }
  ): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const data = await this.parseJson(res);
    if (!res.ok || data.error) {
      throw this.createError(res, data);
    }
    return data;
  }

  private async parseJson(res: Response): Promise<Record<string, unknown>> {
    try {
      const data = await res.json();
      return (data as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }

  private createError(
    res: Response,
    data: Record<string, unknown>
  ): InstagramGraphError {
    const errorData = (data?.error as InstagramGraphErrorData) ?? undefined;
    const message =
      errorData?.message ?? `Instagram API error: HTTP ${res.status}`;
    return new InstagramGraphError(message, errorData, res.status);
  }
}

// ==========================================
// Mock client (tests — mirrors MockFacebookPublishClient's pattern)
// ==========================================

export class MockInstagramPublishClient implements IInstagramPublishClient {
  public containersCreated: InstagramContainerCreateParams[] = [];
  public containersPublished: Array<{ igUserId: string; containerId: string }> = [];
  public commentsPosted: Array<{ mediaId: string; message: string }> = [];
  public statusChecks: string[] = [];
  public limitReads = 0;
  public refreshCalls = 0;

  public nextContainerId = 'mock_container_1';
  public nextMediaId = 'mock_media_1';
  public nextCommentId = 'mock_comment_1';

  /** Status sequence served per container; the last value repeats. */
  public statusSequence: InstagramContainerStatusCode[] = ['FINISHED'];
  /** Status served for a specific container id (wins over the sequence). */
  public statusByContainer = new Map<string, InstagramContainerStatusCode>();
  /** When set, publishContainer throws it (e.g. a publish timeout). */
  public publishErrorToThrow: Error | null = null;
  /** When set, the named method throws it: 'create' | 'status' | 'comment' | 'limit'. */
  public errorToThrow: Error | null = null;
  public throwOn: 'create' | 'status' | 'comment' | 'limit' | null = null;
  /** Live quota the mock reports (null = the API reports no total). */
  public limitToReturn: InstagramPublishingLimit = {
    usage: 3,
    totalCount: 50,
    raw: {},
  };

  private statusCallCounts = new Map<string, number>();
  private containerSeq = 0;

  createContainer(
    params: InstagramContainerCreateParams
  ): Promise<{ containerId: string }> {
    if (this.throwOn === 'create' && this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    this.containersCreated.push(params);
    this.containerSeq += 1;
    const containerId =
      this.containerSeq === 1
        ? this.nextContainerId
        : `${this.nextContainerId}_${this.containerSeq}`;
    return Promise.resolve({ containerId });
  }

  getContainerStatus(params: {
    containerId: string;
    accessToken: string;
  }): Promise<{
    statusCode: InstagramContainerStatusCode;
    statusMessage?: string | undefined;
  }> {
    if (this.throwOn === 'status' && this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    this.statusChecks.push(params.containerId);
    const fixed = this.statusByContainer.get(params.containerId);
    if (fixed) return Promise.resolve({ statusCode: fixed });
    const count = this.statusCallCounts.get(params.containerId) ?? 0;
    this.statusCallCounts.set(params.containerId, count + 1);
    const statusCode =
      this.statusSequence[Math.min(count, this.statusSequence.length - 1)] ??
      'FINISHED';
    return Promise.resolve({ statusCode });
  }

  publishContainer(params: {
    igUserId: string;
    accessToken: string;
    containerId: string;
  }): Promise<{ mediaId: string }> {
    if (this.publishErrorToThrow) {
      return Promise.reject(this.publishErrorToThrow);
    }
    this.containersPublished.push({
      igUserId: params.igUserId,
      containerId: params.containerId,
    });
    // Publishing flips the container to PUBLISHED, as the real API does.
    this.statusByContainer.set(params.containerId, 'PUBLISHED');
    return Promise.resolve({ mediaId: this.nextMediaId });
  }

  postComment(params: {
    mediaId: string;
    accessToken: string;
    message: string;
  }): Promise<{ commentId: string }> {
    if (this.throwOn === 'comment' && this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    this.commentsPosted.push({ mediaId: params.mediaId, message: params.message });
    return Promise.resolve({ commentId: this.nextCommentId });
  }

  getContentPublishingLimit(): Promise<InstagramPublishingLimit> {
    if (this.throwOn === 'limit' && this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    this.limitReads += 1;
    return Promise.resolve(this.limitToReturn);
  }

  refreshLongLivedToken(params: {
    accessToken: string;
  }): Promise<{ accessToken: string; expiresIn?: number | undefined }> {
    this.refreshCalls += 1;
    return Promise.resolve({
      accessToken: `${params.accessToken}-refreshed`,
      expiresIn: 60 * 24 * 3600,
    });
  }

  reset(): void {
    this.containersCreated = [];
    this.containersPublished = [];
    this.commentsPosted = [];
    this.statusChecks = [];
    this.limitReads = 0;
    this.refreshCalls = 0;
    this.statusSequence = ['FINISHED'];
    this.statusByContainer.clear();
    this.publishErrorToThrow = null;
    this.errorToThrow = null;
    this.throwOn = null;
    this.statusCallCounts.clear();
    this.containerSeq = 0;
  }
}
