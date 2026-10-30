/**
 * Instagram Publish Now flow types (client-side only).
 *
 * A selected account is a CONNECTED Instagram account from the
 * Instagram Accounts section — never a discovered page, never a
 * destination created by this flow. Selecting it here writes no
 * destinations row, and publishing here does not add anything to
 * any schedule section: this flow saves nothing (see the spec).
 */

export interface InstagramPublishNowSelectedAccount {
  accountId: string;
  accountName: string;
  profilePictureUrl?: string | null | undefined;
}

export interface InstagramPublishNowResultItem {
  accountId: string;
  accountName: string;
  status: 'published' | 'failed';
  postId: string | null;
  reason: string | null;
  graphCode?: number | null | undefined;
  graphSubcode?: number | null | undefined;
  step?:
    | 'account'
    | 'container-create'
    | 'container-poll'
    | 'media-publish'
    | 'comment'
    | 'media-fetch'
    | 'precheck'
    | null
    | undefined;
  httpStatus?: number | null | undefined;
  fbtraceId?: string | null | undefined;
  firstCommentFailed?: boolean | null | undefined;
  firstCommentReason?: string | null | undefined;
}

/** Attached media in the single-post composer. */
export interface InstagramPublishNowAttachedMedia {
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
