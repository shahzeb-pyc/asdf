import type { ThreadsPublishNowResult } from '@fbuploadpro/contracts';

/** A selected Threads account — the destination itself. */
export interface ThreadsPublishNowSelectedAccount {
  accountId: string;
  threadsUserId: string;
  accountName: string;
  handle: string | null;
  profilePictureUrl: string | null;
}

export type ThreadsPublishNowResultItem = ThreadsPublishNowResult;

/** Attached media in the single-post composer. */
export interface ThreadsPublishNowAttachedMedia {
  name: string;
  mediaType: 'image' | 'video';
  aspectRatio: string | null;
  thumbnailUrl: string | null;
  url: string;
  width: number | null;
  height: number | null;
  captionText: string | null;
  /** Set only for library media (a real media_items id). */
  libraryId: string | null;
  /** Set only for temporary device media (an R2 temp key). */
  tempKey: string | null;
}
