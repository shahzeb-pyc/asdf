import type { BulkDeleteContentItem } from '@fbuploadpro/contracts';

/** One discovered Facebook page, grouped under its account. */
export interface BulkDeleteDiscoveredPage {
  accountId: string;
  accountName: string;
  fbPageId: string;
  pageName: string;
  profilePictureUrl: string | null;
  followers: number;
}

export interface BulkDeleteDiscoveredGroup {
  accountId: string;
  accountName: string;
  pages: BulkDeleteDiscoveredPage[];
}

/** A listed live post, tagged with the page it came from. */
export type BulkDeleteCandidate = BulkDeleteContentItem & {
  accountId: string;
  pageId: string;
  pageName: string;
};

export interface BulkDeleteRunFailure {
  id: string;
  pageName: string;
  error: string;
}

export interface BulkDeleteRunState {
  status: 'running' | 'paused' | 'done';
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  currentBatch: number;
  totalBatches: number;
  startedAt: number;
  /** Seconds left in the pause between batches; 0 while deleting. */
  pauseSecondsLeft: number;
  failures: BulkDeleteRunFailure[];
}
