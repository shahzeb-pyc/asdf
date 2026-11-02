// ==========================================
// Threads API client (spec 124)
// ==========================================
//
// Thin, mockable client over `graph.threads.net` for the async
// container flow: create container → poll `status` → publish on
// FINISHED. Media is fetched by Meta from a public URL — there is NO
// upload endpoint and this client contains no upload path.
//
// Host record (build-time docs verification, spec 124 PR): the web
// product moved from threads.net to threads.com, and Meta's current
// docs show the authorize window on threads.com; the API host in every
// corroborated publishing/token reference remains
// `graph.threads.net`, which is the pair this module and the web
// connect registration build on.
//
// Token endpoints live here too, but they are only ever CALLED by the
// spec 123 connect flow (web) and the spec 121 token-refresh job (via
// the publisher's `refreshTokens`); the publish path contains no token
// calls (D6).

export const THREADS_GRAPH_BASE_URL = 'https://graph.threads.net/v1.0';
export const THREADS_API_BASE_URL = 'https://graph.threads.net';

export type ThreadsContainerStatus =
  | 'IN_PROGRESS'
  | 'FINISHED'
  | 'PUBLISHED'
  | 'ERROR'
  | 'EXPIRED';

export interface ThreadsGraphErrorData {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

export class ThreadsGraphError extends Error {
  public readonly code: number | undefined;
  public readonly errorSubcode: number | undefined;
  public readonly errorType: string | undefined;
  public readonly fbtraceId: string | undefined;
  /** HTTP status for transport-shaped failures (e.g. a container 404). */
  public readonly httpStatus: number | undefined;

  constructor(message: string, errorData?: ThreadsGraphErrorData, httpStatus?: number) {
    super(message);
    this.name = 'ThreadsGraphError';
    this.code = errorData?.code;
    this.errorSubcode = errorData?.error_subcode;
    this.errorType = errorData?.type;
    this.fbtraceId = errorData?.fbtrace_id;
    this.httpStatus = httpStatus;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ThreadsContainerCreateParams {
  threadsUserId: string;
  accessToken: string;
  mediaType: 'TEXT' | 'IMAGE' | 'VIDEO' | 'CAROUSEL';
  text?: string | undefined;
  imageUrl?: string | undefined;
  videoUrl?: string | undefined;
  isCarouselItem?: boolean | undefined;
  children?: string[] | undefined;
  altText?: string | undefined;
  linkAttachment?: string | undefined;
  replyToId?: string | undefined;
  quotePostId?: string | undefined;
  replyControl?: string | undefined;
  topicTag?: string | undefined;
  textAttachment?: string | undefined;
}

export interface IThreadsPublishClient {
  createContainer(
    params: ThreadsContainerCreateParams
  ): Promise<{ containerId: string }>;
  getContainerStatus(
    params: { containerId: string; accessToken: string }
  ): Promise<{
    status: ThreadsContainerStatus;
    errorMessage?: string | undefined;
  }>;
  publishContainer(
    params: { threadsUserId: string; accessToken: string; containerId: string }
  ): Promise<{ mediaId: string }>;
  getPublishingLimit(
    params: { threadsUserId: string; accessToken: string }
  ): Promise<{ usage?: number | undefined; totalCount?: number | undefined; raw: Record<string, unknown> }>;
  refreshLongLivedToken(
    params: { accessToken: string }
  ): Promise<{ accessToken: string; expiresIn?: number | undefined }>;
}

export interface ThreadsPublishClientOptions {
  baseUrl?: string;
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
}

function trimTrailingSlashes(str: string): string {
  let end = str.length;
  while (end > 0 && str.codePointAt(end - 1) === 47) end--;
  return str.slice(0, end);
}

export class ThreadsPublishClient implements IThreadsPublishClient {
  private readonly baseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options?: ThreadsPublishClientOptions) {
    this.baseUrl = trimTrailingSlashes(options?.baseUrl ?? THREADS_GRAPH_BASE_URL);
    this.apiBaseUrl = trimTrailingSlashes(options?.apiBaseUrl ?? THREADS_API_BASE_URL);
    // Workerd brand-checks its native fetch: storing `globalThis.fetch`
    // as an instance field and calling it as `this.fetchFn(...)` binds
    // `this` to this client, and workerd rejects that receiver with
    // "Illegal invocation". Node/bun permit detached fetch, so tests
    // never caught it — every publish died before reaching Threads.
    // The arrow wrapper calls fetch as a bare identifier, so the
    // receiver is never the client. Do NOT "simplify" this back to
    // `globalThis.fetch`.
    this.fetchFn =
      options?.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  }

  async createContainer(
    params: ThreadsContainerCreateParams
  ): Promise<{ containerId: string }> {
    const body: Record<string, unknown> = { media_type: params.mediaType };
    if (params.text) body.text = params.text;
    if (params.imageUrl) body.image_url = params.imageUrl;
    if (params.videoUrl) body.video_url = params.videoUrl;
    if (params.isCarouselItem) body.is_carousel_item = true;
    if (params.children) body.children = params.children.join(',');
    if (params.altText) body.alt_text = params.altText;
    if (params.linkAttachment) body.link_attachment = params.linkAttachment;
    if (params.replyToId) body.reply_to_id = params.replyToId;
    if (params.quotePostId) body.quote_post_id = params.quotePostId;
    if (params.replyControl) body.reply_control = params.replyControl;
    if (params.topicTag) body.topic_tag = params.topicTag;
    if (params.textAttachment) body.text_attachment = params.textAttachment;

    const data = await this.request(
      `/${encodeURIComponent(params.threadsUserId)}/threads`,
      params.accessToken,
      { method: 'POST', body }
    );
    if (!data.id) {
      throw new ThreadsGraphError('Invalid container response from Threads: missing id');
    }
    return { containerId: String(data.id) };
  }

  async getContainerStatus(params: {
    containerId: string;
    accessToken: string;
  }): Promise<{ status: ThreadsContainerStatus; errorMessage?: string | undefined }> {
    const data = await this.request(
      `/${encodeURIComponent(params.containerId)}?fields=status,error_message`,
      params.accessToken,
      { method: 'GET' }
    );
    const status = String(data.status ?? '') as ThreadsContainerStatus;
    if (!status) {
      throw new ThreadsGraphError(
        'Invalid container status response from Threads: missing status'
      );
    }
    return {
      status,
      ...(typeof data.error_message === 'string'
        ? { errorMessage: data.error_message }
        : {}),
    };
  }

  async publishContainer(params: {
    threadsUserId: string;
    accessToken: string;
    containerId: string;
  }): Promise<{ mediaId: string }> {
    const data = await this.request(
      `/${encodeURIComponent(params.threadsUserId)}/threads_publish`,
      params.accessToken,
      { method: 'POST', body: { creation_id: params.containerId } }
    );
    if (!data.id) {
      throw new ThreadsGraphError('Invalid publish response from Threads: missing id');
    }
    return { mediaId: String(data.id) };
  }

  async getPublishingLimit(params: {
    threadsUserId: string;
    accessToken: string;
  }): Promise<{
    usage?: number | undefined;
    totalCount?: number | undefined;
    raw: Record<string, unknown>;
  }> {
    const data = await this.request(
      `/${encodeURIComponent(params.threadsUserId)}/threads_publishing_limit`,
      params.accessToken,
      { method: 'GET' }
    );
    const first = Array.isArray(data.data) ? data.data[0] : undefined;
    const record =
      first && typeof first === 'object' ? (first as Record<string, unknown>) : data;
    const config =
      record.config && typeof record.config === 'object'
        ? (record.config as Record<string, unknown>)
        : {};
    return {
      ...(typeof record.quota_usage === 'number' ? { usage: record.quota_usage } : {}),
      ...(typeof config.total_count === 'number'
        ? { totalCount: config.total_count }
        : {}),
      raw: record,
    };
  }

  async refreshLongLivedToken(params: {
    accessToken: string;
  }): Promise<{ accessToken: string; expiresIn?: number | undefined }> {
    const url =
      `${this.apiBaseUrl}/refresh_access_token?grant_type=th_refresh_token` +
      `&access_token=${encodeURIComponent(params.accessToken)}`;
    const res = await this.fetchFn(url, { method: 'GET' });
    const data = (await this.parseJson(res)) as {
      access_token?: string;
      expires_in?: number;
      error?: ThreadsGraphErrorData;
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

  private createError(res: Response, data: Record<string, unknown>): ThreadsGraphError {
    const errorData = (data?.error as ThreadsGraphErrorData) ?? undefined;
    const message = errorData?.message ?? `Threads API error: HTTP ${res.status}`;
    return new ThreadsGraphError(message, errorData, res.status);
  }
}

// ==========================================
// Mock client (tests — mirrors MockFacebookPublishClient's pattern)
// ==========================================

export class MockThreadsPublishClient implements IThreadsPublishClient {
  public containersCreated: ThreadsContainerCreateParams[] = [];
  public containersPublished: Array<{ threadsUserId: string; containerId: string }> = [];
  public statusChecks: string[] = [];
  public refreshCalls = 0;

  public nextContainerId = 'mock_container_1';
  public nextMediaId = 'mock_media_1';

  public statusSequence: ThreadsContainerStatus[] = ['FINISHED'];
  public statusByContainer = new Map<string, ThreadsContainerStatus>();
  /** How many initial status reads per container answer 404. */
  public notFoundBeforeStatus = 0;
  public publishErrorToThrow: Error | null = null;
  public errorToThrow: Error | null = null;
  public throwOn: 'create' | 'status' | 'limit' | null = null;
  public limitToReturn: {
    usage?: number | undefined;
    totalCount?: number | undefined;
    raw: Record<string, unknown>;
  } = { usage: 10, totalCount: 250, raw: {} };

  private statusCallCounts = new Map<string, number>();
  private containerSeq = 0;

  createContainer(
    params: ThreadsContainerCreateParams
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
  }): Promise<{ status: ThreadsContainerStatus; errorMessage?: string | undefined }> {
    if (this.throwOn === 'status' && this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
    this.statusChecks.push(params.containerId);
    const count = this.statusCallCounts.get(params.containerId) ?? 0;
    this.statusCallCounts.set(params.containerId, count + 1);
    if (count < this.notFoundBeforeStatus) {
      return Promise.reject(
        new ThreadsGraphError('Container not found', { code: 24 }, 404)
      );
    }
    const fixed = this.statusByContainer.get(params.containerId);
    if (fixed) return Promise.resolve({ status: fixed });
    const status =
      this.statusSequence[Math.min(count, this.statusSequence.length - 1)] ?? 'FINISHED';
    return Promise.resolve({ status });
  }

  publishContainer(params: {
    threadsUserId: string;
    accessToken: string;
    containerId: string;
  }): Promise<{ mediaId: string }> {
    if (this.publishErrorToThrow) {
      return Promise.reject(this.publishErrorToThrow);
    }
    this.containersPublished.push({
      threadsUserId: params.threadsUserId,
      containerId: params.containerId,
    });
    this.statusByContainer.set(params.containerId, 'PUBLISHED');
    return Promise.resolve({ mediaId: this.nextMediaId });
  }

  getPublishingLimit(): Promise<{
    usage?: number | undefined;
    totalCount?: number | undefined;
    raw: Record<string, unknown>;
  }> {
    if (this.throwOn === 'limit' && this.errorToThrow) {
      return Promise.reject(this.errorToThrow);
    }
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
    this.statusChecks = [];
    this.refreshCalls = 0;
    this.statusSequence = ['FINISHED'];
    this.statusByContainer.clear();
    this.notFoundBeforeStatus = 0;
    this.publishErrorToThrow = null;
    this.errorToThrow = null;
    this.throwOn = null;
    this.statusCallCounts.clear();
    this.containerSeq = 0;
  }
}
