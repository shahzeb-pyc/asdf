/**
 * Publish Now flow types (client-side only).
 *
 * A selected page is a DISCOVERED page, not a workspace destination:
 * selecting it here never creates a destinations row, and a page
 * published here does not appear in Pages unless added separately.
 * The same fbPageId under two accounts is de-duplicated (first
 * selected account wins) so one post can never be published twice
 * to the same Facebook page in one run.
 */
export interface PublishNowSelectedPage {
  accountId: string;
  accountName: string;
  fbPageId: string;
  pageName: string;
  profilePictureUrl?: string | null | undefined;
  category?: string | null | undefined;
  followers: number;
  /** Non-null when the page must not be selectable, with the reason. */
  disabledReason: string | null;
}

export interface PublishNowDiscoveredGroup {
  accountId: string;
  accountName: string;
  pages: PublishNowSelectedPage[];
}

export interface PublishNowResultItem {
  accountId: string;
  fbPageId: string;
  pageName: string;
  status: 'published' | 'failed';
  postId: string | null;
  reason: string | null;
  /** Failure diagnostics from the publish route (null/absent on success).
   * Never carries a token or secret. */
  graphCode?: number | null | undefined;
  graphSubcode?: number | null | undefined;
  step?:
    | 'discover'
    | 'feed'
    | 'photos'
    | 'videos'
    | 'reel-start'
    | 'reel-upload'
    | 'reel-finish'
    | 'media-fetch'
    | 'precheck'
    | 'publish'
    | null
    | undefined;
  httpStatus?: number | null | undefined;
  fbtraceId?: string | null | undefined;
}

/** Attached media in the single-post composer. */
export interface PublishNowAttachedMedia {
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
