import {
  evaluateGraphApiError,
  type IFacebookPublishClient,
  type GraphRateLimitTelemetry,
  type PublishResult,
  InternalError,
} from '@fbuploadpro/contracts';

export type { IFacebookPublishClient, GraphRateLimitTelemetry, PublishResult };

// --- Facebook API endpoints ---
// Centralized here (not env-overridable): tests inject alternatives via options.baseUrl.
const FB_GRAPH_API_BASE_URL = 'https://graph.facebook.com/v26.0';
const FB_RUPLOAD_BASE_URL = 'https://rupload.facebook.com/video-upload/v26.0';

// --- Retry/backoff tuning for Graph API calls ---
const FB_RETRY_MAX_ATTEMPTS = 3;
const FB_RETRY_BASE_DELAY_MS = 1000;
const FB_RETRY_MAX_DELAY_MS = 8000;

// --- Per-call timeouts (spec 139) ---
// Every fetch in this client carries an AbortSignal.timeout so a hung
// connection can never stall a publish job indefinitely. Graph JSON calls
// are small request/response pairs (15s is generous); media transfers move
// whole video files, so they get the larger budget.
export const FB_GRAPH_TIMEOUT_MS = 15_000;
export const FB_MEDIA_TIMEOUT_MS = 30_000;

/**
 * Per-call retry policy (spec 139) — every `fetchWithRetry` call site must
 * declare one of these explicitly:
 *
 * - `retryable`: the call is idempotent or strictly pre-publish, so replaying
 *   it verbatim cannot create a visible post — upload-session `start` calls,
 *   the unpublished-photo upload behind a photo story (`published: false`),
 *   and fetching the source media bytes. These keep the historical behaviour:
 *   retry network failures, HTTP 429/5xx, and transient Graph errors with
 *   exponential backoff, up to FB_RETRY_MAX_ATTEMPTS.
 *
 * - `single-attempt`: the call is publish-mutating (it creates a visible
 *   post, story, or comment) or carries a one-shot body that cannot be
 *   replayed (the rupload byte stream). These are NEVER retried by this
 *   client. A network error or a 5xx on a publish POST is ambiguous: Facebook
 *   may have processed the request and only the response was lost, so a
 *   blind retry would double-post. Instead the failure surfaces immediately
 *   and the retry decision moves up to the queue/publisher layer, which
 *   retries the whole queue item with its own backoff; if the first attempt
 *   did land, Facebook's duplicate detection (Graph code 506, and 368 with
 *   subcode 1404082) answers the retry and the publisher classifies that as
 *   a permanent failure — the same duplicate handling that already exists
 *   in `FacebookGraphError` / `evaluateGraphApiError`, not a new mechanism.
 */
type FetchRetryPolicy = 'retryable' | 'single-attempt';

interface FetchCallOptions {
  policy: FetchRetryPolicy;
  timeoutMs: number;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number): number {
  return Math.min(FB_RETRY_MAX_DELAY_MS, FB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
}

/**
 * Whether a non-OK Graph API response is worth retrying: HTTP 429/5xx, or a
 * transient Graph error (e.g. rate-limit 368) reported in the JSON body.
 * Permanent errors (auth failures, policy violations, duplicates) are never retried.
 */
async function isRetryableGraphResponse(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status >= 500 && res.status < 600) return true;
  if (res.status >= 400 && res.status < 500) {
    try {
      const data = (await res.clone().json()) as {
        error?: { code?: number; error_subcode?: number };
      };
      const code = data?.error?.code;
      if (typeof code === 'number') {
        // Canonical transient classification from contracts: covers rate-limit
        // codes (4/17/32/341/613/80000-80014) and 368, but not permanent
        // policy errors (368/4854002 checkpoint, 368/1404082 duplicate,
        // 368/1404102 link against Community Standards).
        return evaluateGraphApiError(code, data.error?.error_subcode)?.isTransient === true;
      }
    } catch {
      // Unparseable body — not retryable.
    }
  }
  return false;
}

export interface FacebookGraphErrorData {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
}

/** Publish phase that produced a failure, for the stored diagnostic. */
export type FacebookPublishPhase =
  | 'reel-start'
  | 'reel-upload-file-url'
  | 'reel-upload-stream'
  | 'reel-finish'
  | 'video-story-upload-stream';

/** One upload attempt's outcome, for the both-attempts-failed diagnostic. */
export interface FacebookUploadAttemptDiagnostic {
  mode: 'file_url' | 'stream';
  success: boolean;
  httpStatus?: number | undefined;
  rawBody?: string | undefined;
  message?: string | undefined;
}

/**
 * Why a publish call failed, in full: the phase that failed, the HTTP
 * status, and Facebook's raw response body. This is what the publisher
 * threads into `publish_logs.detail` — a body-less HTTP 400 must never
 * again be stored as bare code `unknown` with nothing else to go on.
 * `rawBody` is the response body truncated to RAW_BODY_MAX_CHARS; an
 * empty string means Facebook returned no body at all.
 */
export interface FacebookPublishDiagnostic {
  phase: FacebookPublishPhase;
  httpStatus?: number | undefined;
  rawBody?: string | undefined;
  attempts?: FacebookUploadAttemptDiagnostic[] | undefined;
}

/** Raw response bodies are stored truncated: enough to read the reason, never a full payload. */
export const FACEBOOK_RAW_BODY_MAX_CHARS = 500;

/**
 * Collapse a value to a single console-log line, truncated: Cloudflare
 * Worker Logs are read by grep, so a log line must never span lines,
 * and a raw Facebook body must never arrive untruncated.
 */
function oneLineLogText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, FACEBOOK_RAW_BODY_MAX_CHARS);
}

export class FacebookGraphError extends Error {
  public readonly code: number | undefined;
  public readonly errorSubcode: number | undefined;
  public readonly errorType: string | undefined;
  public readonly fbtraceId: string | undefined;
  public readonly telemetry?: GraphRateLimitTelemetry | undefined;
  public readonly diagnostic?: FacebookPublishDiagnostic | undefined;
  public readonly isRateLimit: boolean;
  public readonly isAuthError: boolean;
  public readonly isPermanentPolicyError: boolean;
  public readonly isPermanentClientError: boolean;

  constructor(
    message: string,
    errorData?: FacebookGraphErrorData,
    telemetry?: GraphRateLimitTelemetry,
    diagnostic?: FacebookPublishDiagnostic
  ) {
    super(message);
    this.name = 'FacebookGraphError';
    this.code = errorData?.code;
    this.errorSubcode = errorData?.error_subcode;
    this.errorType = errorData?.type;
    this.fbtraceId = errorData?.fbtrace_id;
    this.telemetry = telemetry;
    this.diagnostic = diagnostic;

    const evalResult =
      this.code !== undefined
        ? evaluateGraphApiError(this.code, this.errorSubcode)
        : null;

    // `isAuthError` means exactly "the token is dead — the account
    // must reconnect": it is the classifier's `requiresReauth`
    // decision, nothing more (spec 155 SEND BACK item 5). The old
    // blanket `code === 190 || 102 || 10 || 200-299` also caught
    // errors that are NOT token-dead — 190/492 (missing page role),
    // 190/459 + 190/464 (checkpoint), 190/2069031 (developer app),
    // 10/200-299 (missing permission / developer app) — and
    // `classifyExtracted` then keyed them kind 'auth', which marks
    // the account expired and treats them as a token problem. Those
    // now classify 'permanent': they fail fast and the account stays
    // active. `isPermanentClientError` below is unaffected: the
    // narrowed codes are not 400s, and code 400 was already non-auth.
    this.isAuthError = evalResult?.requiresReauth === true;

    this.isPermanentPolicyError =
      this.code === 368 &&
      (this.errorSubcode === 4854002 ||
        this.errorSubcode === 1404082 ||
        this.errorSubcode === 1404102);

    this.isPermanentClientError =
      this.code === 100 ||
      this.code === 506 ||
      this.code === 1609005 ||
      this.code === 382 ||
      this.code === 1363040 ||
      (typeof this.code === 'number' &&
        this.code >= 400 &&
        this.code < 500 &&
        !this.isAuthError);

    this.isRateLimit =
      this.code === 4 ||
      this.code === 17 ||
      this.code === 32 ||
      this.code === 341 ||
      this.code === 613 ||
      (typeof this.code === 'number' && this.code >= 80000 && this.code <= 80014) ||
      (this.code === 368 && !this.isPermanentPolicyError);

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface BucUsageSummary {
  bucUsageMaxPct?: number | undefined;
  estimatedTimeToRegainAccessMinutes?: number | undefined;
}

function parseAppUsage(header: string | null): number | undefined {
  if (!header) return undefined;
  try {
    const parsed = JSON.parse(header) as {
      call_count?: number;
      total_cputime?: number;
      total_time?: number;
    };
    return Math.max(
      parsed.call_count || 0,
      parsed.total_cputime || 0,
      parsed.total_time || 0
    );
  } catch {
    return undefined;
  }
}

function parseBucEntries(entries: Array<{
  call_count?: number;
  total_cputime?: number;
  total_time?: number;
  estimated_time_to_regain_access?: number;
}>): { maxBuc: number; maxWait: number } {
  let maxBuc = 0;
  let maxWait = 0;
  for (const entry of entries) {
    const entryMax = Math.max(
      entry.call_count || 0,
      entry.total_cputime || 0,
      entry.total_time || 0
    );
    if (entryMax > maxBuc) maxBuc = entryMax;
    if (entry.estimated_time_to_regain_access && entry.estimated_time_to_regain_access > maxWait) {
      maxWait = entry.estimated_time_to_regain_access;
    }
  }
  return { maxBuc, maxWait };
}

function parseBucUsage(header: string | null): BucUsageSummary | undefined {
  if (!header) return undefined;
  try {
    const parsed = JSON.parse(header) as Record<
      string,
      Array<{
        call_count?: number;
        total_cputime?: number;
        total_time?: number;
        estimated_time_to_regain_access?: number;
      }>
    >;

    let maxBuc = 0;
    let maxWait = 0;
    let found = false;

    for (const pageKey of Object.keys(parsed)) {
      const entries = parsed[pageKey];
      if (Array.isArray(entries)) {
        found = true;
        const entryMetrics = parseBucEntries(entries);
        if (entryMetrics.maxBuc > maxBuc) maxBuc = entryMetrics.maxBuc;
        if (entryMetrics.maxWait > maxWait) maxWait = entryMetrics.maxWait;
      }
    }

    if (!found) return undefined;
    return {
      bucUsageMaxPct: maxBuc,
      ...(maxWait > 0 ? { estimatedTimeToRegainAccessMinutes: maxWait } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Parses Facebook Graph API rate limit telemetry headers (X-App-Usage and X-Business-Use-Case-Usage).
 */
export function parseGraphRateLimitHeaders(
  headers?: Headers | null
): GraphRateLimitTelemetry | undefined {
  if (!headers) return undefined;

  const appUsageMaxPct = parseAppUsage(headers.get('x-app-usage'));
  const bucSummary = parseBucUsage(headers.get('x-business-use-case-usage'));

  if (appUsageMaxPct === undefined && !bucSummary) {
    return undefined;
  }

  return {
    ...(appUsageMaxPct !== undefined ? { appUsageMaxPct } : {}),
    ...(bucSummary?.bucUsageMaxPct !== undefined ? { bucUsageMaxPct: bucSummary.bucUsageMaxPct } : {}),
    ...(bucSummary?.estimatedTimeToRegainAccessMinutes !== undefined
      ? { estimatedTimeToRegainAccessMinutes: bucSummary.estimatedTimeToRegainAccessMinutes }
      : {}),
  };
}

export interface FacebookPublishClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  /** Per-attempt timeout for Graph API calls. Defaults to FB_GRAPH_TIMEOUT_MS. */
  graphTimeoutMs?: number;
  /** Per-attempt timeout for media transfers. Defaults to FB_MEDIA_TIMEOUT_MS. */
  mediaTimeoutMs?: number;
}

function trimTrailingSlashes(str: string): string {
  let end = str.length;
  while (end > 0 && str.codePointAt(end - 1) === 47) {
    end--;
  }
  return str.slice(0, end);
}

export class FacebookPublishClient implements IFacebookPublishClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly graphTimeoutMs: number;
  private readonly mediaTimeoutMs: number;

  constructor(options?: FacebookPublishClientOptions) {
    this.baseUrl = trimTrailingSlashes(options?.baseUrl ?? FB_GRAPH_API_BASE_URL);
    // Workerd brand-checks its native fetch: storing `globalThis.fetch`
    // as an instance field and calling it as `this.fetchFn(...)` binds
    // `this` to this client, and workerd rejects that receiver with
    // "Illegal invocation". Node/bun permit detached fetch, so tests
    // never caught it — every publish died before reaching Facebook.
    // The arrow wrapper calls fetch as a bare identifier, so the
    // receiver is never the client. Do NOT "simplify" this back to
    // `globalThis.fetch`.
    this.fetchFn =
      options?.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.graphTimeoutMs = options?.graphTimeoutMs ?? FB_GRAPH_TIMEOUT_MS;
    this.mediaTimeoutMs = options?.mediaTimeoutMs ?? FB_MEDIA_TIMEOUT_MS;
  }

  /** Fetch options for a Graph API call under the retryable (pre-publish) policy. */
  private graphRetryable(): FetchCallOptions {
    return { policy: 'retryable', timeoutMs: this.graphTimeoutMs };
  }

  /** Fetch options for a publish-mutating Graph call: exactly one attempt. */
  private graphPublish(): FetchCallOptions {
    return { policy: 'single-attempt', timeoutMs: this.graphTimeoutMs };
  }

  /**
   * Starts a Reel upload session: `POST /{page}/video_reels`
   * `{"upload_phase":"start"}`. Returns the session's `video_id` and the
   * `upload_url` Facebook assigned it — always use the returned URL,
   * never a hardcoded versioned rupload URL (a v26.0 start has returned
   * a v27.0 upload URL in production).
   */
  private async startReelUploadSession(
    pageId: string,
    accessToken: string
  ): Promise<{ videoId: string; uploadUrl: string }> {
    const startUrl = `${this.baseUrl}/${encodeURIComponent(pageId)}/video_reels`;
    const startRes = await this.fetchWithRetry(startUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        upload_phase: 'start',
      }),
    }, this.graphRetryable());

    const { data: startData, rawBody } = await this.parseJsonResponseWithRaw(startRes);

    if (!startRes.ok || startData.error) {
      throw this.createGraphError(startRes, startData, {
        phase: 'reel-start',
        httpStatus: startRes.status,
        rawBody,
      });
    }

    const { video_id: videoId, upload_url: uploadUrl } = startData;
    if (!videoId || !uploadUrl) {
      throw new FacebookGraphError(
        'Invalid start session response from Facebook: missing video_id or upload_url',
        undefined,
        undefined,
        { phase: 'reel-start', httpStatus: startRes.status, rawBody }
      );
    }

    return { videoId: String(videoId), uploadUrl: String(uploadUrl) };
  }

  /**
   * Reel upload, primary mode (`file_url`): a no-body POST to the
   * session's `upload_url` with header `file_url: <hosted URL>`, and
   * Facebook fetches the file itself — no video bytes pass through this
   * worker. This is the old publisher's mode, restored: the streaming
   * mode it replaced is the prime suspect for the prod 0/690 reels
   * failure (it works from Node, but workerd streaming / Cloudflare
   * egress to rupload is unproven). Success is HTTP ok AND a parsed
   * body with `success === true`, exactly the old publisher's condition.
   * Retryable: replaying re-triggers Facebook's fetch and cannot create
   * a visible post.
   */
  private async uploadReelViaFileUrl(
    uploadUrl: string,
    accessToken: string,
    videoUrl: string
  ): Promise<FacebookUploadAttemptDiagnostic> {
    const res = await this.fetchWithRetry(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${accessToken}`,
        file_url: videoUrl,
      },
    }, {
      policy: 'retryable',
      timeoutMs: this.mediaTimeoutMs,
    });

    const { data, rawBody } = await this.parseJsonResponseWithRaw(res);
    return {
      mode: 'file_url',
      success: res.ok && data.success === true,
      httpStatus: res.status,
      rawBody,
    };
  }

  /**
   * Combines a failed streaming fallback with the already-failed
   * `file_url` attempt into one error that names both attempts, so the
   * stored reason never shows only the last failure. The original
   * Graph code / telemetry are preserved so classification is unchanged.
   */
  private combineReelUploadError(
    err: unknown,
    fileUrlAttempt: FacebookUploadAttemptDiagnostic
  ): FacebookGraphError {
    const streamAttempt: FacebookUploadAttemptDiagnostic = { mode: 'stream', success: false };
    let message: string;
    let errorData: FacebookGraphErrorData | undefined;
    let telemetry: GraphRateLimitTelemetry | undefined;
    if (err instanceof FacebookGraphError) {
      message = err.message;
      errorData = {
        ...(err.code !== undefined ? { code: err.code } : {}),
        ...(err.errorSubcode !== undefined
          ? { error_subcode: err.errorSubcode }
          : {}),
        ...(err.errorType !== undefined ? { type: err.errorType } : {}),
        ...(err.fbtraceId !== undefined ? { fbtrace_id: err.fbtraceId } : {}),
      };
      telemetry = err.telemetry;
      streamAttempt.httpStatus = err.diagnostic?.httpStatus;
      streamAttempt.rawBody = err.diagnostic?.rawBody;
    } else {
      message = err instanceof Error ? err.message : String(err);
      streamAttempt.message = message;
    }
    return new FacebookGraphError(message, errorData, telemetry, {
      phase: 'reel-upload-stream',
      httpStatus: streamAttempt.httpStatus,
      rawBody: streamAttempt.rawBody,
      attempts: [fileUrlAttempt, streamAttempt],
    });
  }

  /**
   * A fresh-session start for the streaming fallback can itself throw;
   * without this, the already-failed file_url attempt would vanish from
   * the DB diagnostic entirely (only the console warn would retain it).
   * Attach the file_url attempt to the start error's diagnostic so the
   * first failure is never lost from publish_logs.detail. The start
   * error's own phase, status, body, and Graph code are preserved
   * untouched — only the attempts list is added.
   */
  private attachFileUrlAttemptToStartError(
    err: unknown,
    fileUrlAttempt: FacebookUploadAttemptDiagnostic
  ): FacebookGraphError {
    if (err instanceof FacebookGraphError) {
      return new FacebookGraphError(
        err.message,
        {
          ...(err.code !== undefined ? { code: err.code } : {}),
          ...(err.errorSubcode !== undefined ? { error_subcode: err.errorSubcode } : {}),
          ...(err.errorType !== undefined ? { type: err.errorType } : {}),
          ...(err.fbtraceId !== undefined ? { fbtrace_id: err.fbtraceId } : {}),
        },
        err.telemetry,
        {
          phase: err.diagnostic?.phase ?? 'reel-start',
          ...(err.diagnostic?.httpStatus !== undefined
            ? { httpStatus: err.diagnostic.httpStatus }
            : {}),
          ...(err.diagnostic?.rawBody !== undefined
            ? { rawBody: err.diagnostic.rawBody }
            : {}),
          attempts: [fileUrlAttempt],
        }
      );
    }
    return new FacebookGraphError(
      err instanceof Error ? err.message : String(err),
      undefined,
      undefined,
      { phase: 'reel-start', attempts: [fileUrlAttempt] }
    );
  }

  /**
   * Publishes a reel, with one console line per outcome for Cloudflare
   * Worker Logs (the dashboard live tail reads console output; the
   * worker has no [observability] section). The DB diagnostic is
   * untouched — this is the same failure, also visible in Logs. Only
   * ids, phases, statuses, and truncated Facebook bodies are logged:
   * never a token, never media bytes.
   */
  async publishReel(params: {
    pageId: string;
    accessToken: string;
    videoUrl: string;
    caption: string;
    itemId?: string | undefined;
  }): Promise<PublishResult> {
    const { pageId, itemId } = params;
    const itemLabel = itemId ?? 'unknown';
    try {
      const { uploadMode, ...result } = await this.publishReelInner(params);
      console.info(
        `[reel-publish] item=${itemLabel} page=${pageId} published mode=${uploadMode} post=${result.postId}`
      );
      return result;
    } catch (err) {
      const diagnostic = err instanceof FacebookGraphError ? err.diagnostic : undefined;
      const phase = diagnostic?.phase ?? 'reel-upload';
      const status = diagnostic?.httpStatus ?? 'unknown';
      const body =
        diagnostic?.rawBody !== undefined
          ? oneLineLogText(diagnostic.rawBody)
          : oneLineLogText(err instanceof Error ? err.message : String(err));
      const attempts = diagnostic?.attempts
        ? ` attempts=[${diagnostic.attempts
            .map((attempt) => `${attempt.mode}:${attempt.httpStatus ?? 'unknown'}`)
            .join(',')}]`
        : '';
      console.error(
        `[reel-publish] item=${itemLabel} page=${pageId} failed phase=${phase} status=${status} body=${body}${attempts}`
      );
      throw err;
    }
  }

  private async publishReelInner(params: {
    pageId: string;
    accessToken: string;
    videoUrl: string;
    caption: string;
    itemId?: string | undefined;
  }): Promise<PublishResult & { uploadMode: 'file_url' | 'stream' }> {
    const { pageId, accessToken, videoUrl, caption, itemId } = params;
    const itemLabel = itemId ?? 'unknown';

    // Phase 1: Start upload session
    let { videoId, uploadUrl } = await this.startReelUploadSession(pageId, accessToken);

    // Phase 2, primary: file_url — Facebook fetches the file itself.
    // A throw (timeout via AbortSignal.timeout, network error) is a
    // failed attempt too: record it and fall back, never let it skip
    // the fallback — otherwise the failure lands as bare code `unknown`
    // with no attempts diagnostic, the exact signature this change
    // exists to eliminate (spec step 3: fallback on a fetch failure).
    let fileUrlAttempt: FacebookUploadAttemptDiagnostic;
    try {
      fileUrlAttempt = await this.uploadReelViaFileUrl(uploadUrl, accessToken, videoUrl);
    } catch (err) {
      fileUrlAttempt = {
        mode: 'file_url',
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    let uploadMode: 'file_url' | 'stream' = 'file_url';
    if (!fileUrlAttempt.success) {
      // One warn line so the fallback is visible in Worker Logs.
      console.warn(
        `[reel-publish] item=${itemLabel} page=${pageId} file_url upload failed phase=reel-upload-file-url status=${fileUrlAttempt.httpStatus ?? 'unknown'} body=${oneLineLogText(fileUrlAttempt.message ?? fileUrlAttempt.rawBody ?? '')}; falling back to streaming`
      );
      // Fallback, once: a fresh upload session first — the old publisher
      // reset videoId after a hosted-upload failure, because a failed
      // upload may poison the session, so never stream into the failed
      // session's URL — then stream the bytes with the existing uploader.
      let fresh: { videoId: string; uploadUrl: string };
      try {
        fresh = await this.startReelUploadSession(pageId, accessToken);
      } catch (err) {
        throw this.attachFileUrlAttemptToStartError(err, fileUrlAttempt);
      }
      videoId = fresh.videoId;
      uploadUrl = fresh.uploadUrl;
      try {
        await this.streamVideoUpload(uploadUrl, accessToken, videoUrl, 'reel-upload-stream');
      } catch (err) {
        throw this.combineReelUploadError(err, fileUrlAttempt);
      }
      uploadMode = 'stream';
    }

    // Phase 3: Finish upload and publish
    const finishUrl = `${this.baseUrl}/${encodeURIComponent(pageId)}/video_reels`;
    const finishRes = await this.fetchWithRetry(finishUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        upload_phase: 'finish',
        video_state: 'PUBLISHED',
        description: caption,
        video_id: videoId,
      }),
    }, this.graphPublish());

    const { data: finishData, rawBody: finishRawBody } =
      await this.parseJsonResponseWithRaw(finishRes);

    if (!finishRes.ok || finishData.error) {
      throw this.createGraphError(finishRes, finishData, {
        phase: 'reel-finish',
        httpStatus: finishRes.status,
        rawBody: finishRawBody,
      });
    }

    const telemetry = parseGraphRateLimitHeaders(finishRes.headers);
    const postId = finishData.post_id ?? finishData.id ?? finishData.video_id ?? videoId;
    return { postId: String(postId), ...(telemetry ? { telemetry } : {}), uploadMode };
  }

  async publishPhoto(params: {
    pageId: string;
    accessToken: string;
    imageUrl: string;
    caption: string;
  }): Promise<PublishResult> {
    const { pageId, accessToken, imageUrl, caption } = params;
    const url = `${this.baseUrl}/${encodeURIComponent(pageId)}/photos`;

    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: imageUrl,
        caption,
        published: true,
      }),
    }, this.graphPublish());

    const data = (await this.parseJsonResponse(res)) as {
      id?: string;
      post_id?: string;
      error?: FacebookGraphErrorData;
    };

    if (!res.ok || data.error) {
      throw this.createGraphError(res, data);
    }

    const postId = data.post_id ?? data.id;
    if (!postId) {
      throw new FacebookGraphError('Invalid photo response from Facebook: missing id/post_id');
    }

    const telemetry = parseGraphRateLimitHeaders(res.headers);
    return { postId: String(postId), ...(telemetry ? { telemetry } : {}) };
  }

  async publishTextPost(params: {
    pageId: string;
    accessToken: string;
    message: string;
    linkUrl?: string | null | undefined;
  }): Promise<PublishResult> {
    const { pageId, accessToken, message, linkUrl } = params;
    const url = `${this.baseUrl}/${encodeURIComponent(pageId)}/feed`;

    const bodyPayload: Record<string, string> = { message };
    if (linkUrl) {
      bodyPayload.link = linkUrl;
    }

    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyPayload),
    }, this.graphPublish());

    const data = (await this.parseJsonResponse(res)) as {
      id?: string;
      error?: FacebookGraphErrorData;
    };

    if (!res.ok || data.error) {
      throw this.createGraphError(res, data);
    }

    if (!data.id) {
      throw new FacebookGraphError('Invalid text feed response from Facebook: missing id');
    }

    const telemetry = parseGraphRateLimitHeaders(res.headers);
    return { postId: String(data.id), ...(telemetry ? { telemetry } : {}) };
  }

  async publishVideo(params: {
    pageId: string;
    accessToken: string;
    videoUrl: string;
    caption: string;
    title?: string | undefined;
  }): Promise<PublishResult> {
    const { pageId, accessToken, videoUrl, caption, title } = params;
    const url = `${this.baseUrl}/${encodeURIComponent(pageId)}/videos`;

    const bodyPayload: Record<string, string> = {
      file_url: videoUrl,
      description: caption,
    };
    if (title) {
      bodyPayload.title = title;
    }

    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyPayload),
    }, this.graphPublish());

    const data = (await this.parseJsonResponse(res)) as {
      id?: string;
      error?: FacebookGraphErrorData;
    };

    if (!res.ok || data.error) {
      throw this.createGraphError(res, data);
    }

    if (!data.id) {
      throw new FacebookGraphError('Invalid video response from Facebook: missing id');
    }

    const telemetry = parseGraphRateLimitHeaders(res.headers);
    return { postId: String(data.id), ...(telemetry ? { telemetry } : {}) };
  }

  async publishPhotoStory(params: {
    pageId: string;
    accessToken: string;
    imageUrl: string;
  }): Promise<PublishResult> {
    const { pageId, accessToken, imageUrl } = params;

    // Step 1: Upload unpublished photo
    const photoUploadUrl = `${this.baseUrl}/${encodeURIComponent(pageId)}/photos`;
    const photoRes = await this.fetchWithRetry(photoUploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: imageUrl,
        published: false,
      }),
    }, this.graphRetryable());

    const photoData = (await this.parseJsonResponse(photoRes)) as {
      id?: string;
      error?: FacebookGraphErrorData;
    };

    if (!photoRes.ok || photoData.error) {
      throw this.createGraphError(photoRes, photoData);
    }

    if (!photoData.id) {
      throw new FacebookGraphError('Invalid photo upload response for story: missing id');
    }
    const photoId = String(photoData.id);

    // Step 2: Publish Photo Story
    const storyUrl = `${this.baseUrl}/${encodeURIComponent(pageId)}/photo_stories`;
    const storyRes = await this.fetchWithRetry(storyUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        photo_id: photoId,
      }),
    }, this.graphPublish());

    const storyData = (await this.parseJsonResponse(storyRes)) as {
      id?: string;
      post_id?: string;
      error?: FacebookGraphErrorData;
    };

    if (!storyRes.ok || storyData.error) {
      throw this.createGraphError(storyRes, storyData);
    }

    const postId = storyData.post_id ?? storyData.id ?? photoId;
    const telemetry = parseGraphRateLimitHeaders(storyRes.headers);
    return { postId: String(postId), ...(telemetry ? { telemetry } : {}) };
  }

  async publishVideoStory(params: {
    pageId: string;
    accessToken: string;
    videoUrl: string;
  }): Promise<PublishResult> {
    const { pageId, accessToken, videoUrl } = params;

    // Step 1: Start Video Story session
    const startUrl = `${this.baseUrl}/${encodeURIComponent(pageId)}/video_stories`;
    const startRes = await this.fetchWithRetry(startUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        upload_phase: 'start',
      }),
    }, this.graphRetryable());

    const startData = (await this.parseJsonResponse(startRes)) as {
      video_id?: string;
      upload_url?: string;
      error?: FacebookGraphErrorData;
    };

    if (!startRes.ok || startData.error) {
      throw this.createGraphError(startRes, startData);
    }

    if (!startData.video_id) {
      throw new FacebookGraphError('Invalid video upload response for story: missing video_id');
    }
    const videoId = String(startData.video_id);
    const uploadUrl =
      startData.upload_url ?? `${FB_RUPLOAD_BASE_URL}/${videoId}`;

    // Step 2: Stream video bytes from videoUrl to upload_url
    await this.streamVideoUpload(uploadUrl, accessToken, videoUrl, 'video-story-upload-stream');

    // Step 3: Finish Video Story
    const finishUrl = `${this.baseUrl}/${encodeURIComponent(pageId)}/video_stories`;
    const finishRes = await this.fetchWithRetry(finishUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        upload_phase: 'finish',
        video_id: videoId,
      }),
    }, this.graphPublish());

    const finishData = (await this.parseJsonResponse(finishRes)) as {
      id?: string;
      post_id?: string;
      error?: FacebookGraphErrorData;
    };

    if (!finishRes.ok || finishData.error) {
      throw this.createGraphError(finishRes, finishData);
    }

    const postId = finishData.post_id ?? finishData.id ?? videoId;
    const telemetry = parseGraphRateLimitHeaders(finishRes.headers);
    return { postId: String(postId), ...(telemetry ? { telemetry } : {}) };
  }

  async postComment(params: {
    postId: string;
    accessToken: string;
    message: string;
  }): Promise<{ commentId: string; telemetry?: GraphRateLimitTelemetry | undefined }> {
    const { postId, accessToken, message } = params;
    const url = `${this.baseUrl}/${encodeURIComponent(postId)}/comments`;

    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
      }),
    }, this.graphPublish());

    const data = (await this.parseJsonResponse(res)) as {
      id?: string;
      error?: FacebookGraphErrorData;
    };

    if (!res.ok || data.error) {
      throw this.createGraphError(res, data);
    }

    if (!data.id) {
      throw new FacebookGraphError('Invalid comment response from Facebook: missing id');
    }

    const telemetry = parseGraphRateLimitHeaders(res.headers);
    return { commentId: String(data.id), ...(telemetry ? { telemetry } : {}) };
  }

  /**
   * fetch under a per-call retry policy (see FetchRetryPolicy). `retryable`
   * calls retry network failures, HTTP 429/5xx, and transient Graph API
   * errors (e.g. rate-limit 368) with exponential backoff; `single-attempt`
   * (publish-mutating) calls make exactly one attempt — a lost response is
   * ambiguous and must not be blindly replayed. Returns the last response
   * when retries are exhausted so callers' existing error handling applies.
   * Every attempt is bounded by the call's timeout via AbortSignal.timeout.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit | undefined,
    options: FetchCallOptions
  ): Promise<Response> {
    const maxAttempts = options.policy === 'retryable' ? FB_RETRY_MAX_ATTEMPTS : 1;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let res: Response;
      try {
        res = await this.fetchFn(url, this.withTimeout(init, options.timeoutMs));
      } catch (err) {
        if (attempt >= maxAttempts) throw err;
        await sleepMs(retryDelayMs(attempt));
        continue;
      }
      if (res.ok) return res;
      if (attempt >= maxAttempts || !(await isRetryableGraphResponse(res))) {
        return res;
      }
      await sleepMs(retryDelayMs(attempt));
    }
  }

  /**
   * Applies a fresh per-attempt timeout to a fetch init, unless the caller
   * supplied its own signal (none do today — kept so a future caller-managed
   * cancellation is never silently replaced).
   */
  private withTimeout(init: RequestInit | undefined, timeoutMs: number): RequestInit {
    if (init?.signal) return init;
    return { ...init, signal: AbortSignal.timeout(timeoutMs) };
  }

  private async parseJsonResponse(res: Response): Promise<Record<string, unknown>> {
    try {
      const data = await res.json();
      return (data as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Reads a response as text first, then parses it: the raw body survives
   * even when Facebook returns no JSON at all (the prod 400s arrived
   * body-less, and `res.json()` on an empty body throws the evidence
   * away). Returns the parsed object ({} when unparseable/empty) plus
   * the raw body truncated to FACEBOOK_RAW_BODY_MAX_CHARS. Consumes the
   * body — callers must not read it again afterwards.
   */
  private async parseJsonResponseWithRaw(
    res: Response
  ): Promise<{ data: Record<string, unknown>; rawBody: string }> {
    let rawText = '';
    try {
      rawText = await res.text();
    } catch {
      rawText = '';
    }
    const rawBody = rawText.slice(0, FACEBOOK_RAW_BODY_MAX_CHARS);
    if (!rawText) return { data: {}, rawBody };
    try {
      return { data: (JSON.parse(rawText) as Record<string, unknown>) ?? {}, rawBody };
    } catch {
      return { data: {}, rawBody };
    }
  }

  private createGraphError(
    res: Response,
    data: Record<string, unknown>,
    diagnostic?: FacebookPublishDiagnostic
  ): FacebookGraphError {
    const errorData = (data?.error as FacebookGraphErrorData) ?? undefined;
    // Name the failing phase in the message itself: with no Graph error
    // body, this message is the only reason the queue item carries.
    const message =
      errorData?.message ??
      `Facebook Graph API error: HTTP ${res.status}` +
        (diagnostic ? ` (${diagnostic.phase})` : '');
    const telemetry = parseGraphRateLimitHeaders(res.headers);
    return new FacebookGraphError(message, errorData, telemetry, diagnostic);
  }

  private async streamVideoUpload(
    uploadUrl: string,
    accessToken: string,
    videoUrl: string,
    phase: FacebookPublishPhase
  ): Promise<void> {
    const videoRes = await this.fetchWithRetry(videoUrl, undefined, {
      policy: 'retryable',
      timeoutMs: this.mediaTimeoutMs,
    });
    if (!videoRes.ok || !videoRes.body) {
      throw new InternalError(`Failed to fetch video from ${videoUrl}: HTTP ${videoRes.status}`);
    }

    // Single-attempt: the request body is a one-shot ReadableStream that
    // cannot be replayed after a lost response; the queue layer retries the
    // whole publish (re-fetch + re-upload) instead.
    const uploadRes = await this.fetchWithRetry(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${accessToken}`,
        offset: '0',
        'Content-Type': 'application/octet-stream',
      },
      body: videoRes.body,
      duplex: 'half',
    } as RequestInit, {
      policy: 'single-attempt',
      timeoutMs: this.mediaTimeoutMs,
    });

    if (!uploadRes.ok) {
      const { data: uploadData, rawBody } = await this.parseJsonResponseWithRaw(uploadRes);
      throw this.createGraphError(uploadRes, uploadData, {
        phase,
        httpStatus: uploadRes.status,
        rawBody,
      });
    }
  }
}
