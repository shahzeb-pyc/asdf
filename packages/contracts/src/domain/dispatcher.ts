import { z } from 'zod';
import type { FacebookPageStatus, FacebookAccountStatus } from './facebook.js';
import {
  PostFormatSchema,
  type GraphRateLimitTelemetry,
  type PublishResult,
} from './publishing.js';

// ==========================================
// Edge Dispatcher & Facebook Graph API Contracts (T117)
// ==========================================

// Due Queue Item claimed by worker
export const ClaimedQueueItemSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  pageId: z.string().uuid(),
  facebookAccountId: z.string().uuid().nullable().optional(),
  mediaId: z.string().uuid().nullable().optional(),
  postFormat: PostFormatSchema.optional(),
  linkUrl: z.string().nullable().optional(),
  caption: z.string(),
  firstComment: z.string().nullable(),
  retryCount: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  // Joined media details (nullable/optional for text posts)
  mediaType: z.enum(['video', 'image']).nullable().optional(),
  mediaUrl: z.string().url().nullable().optional(),
  storageKey: z.string().nullable().optional(),
  // Joined page details
  fbPageId: z.string(),
  encryptedPageToken: z.string(),
  pageName: z.string().optional().default(''),
});

export type ClaimedQueueItem = z.infer<typeof ClaimedQueueItemSchema>;

// Dispatch Outcome
export interface DispatchOutcome {
  queueItemId: string;
  status: 'published' | 'failed' | 'retry' | 'queued';
  fbPostId?: string | undefined;
  fbCommentId?: string | undefined;
  errorMessage?: string | undefined;
  errorCode?: number | undefined;
  errorSubcode?: number | undefined;
  targetPageStatus?: FacebookPageStatus | undefined;
  targetAccountStatus?: FacebookAccountStatus | 'active' | 'expired' | undefined;
  retryDelaySeconds?: number | undefined;
  bucUsagePct?: number | undefined;
}

export const DispatchOutcomeSchema = z.object({
  queueItemId: z.string().uuid(),
  status: z.enum(['published', 'failed', 'retry', 'queued']),
  fbPostId: z.string().optional(),
  fbCommentId: z.string().optional(),
  errorMessage: z.string().optional(),
  errorCode: z.number().int().optional(),
  errorSubcode: z.number().int().optional(),
  targetPageStatus: z.string().optional(),
  targetAccountStatus: z.string().optional(),
  retryDelaySeconds: z.number().int().optional(),
  bucUsagePct: z.number().int().min(0).max(100).optional(),
});

// Publish Log Domain Model
export const PublishLogSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  queueItemId: z.string().uuid(),
  pageId: z.string().uuid(),
  status: z.enum(['success', 'failure', 'retry']),
  attemptNumber: z.number().int().positive(),
  fbResponseCode: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  errorDetails: z.record(z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});

export type PublishLog = z.infer<typeof PublishLogSchema>;

// List Publish Logs Query
export const ListPublishLogsQuerySchema = z.object({
  pageId: z.string().uuid().optional(),
  status: z.enum(['success', 'failure', 'retry']).optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export type ListPublishLogsQuery = z.infer<typeof ListPublishLogsQuerySchema>;

// List Publish Logs Response
export const ListPublishLogsResponseSchema = z.object({
  logs: z.array(PublishLogSchema),
  total: z.number().int().nonnegative(),
});

export type ListPublishLogsResponse = z.infer<typeof ListPublishLogsResponseSchema>;

// Dispatcher Service Interface
export interface IPublishDispatcher {
  /**
   * Atomically claims due queue items using FOR UPDATE SKIP LOCKED
   */
  claimDueItems(limit?: number): Promise<ClaimedQueueItem[]>;

  /**
   * Dispatches a single claimed item to Facebook Graph API v26.0
   */
  dispatchItem(item: ClaimedQueueItem): Promise<DispatchOutcome>;

  /**
   * Settles publish outcome and audit log
   */
  settleOutcome(outcome: DispatchOutcome): Promise<void>;

  /**
   * Executes the full claim-dispatch-settle batch cycle
   */
  runDispatchCycle(limit?: number): Promise<{ processed: number; succeeded: number; failed: number }>;
}

// Facebook Graph API Client Interface
export interface IFacebookPublishClient {
  /**
   * Publishes a video/reel via 3-phase session
   *
   * `itemId` is the queue / mirror-post row id being published, when
   * the caller knows it. It is only used for console logging (the
   * `[reel-publish]` lines in Cloudflare Worker Logs), never sent to
   * Facebook. Optional so existing callers keep working.
   */
  publishReel(params: {
    pageId: string;
    accessToken: string;
    videoUrl: string;
    caption: string;
    itemId?: string | undefined;
  }): Promise<{ postId: string; telemetry?: GraphRateLimitTelemetry | undefined }>;

  /**
   * Publishes an image/photo
   */
  publishPhoto(params: {
    pageId: string;
    accessToken: string;
    imageUrl: string;
    caption: string;
  }): Promise<{ postId: string; telemetry?: GraphRateLimitTelemetry | undefined }>;

  /**
   * Posts an automated first comment
   */
  postComment(params: {
    postId: string;
    accessToken: string;
    message: string;
  }): Promise<{ commentId: string; telemetry?: GraphRateLimitTelemetry | undefined }>;

  /**
   * Publishes a text/link post
   */
  publishTextPost?(params: {
    pageId: string;
    accessToken: string;
    message: string;
    linkUrl?: string | null | undefined;
  }): Promise<PublishResult>;

  /**
   * Publishes a standard feed video
   */
  publishVideo?(params: {
    pageId: string;
    accessToken: string;
    videoUrl: string;
    caption: string;
    title?: string | undefined;
  }): Promise<PublishResult>;

  /**
   * Publishes a Facebook Page Photo Story
   */
  publishPhotoStory?(params: {
    pageId: string;
    accessToken: string;
    imageUrl: string;
  }): Promise<PublishResult>;

  /**
   * Publishes a Facebook Page Video Story
   */
  publishVideoStory?(params: {
    pageId: string;
    accessToken: string;
    videoUrl: string;
  }): Promise<PublishResult>;
}
