import type { FacebookPageItem } from '../../page-card';
import type { PostFormat } from '@fbuploadpro/contracts';

/**
 * A queue item as rendered by the Content tab. Shape is identical to the
 * previous tab implementation so the page route keeps working unchanged.
 */
export interface DedicatedQueueItem {
  id: string;
  mediaId?: string | null;
  postFormat?: PostFormat;
  linkUrl?: string | null;
  caption?: string | null;
  firstComment?: string | null;
  scheduledTime: string;
  status: 'queued' | 'publishing' | 'published' | 'failed' | 'skipped' | 'cancelled';
  retryCount?: number;
  maxRetries?: number;
  fbPostId?: string | null;
  publishedAt?: string | null;
  createdAt: string;
  media?: {
    name: string;
    mediaType: 'video' | 'image';
    thumbnailUrl?: string | null;
    url: string;
    aspectRatio?: string;
    durationSeconds?: number | null;
  } | null;
}

export interface PageTabQueueProps {
  page: FacebookPageItem;
  isLoading?: boolean;
  /**
   * PROPS BRIDGE DELETED (spec 131 PR-131-3, PR-134-1's named deleter
   * duty): the panel previously received `queueItems` + `onMutated` +
   * item callbacks from the section route and seeded its cache from
   * them. The panel now reads `queryKeys.queue.items` directly and its
   * mutations invalidate the shared keys — the frame's Queue count and
   * dashboard tab read the same cache entry, so they stay in sync
   * without any prop drilling from the route.
   */
}

/** Content-tab status filter. "Queued" = slot-based, "Scheduled" = custom time. */
export type QueueFilter = 'all' | 'queued' | 'scheduled' | 'published' | 'failed';

export const QUEUE_FILTERS: ReadonlyArray<QueueFilter> = [
  'all',
  'queued',
  'scheduled',
  'published',
  'failed',
];

export const QUEUE_FILTER_LABELS: Record<QueueFilter, string> = {
  all: 'All',
  queued: 'Queued',
  scheduled: 'Scheduled',
  published: 'Published',
  failed: 'Failed',
};
