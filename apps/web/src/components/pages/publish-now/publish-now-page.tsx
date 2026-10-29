'use client';

/**
 * Publish Now page — full page, modelled on the old Direct Post
 * section (~/workspace/old-fbuploadpro, agency/facebook/direct-post),
 * adapted to the current app and to this flow's approved rules:
 *
 *   Wizard (centred, like old) — Step 1 Select Account card
 *     (search, account rows), Step 2 Select Page card (search,
 *     2-column page grid, Back). OLD WAS SINGLE-SELECT — OURS
 *     STAYS MULTI: Step 1 uses checkboxes (expired accounts
 *     shown but NOT selectable, with Reconnect, and NEVER a
 *     "pages linked" count — accounts only); Step 2 shows ALL
 *     discovered pages for ALL selected accounts, grouped by
 *     account, with checkboxes, Select All / Deselect All, and
 *     pages-found count. Already-added pages whose destination
 *     is paused / rate-limited / checkpoint / invalid-token /
 *     disconnected are disabled with a reason; a page under two
 *     accounts is de-duplicated to the first account.
 *   Active composer (like old) — sticky header (overlapping
 *     avatars, selected pages, "via" accounts, Selected badge,
 *     Change selection), then a 2-column grid: composer panel
 *     (1.5fr) + results panel (1fr). Change selection returns
 *     to the wizard WITHOUT clearing caption, media, or the
 *     first comment.
 *   Composer fields, in old order — Post Type buttons (Text /
 *     Image / Video, plus Reel, which old did not have but the
 *     current flow already supports), caption, media, First
 *     comment (optional), Publish Now. Switching type clears
 *     attached media, as old did. The picked type is the type
 *     published (replacing the old derived type): Reel goes
 *     through the reel path, Video through the video path.
 *   First comment — the SAME comment is posted to EVERY
 *     selected page, but ONLY after that page's own post
 *     succeeds (old mechanics: POST /{postId}/comments with the
 *     page token, trimmed message). A failed post gets no
 *     comment. A failed comment never fails the row — the post
 *     DID publish — it shows as a warning line, and "Retry
 *     failed only" never re-publishes a success to retry a
 *     comment.
 *   Results panel — old History panel in layout only: this run
 *     ONLY, never saved history. Per-page tick in a green
 *     circle / cross in a red circle (never status dots),
 *     failure reason + diagnostic line (code/subcode/step/
 *     trace), the account-restriction mapping, and the retry
 *     rules (retry only non-restricted failures, never
 *     successes; disabled when all failed are restricted).
 *
 * Nothing in this flow writes to the database: no queue_items,
 * destinations, idempotency_keys, publish_logs, media_items, or
 * history rows. Device uploads go to a TEMPORARY R2 prefix and
 * are deleted on Start over / replace / remove (kept alive
 * through the results panel so Retry can reuse them). The
 * picker's own Upload tab still goes through the normal library
 * import (known caveat, not fixed here). No token costs, no
 * "Cost: Free" badge — the current app has no token system.
 * Old media caps (10 MB image / 10 GB video) are NOT adopted:
 * the current 500 MB temp cap and image/video MIME allowlist
 * stay.
 */

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeftIcon, Loader2, SearchIcon, SendIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  composerTextLimitForType,
  deriveDefaultCaptionFromFilename,
  PublishNowResponseSchema,
  PublishNowTempMediaResponseSchema,
  type ComposerMedia,
} from '@fbuploadpro/contracts';
import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import { ListFacebookAccountsResponseSchema } from '@/lib/api/schemas/accounts';
import {
  DiscoverPagesResponseSchema,
  ListFacebookPagesResponseSchema,
} from '@/lib/api/schemas/pages';
import { ByocSettingsResponseSchema } from '@/lib/api/schemas/settings';
import { Button } from '@/components/shared/ui/button';
import { Checkbox } from '@/components/shared/ui/checkbox';
import { Input } from '@/components/shared/ui/input';
import { Textarea } from '@/components/shared/ui/textarea';
import { toast } from '@/components/shared/ui/toast';
import { getAccountHealth } from '@/components/accounts/account-health';
import type { FacebookAccountItem } from '@/components/accounts/account-card';
import { buildDirectConnectUrl } from '@/components/accounts/connect-account-modal';
import { getUserInitials } from '@/lib/user-initials';
import { formatPageIdSuffix } from '@/components/pages/page-card';
import {
  buildAccountsHref,
  buildSettingsFacebookHref,
} from '@/components/pages/add-page-helpers';
import { MediaLibraryPicker } from '@/components/pages/dedicated/create-posts/media-library-picker';
import { cn } from '@/lib/utils';
import type {
  PublishNowAttachedMedia,
  PublishNowDiscoveredGroup,
  PublishNowResultItem,
  PublishNowSelectedPage,
} from './types';

export type PublishNowView = 'accounts' | 'pages' | 'composer';
export type PublishNowPostType = 'text' | 'image' | 'video' | 'reel';

const POST_TYPES: Array<{ id: PublishNowPostType; label: string }> = [
  { id: 'text', label: 'Text' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
  { id: 'reel', label: 'Reel' },
];

/** Destination statuses that make an already-added page unpublishable. */
const BLOCKED_PAGE_STATUSES: Record<string, string> = {
  paused: 'Posting paused for this page',
  fb_rate_limited: 'Rate limited by Facebook',
  page_checkpoint: 'Facebook identity check required',
  invalid_token: 'Page connection needs attention',
  disconnected: 'Page disconnected',
};

const TEMP_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const TEMP_MAX_FILE_SIZE_BYTES = 524288000;
/** First comment max, from the old schedule validations (8,000). */
const FIRST_COMMENT_MAX_LENGTH = 8000;

function errorText(error: unknown, fallback: string): string {
  if (isApiError(error) && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/**
 * A failed result is a Meta active account restriction when Facebook
 * returned code 1 with subcode 2424009 or 1404078. The restriction is
 * account-level and non-retryable while it stands, so such rows are
 * never re-attempted by "Retry failed only". Derived from the
 * diagnostics fields the route already returns — no schema change.
 */
function isRestrictedResult(result: PublishNowResultItem): boolean {
  return (
    result.status === 'failed' &&
    result.graphCode === 1 &&
    (result.graphSubcode === 2424009 || result.graphSubcode === 1404078)
  );
}

function Avatar({
  name,
  pictureUrl,
  size = 'md',
}: Readonly<{
  name: string;
  pictureUrl?: string | null | undefined;
  size?: 'md' | 'lg' | undefined;
}>) {
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const showImg = Boolean(pictureUrl) && failedUrl !== pictureUrl;
  const initials = getUserInitials(name) || 'FB';
  const sizeClass = size === 'lg' ? 'size-12' : 'size-9';
  if (showImg) {
    return (
      <Image
        src={pictureUrl!}
        alt={name}
        width={size === 'lg' ? 48 : 36}
        height={size === 'lg' ? 48 : 36}
        onError={() => setFailedUrl(pictureUrl ?? '__error__')}
        className={cn(
          sizeClass,
          'shrink-0 rounded-full border border-line object-cover'
        )}
      />
    );
  }
  return (
    <div
      className={cn(
        sizeClass,
        'flex shrink-0 items-center justify-center rounded-full border border-line bg-subtle text-body font-bold text-ink'
      )}
    >
      {initials}
    </div>
  );
}

async function mediaDimensions(
  file: File,
  mediaType: 'image' | 'video'
): Promise<{ width: number | null; height: number | null }> {
  const url = URL.createObjectURL(file);
  try {
    if (mediaType === 'image') {
      return await new Promise((resolve) => {
        const img = new window.Image();
        img.onload = () =>
          resolve({ width: img.naturalWidth || null, height: img.naturalHeight || null });
        img.onerror = () => resolve({ width: null, height: null });
        img.src = url;
      });
    }
    return await new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () =>
        resolve({ width: video.videoWidth || null, height: video.videoHeight || null });
      video.onerror = () => resolve({ width: null, height: null });
      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function PublishNowPage({ subdomain }: Readonly<{ subdomain: string }>) {
  const [view, setView] = React.useState<PublishNowView>('accounts');
  const [selectedAccountIds, setSelectedAccountIds] = React.useState<string[]>([]);
  const [accountSearchQuery, setAccountSearchQuery] = React.useState('');
  const [groups, setGroups] = React.useState<PublishNowDiscoveredGroup[]>([]);
  const [selectedPageKeys, setSelectedPageKeys] = React.useState<string[]>([]);
  const [pageSearchQuery, setPageSearchQuery] = React.useState('');
  const [isDiscovering, setIsDiscovering] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [postType, setPostType] = React.useState<PublishNowPostType>('text');
  const [text, setText] = React.useState('');
  const [firstComment, setFirstComment] = React.useState('');
  const [attached, setAttached] = React.useState<PublishNowAttachedMedia | null>(null);
  const [attachChoiceOpen, setAttachChoiceOpen] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerSession, setPickerSession] = React.useState(0);
  const [isUploadingTemp, setIsUploadingTemp] = React.useState(false);
  const [isPublishing, setIsPublishing] = React.useState(false);
  const [isRetrying, setIsRetrying] = React.useState(false);
  const [results, setResults] = React.useState<PublishNowResultItem[]>([]);
  const [hasRun, setHasRun] = React.useState(false);
  const [expandedDetails, setExpandedDetails] = React.useState<Set<string>>(
    new Set()
  );
  const tempKeysRef = React.useRef<Set<string>>(new Set());
  const tempInputRef = React.useRef<HTMLInputElement | null>(null);

  const accountsQuery = useQuery({
    queryKey: ['publish-now', 'accounts', subdomain],
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/accounts'), {
        schema: ListFacebookAccountsResponseSchema,
        query: { page: 1, limit: 50 },
        signal,
      }),
  });
  const byocQuery = useQuery({
    queryKey: ['publish-now', 'byoc', subdomain],
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/settings/byoc'), {
        schema: ByocSettingsResponseSchema,
        signal,
      }),
  });

  const accounts = React.useMemo<FacebookAccountItem[]>(
    () => (accountsQuery.data?.accounts ?? []) as FacebookAccountItem[],
    [accountsQuery.data]
  );
  const activeAccounts = React.useMemo(
    () => accounts.filter((acc) => getAccountHealth(acc) === 'connected'),
    [accounts]
  );
  const nonSelectableAccounts = React.useMemo(
    () =>
      accounts.filter((acc) => {
        const health = getAccountHealth(acc);
        return health === 'expired' || health === 'error';
      }),
    [accounts]
  );
  const filteredActiveAccounts = React.useMemo(() => {
    const query = accountSearchQuery.trim().toLowerCase();
    if (!query) return activeAccounts;
    return activeAccounts.filter((acc) =>
      acc.displayName.toLowerCase().includes(query)
    );
  }, [activeAccounts, accountSearchQuery]);
  const facebookAppConfigured = byocQuery.data
    ? Boolean(byocQuery.data.fbAppId && byocQuery.data.hasSecret)
    : undefined;
  const showMissingAppGuidance =
    view === 'accounts' &&
    facebookAppConfigured === false &&
    activeAccounts.length === 0;

  const allPages = React.useMemo<PublishNowSelectedPage[]>(
    () => groups.flatMap((group) => group.pages),
    [groups]
  );
  const selectablePages = React.useMemo(
    () => allPages.filter((page) => !page.disabledReason),
    [allPages]
  );
  const selectedPages = React.useMemo(
    () =>
      allPages.filter((page) =>
        selectedPageKeys.includes(`${page.accountId}:${page.fbPageId}`)
      ),
    [allPages, selectedPageKeys]
  );

  /** Deletes every temp key still tracked for this run, best-effort. */
  const deleteAllTempMedia = React.useCallback(async (): Promise<boolean> => {
    const keys = [...tempKeysRef.current];
    if (keys.length === 0) return true;
    let allDeleted = true;
    await Promise.all(
      keys.map(async (key) => {
        try {
          const response = await fetch(
            buildTenantApiPath(subdomain, '/publishing/publish-now/temp-media'),
            {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key }),
            }
          );
          if (response.ok) {
            tempKeysRef.current.delete(key);
          } else {
            allDeleted = false;
          }
        } catch {
          allDeleted = false;
        }
      })
    );
    return allDeleted;
  }, [subdomain]);

  const toggleAccount = React.useCallback((accountId: string) => {
    setSelectedAccountIds((prev) =>
      prev.includes(accountId)
        ? prev.filter((id) => id !== accountId)
        : [...prev, accountId]
    );
  }, []);

  const handleContinueFromAccounts = React.useCallback(async () => {
    const selectedAccounts = activeAccounts.filter((acc) =>
      selectedAccountIds.includes(acc.id)
    );
    if (selectedAccounts.length === 0) return;
    setIsDiscovering(true);
    setErrorMessage(null);
    try {
      // Already-added destination statuses, for the disabled-with-
      // reason rule. A failed lookup leaves every page selectable,
      // so a page is never hidden because its status is unknown.
      let addedStatusByPage = new Map<string, string>();
      try {
        const pagesResponse = await api.get(
          buildTenantApiPath(subdomain, '/pages'),
          {
            schema: ListFacebookPagesResponseSchema,
            query: { page: 1, limit: 500 },
          }
        );
        addedStatusByPage = new Map(
          (pagesResponse.pages ?? []).map((page) => [page.fbPageId, page.status])
        );
      } catch {
        addedStatusByPage = new Map();
      }

      const settled = await Promise.allSettled(
        selectedAccounts.map(async (account) => {
          const discovered = await api.get(
            buildTenantApiPath(
              subdomain,
              `/accounts/${account.id}/pages/discover`
            ),
            { schema: DiscoverPagesResponseSchema }
          );
          return { account, pages: discovered.pages ?? [] };
        })
      );

      const seenPageIds = new Set<string>();
      const nextGroups: PublishNowDiscoveredGroup[] = [];
      const failures: string[] = [];
      settled.forEach((entry, index) => {
        const account = selectedAccounts[index];
        if (!account) return;
        if (entry.status === 'rejected') {
          failures.push(account.displayName);
          nextGroups.push({
            accountId: account.id,
            accountName: account.displayName,
            pages: [],
          });
          return;
        }
        const pages: PublishNowSelectedPage[] = [];
        for (const page of entry.value.pages) {
          // One post per Facebook page per run, even if two
          // accounts expose the same page.
          if (seenPageIds.has(page.fbPageId)) continue;
          seenPageIds.add(page.fbPageId);
          const status = addedStatusByPage.get(page.fbPageId);
          pages.push({
            accountId: account.id,
            accountName: account.displayName,
            fbPageId: page.fbPageId,
            pageName: page.pageName,
            profilePictureUrl: page.profilePictureUrl,
            category: page.category,
            followers:
              page.currentFollowers ?? page.followersCount ?? 0,
            disabledReason: status ? (BLOCKED_PAGE_STATUSES[status] ?? null) : null,
          });
        }
        nextGroups.push({
          accountId: account.id,
          accountName: account.displayName,
          pages,
        });
      });
      setGroups(nextGroups);
      setSelectedPageKeys([]);
      setPageSearchQuery('');
      if (failures.length > 0) {
        setErrorMessage(
          "Couldn't load pages from this Facebook account. Please check the account connection and try again."
        );
      }
      setView('pages');
    } catch (error) {
      setErrorMessage(
        errorText(
          error,
          'An error occurred while loading pages from Facebook. Please try again.'
        )
      );
    } finally {
      setIsDiscovering(false);
    }
  }, [activeAccounts, selectedAccountIds, subdomain]);

  const handleBackToAccounts = React.useCallback(() => {
    setView('accounts');
    setGroups([]);
    setSelectedPageKeys([]);
    setPageSearchQuery('');
    setErrorMessage(null);
  }, []);

  const togglePage = React.useCallback((key: string) => {
    setSelectedPageKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }, []);

  const toggleSelectAllPages = React.useCallback(() => {
    const selectableKeys = selectablePages.map(
      (page) => `${page.accountId}:${page.fbPageId}`
    );
    const allSelected =
      selectableKeys.length > 0 &&
      selectableKeys.every((key) => selectedPageKeys.includes(key));
    setSelectedPageKeys(allSelected ? [] : selectableKeys);
  }, [selectablePages, selectedPageKeys]);

  const filteredGroups = React.useMemo(() => {
    const query = pageSearchQuery.trim().toLowerCase();
    if (!query) return groups;
    return groups
      .map((group) => ({
        ...group,
        pages: group.pages.filter(
          (page) =>
            page.pageName.toLowerCase().includes(query) ||
            Boolean(page.category?.toLowerCase().includes(query))
        ),
      }))
      .filter((group) => group.pages.length > 0);
  }, [groups, pageSearchQuery]);

  const limit = composerTextLimitForType(postType);
  const isOverLimit = text.length > limit;
  const isFirstCommentOverLimit = firstComment.length > FIRST_COMMENT_MAX_LENGTH;
  // Explicit type decides emptiness: text needs caption, every
  // other type needs media (media is cleared on type switch, so a
  // text post can never accidentally carry media).
  const isPostEmpty =
    postType === 'text' ? text.trim().length === 0 : !attached;

  const removeAttachedMedia = React.useCallback(() => {
    if (attached?.tempKey) {
      const key = attached.tempKey;
      void fetch(
        buildTenantApiPath(subdomain, '/publishing/publish-now/temp-media'),
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key }),
        }
      ).then((response) => {
        if (response.ok) tempKeysRef.current.delete(key);
      });
    }
    setAttached(null);
  }, [attached, subdomain]);

  const handlePostTypeChange = React.useCallback(
    (nextType: PublishNowPostType) => {
      if (nextType === postType) return;
      // Old behaviour: switching type clears attached media, so a
      // post can never carry media of the wrong type.
      if (attached) removeAttachedMedia();
      setPostType(nextType);
      setAttachChoiceOpen(false);
      setErrorMessage(null);
    },
    [attached, postType, removeAttachedMedia]
  );

  const attachLibraryMedia = React.useCallback(
    (media: ComposerMedia) => {
      const expectedMediaType = postType === 'image' ? 'image' : 'video';
      if (postType !== 'text' && media.mediaType !== expectedMediaType) {
        setErrorMessage(
          `This is a ${media.mediaType === 'image' ? 'photo' : 'video'}, but the post type is ${postType === 'image' ? 'Image' : postType === 'video' ? 'Video' : 'Reel'}. Switch the post type or pick matching media.`
        );
        setPickerOpen(false);
        return;
      }
      setAttached((prev) => {
        if (prev?.tempKey) {
          void fetch(
            buildTenantApiPath(subdomain, '/publishing/publish-now/temp-media'),
            {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: prev.tempKey }),
            }
          ).then((response) => {
            if (response.ok) tempKeysRef.current.delete(prev.tempKey!);
          });
        }
        return {
          name: media.name,
          mediaType: media.mediaType,
          aspectRatio: media.aspectRatio,
          thumbnailUrl: media.thumbnailUrl,
          url: media.url,
          width: media.width ?? null,
          height: media.height ?? null,
          captionText: media.captionText,
          libraryId: media.id,
          tempKey: null,
        };
      });
      // Caption prefill: library caption fills an empty composer
      // text only — typed text is never overwritten, and editing
      // here never writes back to the library caption.
      setText((prev) => {
        if (
          prev.trim().length === 0 &&
          media.captionText !== null &&
          media.captionText.trim().length > 0
        ) {
          return media.captionText;
        }
        return prev;
      });
      setAttachChoiceOpen(false);
      setPickerOpen(false);
    },
    [postType, subdomain]
  );

  const handleTempFileSelect = React.useCallback(
    async (file: File) => {
      if (!TEMP_MIME_TYPES.has(file.type)) {
        setErrorMessage('This file type is not supported. Choose an image or video.');
        return;
      }
      const expectedKind = postType === 'image' ? 'image' : 'video';
      if (!file.type.startsWith(`${expectedKind}/`)) {
        setErrorMessage(
          `This is a ${file.type.startsWith('video/') ? 'video' : 'photo'}, but the post type is ${postType === 'image' ? 'Image' : postType === 'video' ? 'Video' : 'Reel'}. Switch the post type or pick matching media.`
        );
        return;
      }
      if (file.size > TEMP_MAX_FILE_SIZE_BYTES) {
        setErrorMessage('This file is over the 500 MB limit.');
        return;
      }
      setIsUploadingTemp(true);
      setErrorMessage(null);
      try {
        const mediaType = file.type.startsWith('video/') ? 'video' : 'image';
        const upload = await api.post(
          buildTenantApiPath(subdomain, '/publishing/publish-now/temp-media'),
          { fileName: file.name, fileSize: file.size, mimeType: file.type },
          { schema: PublishNowTempMediaResponseSchema }
        );
        const putResponse = await fetch(upload.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file,
        });
        if (!putResponse.ok) {
          throw new Error('The upload failed. Please try again.');
        }
        tempKeysRef.current.add(upload.key);
        const dimensions = await mediaDimensions(file, mediaType);
        if (attached?.tempKey) {
          const oldKey = attached.tempKey;
          void fetch(
            buildTenantApiPath(subdomain, '/publishing/publish-now/temp-media'),
            {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: oldKey }),
            }
          ).then((response) => {
            if (response.ok) tempKeysRef.current.delete(oldKey);
          });
        }
        const defaultCaption = deriveDefaultCaptionFromFilename(file.name);
        setAttached({
          name: file.name,
          mediaType,
          aspectRatio: null,
          thumbnailUrl: null,
          url: upload.publicUrl,
          width: dimensions.width,
          height: dimensions.height,
          captionText: defaultCaption || null,
          libraryId: null,
          tempKey: upload.key,
        });
        setText((prev) =>
          prev.trim().length === 0 && defaultCaption ? defaultCaption : prev
        );
        setAttachChoiceOpen(false);
      } catch (error) {
        setErrorMessage(
          errorText(error, 'The upload failed. Please try again.')
        );
      } finally {
        setIsUploadingTemp(false);
      }
    },
    [attached, postType, subdomain]
  );

  const publishTargets = React.useCallback(
    async (targets: PublishNowSelectedPage[]) => {
      const mediaPayload = attached
        ? {
            source: attached.libraryId ? ('library' as const) : ('temp' as const),
            mediaId: attached.libraryId,
            tempKey: attached.tempKey,
            url: attached.url,
            mediaType: attached.mediaType,
            aspectRatio: attached.aspectRatio,
            width: attached.width,
            height: attached.height,
            name: attached.name,
          }
        : null;
      const trimmedFirstComment = firstComment.trim();
      const response = await api.post(
        buildTenantApiPath(subdomain, '/publishing/publish-now'),
        {
          caption: text,
          postType,
          ...(trimmedFirstComment.length > 0
            ? { firstComment: trimmedFirstComment }
            : {}),
          targets: targets.map((page) => ({
            accountId: page.accountId,
            fbPageId: page.fbPageId,
            pageName: page.pageName,
          })),
          media: mediaPayload,
        },
        { schema: PublishNowResponseSchema }
      );
      return response.results as PublishNowResultItem[];
    },
    [attached, firstComment, postType, subdomain, text]
  );

  const handlePublish = React.useCallback(async () => {
    if (
      selectedPages.length === 0 ||
      isPostEmpty ||
      isOverLimit ||
      isFirstCommentOverLimit ||
      isPublishing
    ) {
      return;
    }
    setIsPublishing(true);
    setErrorMessage(null);
    try {
      const nextResults = await publishTargets(selectedPages);
      setResults(nextResults);
      setHasRun(true);
    } catch (error) {
      setErrorMessage(
        errorText(error, 'Publishing failed. Please try again.')
      );
    } finally {
      setIsPublishing(false);
    }
  }, [
    selectedPages,
    isPostEmpty,
    isOverLimit,
    isFirstCommentOverLimit,
    isPublishing,
    publishTargets,
  ]);

  const handleRetryFailedOnly = React.useCallback(async () => {
    // Restricted pages are never re-attempted: the restriction is
    // account-level and retrying cannot succeed until it is lifted.
    // Successes are never touched, so a retry can never re-publish
    // a page that already succeeded — which also means a failed
    // first comment on a published post is a warning only, never
    // a retry trigger.
    const failedPages = selectedPages.filter((page) =>
      results.some(
        (result) =>
          result.status === 'failed' &&
          !isRestrictedResult(result) &&
          result.accountId === page.accountId &&
          result.fbPageId === page.fbPageId
      )
    );
    if (failedPages.length === 0 || isRetrying) return;
    setIsRetrying(true);
    setErrorMessage(null);
    try {
      const retried = await publishTargets(failedPages);
      setResults((prev) => {
        const byKey = new Map(
          retried.map((result) => [
            `${result.accountId}:${result.fbPageId}`,
            result,
          ])
        );
        return prev.map((result) => {
          const replacement = byKey.get(
            `${result.accountId}:${result.fbPageId}`
          );
          return replacement ?? result;
        });
      });
    } catch (error) {
      setErrorMessage(
        errorText(error, 'Retrying failed pages did not work. Please try again.')
      );
    } finally {
      setIsRetrying(false);
    }
  }, [selectedPages, results, isRetrying, publishTargets]);

  const handleStartOver = React.useCallback(() => {
    void deleteAllTempMedia().then((deleted) => {
      if (!deleted) {
        toast.error(
          "We couldn't remove the uploaded file. Please try again."
        );
      }
      setView('accounts');
      setSelectedAccountIds([]);
      setAccountSearchQuery('');
      setGroups([]);
      setSelectedPageKeys([]);
      setPageSearchQuery('');
      setErrorMessage(null);
      setPostType('text');
      setText('');
      setFirstComment('');
      setAttached(null);
      setAttachChoiceOpen(false);
      setPickerOpen(false);
      setPickerSession((prev) => prev + 1);
      setResults([]);
      setHasRun(false);
    });
  }, [deleteAllTempMedia]);

  const publishedCount = results.filter(
    (result) => result.status === 'published'
  ).length;
  const failedResults = results.filter((result) => result.status === 'failed');
  const restrictedResults = results.filter((result) =>
    isRestrictedResult(result)
  );
  const retryableFailedCount = failedResults.filter(
    (result) => !isRestrictedResult(result)
  ).length;

  const selectedAccountNames = React.useMemo(
    () =>
      [...new Set(selectedPages.map((page) => page.accountName))],
    [selectedPages]
  );

  const errorBanner = errorMessage ? (
    <div
      data-testid="publish-now-error"
      className="mb-4 rounded-sm border border-brand-rose/25 bg-brand-rose/10 px-3 py-2 text-body text-brand-rose"
    >
      {errorMessage}
    </div>
  ) : null;

  return (
    <div className="mx-auto w-full max-w-300 px-6 py-6 pb-32">
      {view !== 'composer' && (
        <div className="mx-auto flex w-full max-w-2xl flex-col items-center py-10">
          <div className="w-full space-y-8">
            <div className="space-y-3 text-center">
              <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-2xl bg-brand-gold/10 text-brand-gold ring-1 ring-brand-gold/20">
                <SendIcon size={32} aria-hidden />
              </div>
              <h1 className="text-4xl font-bold tracking-tight text-ink">
                Publish Now
              </h1>
              <p className="text-lg text-ink-sub">
                {view === 'accounts'
                  ? 'Choose the Facebook accounts and pages you want to publish to.'
                  : 'Choose the pages you want this post to go to.'}
              </p>
              <p className="mx-auto max-w-160 text-body leading-body text-ink-sub">
                Publish one post directly to several Facebook pages at
                once.
              </p>
            </div>

            {errorBanner}

            {view === 'accounts' && (
              <div className="rounded-2xl border border-line bg-subtle p-6">
                {showMissingAppGuidance && (
                  <div
                    data-testid="facebook-app-guidance"
                    className="mb-4 rounded-sm border border-brand-gold/25 bg-brand-gold/10 px-3 py-2.5 text-body leading-body text-ink"
                  >
                    <p className="mb-1">
                      Before you can connect an account, add your Facebook App
                      ID and App Secret in Workspace Settings, under Facebook.
                      Then come back here to connect your account.
                    </p>
                    <Link
                      href={buildSettingsFacebookHref(subdomain)}
                      className="font-semibold text-link underline"
                    >
                      Add App ID and Secret in Settings
                    </Link>
                  </div>
                )}

                <div className="mb-6 flex items-center gap-3">
                  <h2 className="text-xl font-semibold text-ink">Select accounts</h2>
                </div>

                {accountsQuery.isPending && (
                  <div className="p-6 text-center text-body text-ink-sub">
                    Loading connected Facebook accounts...
                  </div>
                )}

                {accountsQuery.isError && (
                  <div className="p-6 text-center text-body text-ink-sub">
                    Couldn&apos;t load your Facebook accounts. Please try again.
                  </div>
                )}

                {!accountsQuery.isPending &&
                  !accountsQuery.isError &&
                  activeAccounts.length === 0 &&
                  nonSelectableAccounts.length === 0 && (
                    <div className="flex flex-col items-center p-6 text-center">
                      <div className="mb-1 text-body font-semibold text-ink">
                        No Facebook accounts connected
                      </div>
                      <p className="mb-4 max-w-80 text-body leading-body text-ink-sub">
                        Connect a Facebook account before publishing direct posts.
                      </p>
                      <Button asChild>
                        <Link href={buildAccountsHref(subdomain)}>
                          Go to Facebook Accounts
                        </Link>
                      </Button>
                    </div>
                  )}

                {!accountsQuery.isPending && activeAccounts.length > 0 && (
                  <>
                    <div className="relative mb-6">
                      <SearchIcon
                        className="pointer-events-none absolute left-4 top-3.5 size-4 text-ink-dim"
                        aria-hidden
                      />
                      <Input
                        type="text"
                        value={accountSearchQuery}
                        onChange={(event) =>
                          setAccountSearchQuery(event.target.value)
                        }
                        placeholder="Search accounts..."
                        aria-label="Search accounts"
                        className="border-line bg-canvas pl-11 shadow-none"
                      />
                    </div>
                    <div className="flex max-h-75 flex-col gap-1 overflow-y-auto pr-2">
                      {filteredActiveAccounts.length === 0 && (
                        <div className="p-8 text-center text-ink-sub">
                          No accounts match your search
                        </div>
                      )}
                      {filteredActiveAccounts.map((account) => {
                        const checked = selectedAccountIds.includes(account.id);
                        return (
                          <label
                            key={account.id}
                            className={cn(
                              'flex min-h-11 w-full cursor-pointer items-center gap-4 rounded-sm px-3.5 py-3 outline-none transition-colors hover:bg-hover',
                              checked && 'bg-hover'
                            )}
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() => toggleAccount(account.id)}
                            />
                            <Avatar
                              name={account.displayName}
                              pictureUrl={account.profilePictureUrl}
                              size="lg"
                            />
                            <span className="min-w-0 truncate text-lg font-semibold text-ink">
                              {account.displayName}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}

                {!accountsQuery.isPending && nonSelectableAccounts.length > 0 && (
                  <div
                    className={cn(
                      'flex flex-col gap-1',
                      activeAccounts.length > 0 && 'mt-4'
                    )}
                  >
                    {nonSelectableAccounts.map((account) => {
                      const expired = getAccountHealth(account) === 'expired';
                      return (
                        <div
                          key={account.id}
                          className="flex items-center justify-between gap-4 rounded-sm px-3.5 py-3 opacity-55"
                        >
                          <div className="flex min-w-0 items-center gap-4">
                            <Avatar
                              name={account.displayName}
                              pictureUrl={account.profilePictureUrl}
                              size="lg"
                            />
                            <div className="min-w-0">
                              <div className="truncate text-body font-semibold text-ink">
                                {account.displayName}
                              </div>
                              <div className="mt-0.5 text-metadata text-ink-sub">
                                {expired ? 'Session expired' : 'Disconnected'}
                              </div>
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0 border-brand-rose/35 font-semibold text-brand-rose hover:bg-brand-rose/10 hover:text-brand-rose"
                            onClick={() => {
                              window.location.href = buildDirectConnectUrl({
                                id: account.id,
                                fbAccountId: account.fbAccountId,
                                displayName: account.displayName,
                                status: account.status,
                                updatedAt: account.updatedAt,
                              });
                            }}
                          >
                            Reconnect
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="mt-6 text-right">
                  <Button
                    type="button"
                    disabled={selectedAccountIds.length === 0 || isDiscovering}
                    onClick={() => void handleContinueFromAccounts()}
                  >
                    {isDiscovering
                      ? 'Finding pages...'
                      : selectedAccountIds.length === 0
                        ? 'Continue'
                        : `Continue (${selectedAccountIds.length} ${selectedAccountIds.length === 1 ? 'account' : 'accounts'})`}
                  </Button>
                </div>
              </div>
            )}

            {view === 'pages' && (
              <div className="rounded-2xl border border-line bg-subtle p-6">
                <div className="mb-6 flex items-center justify-between">
                  <h2 className="text-xl font-semibold text-ink">Select pages</h2>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleBackToAccounts}
                    className="text-ink-sub hover:text-ink"
                  >
                    <ArrowLeftIcon className="mr-1 size-4" aria-hidden /> Back
                  </Button>
                </div>

                {isDiscovering && (
                  <div className="p-6 text-center text-body text-ink-sub">
                    Finding Facebook Pages...
                  </div>
                )}
                {!isDiscovering && allPages.length === 0 && (
                  <div className="p-6 text-center text-body text-ink-sub">
                    No Facebook Pages were found on the selected accounts.
                  </div>
                )}
                {!isDiscovering && allPages.length > 0 && (
                  <>
                    <div className="relative mb-6">
                      <SearchIcon
                        className="pointer-events-none absolute left-4 top-3.5 size-4 text-ink-dim"
                        aria-hidden
                      />
                      <Input
                        type="text"
                        value={pageSearchQuery}
                        onChange={(event) =>
                          setPageSearchQuery(event.target.value)
                        }
                        placeholder="Filter pages..."
                        aria-label="Filter pages"
                        className="border-line bg-canvas pl-11 shadow-none"
                      />
                    </div>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
                      <span className="text-metadata text-ink-sub">
                        {allPages.length}{' '}
                        {allPages.length === 1 ? 'page found' : 'pages found'}
                      </span>
                      {selectablePages.length > 0 && (
                        <button
                          type="button"
                          aria-pressed={selectablePages.every((page) =>
                            selectedPageKeys.includes(
                              `${page.accountId}:${page.fbPageId}`
                            )
                          )}
                          onClick={toggleSelectAllPages}
                          className="inline-flex min-h-11 items-center px-2 text-metadata font-semibold text-link outline-none focus-visible:outline-2 focus-visible:outline-brand-gold"
                        >
                          {selectablePages.every((page) =>
                            selectedPageKeys.includes(
                              `${page.accountId}:${page.fbPageId}`
                            )
                          )
                            ? 'Deselect All'
                            : 'Select All'}
                        </button>
                      )}
                    </div>
                    <div className="max-h-100 overflow-y-auto pr-2">
                      {filteredGroups.map((group) => (
                        <div key={group.accountId} className="mb-4">
                          <div className="mb-2 px-1 text-metadata font-semibold tracking-body text-ink-sub">
                            {group.accountName}
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {group.pages.map((page) => {
                              const key = `${page.accountId}:${page.fbPageId}`;
                              const checked = selectedPageKeys.includes(key);
                              const disabled = Boolean(page.disabledReason);
                              return (
                                <label
                                  key={key}
                                  className={cn(
                                    'flex items-start gap-3 rounded-xl border border-line bg-canvas p-4 transition-colors',
                                    checked && !disabled && 'border-brand-gold/50 bg-brand-gold/10',
                                    disabled
                                      ? 'cursor-default opacity-60'
                                      : 'cursor-pointer hover:bg-hover'
                                  )}
                                >
                                  <Checkbox
                                    checked={checked}
                                    disabled={disabled}
                                    onCheckedChange={() => {
                                      if (!disabled) togglePage(key);
                                    }}
                                  />
                                  <Avatar
                                    name={page.pageName}
                                    pictureUrl={page.profilePictureUrl}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-body font-semibold text-ink">
                                      {page.pageName}
                                    </div>
                                    <div className="mt-0.5 text-metadata text-ink-sub">
                                      {page.category || 'Facebook Page'} •{' '}
                                      {page.followers.toLocaleString('en-US')}{' '}
                                      followers
                                      {formatPageIdSuffix(page.fbPageId)
                                        ? ` · Page ID ${formatPageIdSuffix(page.fbPageId)}`
                                        : ''}
                                    </div>
                                    {disabled && page.disabledReason && (
                                      <div className="mt-1 text-metadata font-medium text-ink-dim">
                                        {page.disabledReason}
                                      </div>
                                    )}
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-6 flex items-center justify-between gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleBackToAccounts}
                      >
                        Back
                      </Button>
                      <Button
                        type="button"
                        disabled={selectedPages.length === 0}
                        onClick={() => setView('composer')}
                      >
                        {selectedPages.length === 0
                          ? 'Continue'
                          : `Continue (${selectedPages.length} ${selectedPages.length === 1 ? 'page' : 'pages'})`}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {view === 'composer' && (
        <div className="flex flex-col gap-8">
          {/* Active connection header, like old's sticky header. */}
          <div className="sticky top-0 z-40 -mx-6 border-b border-line bg-canvas/80 px-6 pb-4 pt-6 shadow-sm backdrop-blur-xl sm:-mx-8 sm:px-8">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center sm:gap-0">
              <div className="flex min-w-0 items-center gap-4">
                <div className="flex shrink-0 items-center">
                  {selectedPages.slice(0, 3).map((page, index) => (
                    <div
                      key={`${page.accountId}:${page.fbPageId}`}
                      className={cn(index > 0 && '-ml-3')}
                    >
                      <Avatar
                        name={page.pageName}
                        pictureUrl={page.profilePictureUrl}
                      />
                    </div>
                  ))}
                  {selectedPages.length > 3 && (
                    <div className="-ml-3 flex size-9 shrink-0 items-center justify-center rounded-full border border-line bg-subtle text-metadata font-bold text-ink">
                      +{selectedPages.length - 3}
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-semibold leading-tight text-ink">
                      {selectedPages.map((page) => page.pageName).join(', ')}
                    </h2>
                    <span className="shrink-0 rounded-full border border-brand-gold/35 px-2 py-0.5 text-metadata font-semibold uppercase tracking-body text-brand-gold">
                      Selected
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-sm leading-tight text-ink-sub">
                    via {selectedAccountNames.join(', ')}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isPublishing || isRetrying}
                onClick={() => setView('pages')}
                className="shrink-0 rounded-full"
              >
                Change selection
              </Button>
            </div>
          </div>

          {errorBanner}

          <div className="grid items-start gap-8 lg:grid-cols-[1.5fr_1fr]">
            {/* Composer panel */}
            <section className="rounded-3xl border border-line bg-subtle p-6 sm:p-8">
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-xl font-semibold text-ink">Composer</h2>
              </div>

              <div className="space-y-6">
                <div className="space-y-3">
                  <p className="text-body font-medium text-ink">Post Type</p>
                  <div className="flex flex-wrap gap-2">
                    {POST_TYPES.map((type) => {
                      const isActive = postType === type.id;
                      return (
                        <Button
                          key={type.id}
                          type="button"
                          variant="outline"
                          disabled={isPublishing || isUploadingTemp}
                          className={cn(
                            'h-11 flex-1',
                            isActive &&
                              'border-brand-gold/50 bg-brand-gold/10 text-brand-gold hover:bg-brand-gold/20 hover:text-brand-gold'
                          )}
                          onClick={() => handlePostTypeChange(type.id)}
                        >
                          {type.label}
                        </Button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-body font-medium text-ink">Caption</p>
                    <span
                      className={cn(
                        'text-xs',
                        isOverLimit ? 'text-brand-rose' : 'text-ink-sub'
                      )}
                    >
                      {text.length.toLocaleString()} /{' '}
                      {limit.toLocaleString()}
                    </span>
                  </div>
                  <Textarea
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    rows={5}
                    disabled={isPublishing || isUploadingTemp}
                    className="resize-none rounded-xl bg-canvas"
                    placeholder="What's on your mind?"
                  />
                  {isOverLimit && (
                    <p className="text-metadata text-brand-rose">
                      Caption is over the {limit.toLocaleString()}-character
                      limit for {postType === 'reel' ? 'reels' : 'posts'}.
                    </p>
                  )}
                </div>

                {postType !== 'text' && (
                  <div className="space-y-2">
                    <p className="text-body font-medium text-ink">Media File</p>
                    {!attached ? (
                      <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isUploadingTemp || isPublishing}
                            onClick={() => setPickerOpen(true)}
                          >
                            Attach from Media Library
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isUploadingTemp || isPublishing}
                            onClick={() => tempInputRef.current?.click()}
                          >
                            Upload from device
                          </Button>
                          <input
                            ref={tempInputRef}
                            type="file"
                            accept={
                              postType === 'image'
                                ? 'image/jpeg,image/png,image/webp'
                                : 'video/mp4,video/quicktime,video/webm'
                            }
                            className="hidden"
                            aria-hidden
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              event.target.value = '';
                              if (file) void handleTempFileSelect(file);
                            }}
                          />
                        </div>
                        {isUploadingTemp && (
                          <p className="text-body text-ink-sub">
                            Uploading file...
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-4 rounded-2xl border border-line bg-canvas p-4">
                        {attached.mediaType === 'image' &&
                        (attached.thumbnailUrl || attached.url) ? (
                          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-line">
                            <Image
                              src={attached.thumbnailUrl ?? attached.url}
                              alt={attached.name}
                              fill
                              className="object-cover"
                              unoptimized
                            />
                          </div>
                        ) : (
                          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-metadata text-ink-sub">
                            Video
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-ink">
                            {attached.name}
                          </p>
                          <p className="text-xs text-ink-sub">
                            {attached.mediaType === 'image' ? 'Image' : 'Video'}
                            {attached.libraryId
                              ? ' · from Media Library'
                              : ' · from your device'}
                          </p>
                          {isUploadingTemp && (
                            <p className="mt-1 text-xs text-ink-sub">
                              Uploading...
                            </p>
                          )}
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={isPublishing || isUploadingTemp}
                          onClick={removeAttachedMedia}
                          className="shrink-0 text-ink-sub hover:text-brand-rose"
                        >
                          Remove
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-body font-medium text-ink">
                      First comment (optional)
                    </p>
                    <span
                      className={cn(
                        'text-xs',
                        isFirstCommentOverLimit
                          ? 'text-brand-rose'
                          : 'text-ink-sub'
                      )}
                    >
                      {firstComment.length.toLocaleString()} /{' '}
                      {FIRST_COMMENT_MAX_LENGTH.toLocaleString()}
                    </span>
                  </div>
                  <Input
                    value={firstComment}
                    onChange={(event) => setFirstComment(event.target.value)}
                    disabled={isPublishing || isUploadingTemp}
                    className="h-11 rounded-xl bg-canvas"
                    placeholder="Write a comment..."
                    aria-label="First comment (optional)"
                  />
                  <p className="text-metadata leading-body text-ink-sub">
                    The same comment will appear on every page this post
                    publishes to.
                  </p>
                </div>

                <Button
                  type="button"
                  className="h-12 w-full rounded-xl text-base font-semibold"
                  disabled={
                    isPostEmpty ||
                    isOverLimit ||
                    isFirstCommentOverLimit ||
                    isPublishing ||
                    isUploadingTemp
                  }
                  onClick={() => void handlePublish()}
                >
                  {isPublishing ? (
                    <>
                      <Loader2 className="mr-2 size-5 animate-spin" aria-hidden />
                      Publishing...
                    </>
                  ) : (
                    <>
                      <SendIcon className="mr-2 size-5" aria-hidden />
                      Publish Now
                    </>
                  )}
                </Button>
              </div>
            </section>

            {/* Results panel */}
            <section className="flex max-h-200 flex-col overflow-hidden rounded-3xl border border-line bg-subtle">
              <div className="border-b border-line p-5">
                <h2 className="text-lg font-semibold text-ink">
                  Publish results
                </h2>
                {hasRun && (
                  <p className="mt-1 text-metadata text-ink-sub">
                    {publishedCount} of {results.length}{' '}
                    {results.length === 1 ? 'page' : 'pages'} published
                  </p>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-3">
                {!hasRun && (
                  <div className="flex h-40 flex-col items-center justify-center text-center">
                    <SendIcon
                      className="mb-2 size-8 text-ink-dim"
                      aria-hidden
                    />
                    <p className="text-sm text-ink-sub">
                      No results yet — publish to see per-page results here.
                    </p>
                  </div>
                )}

                {hasRun && (
                  <div className="space-y-3">
                    <p className="px-1 text-metadata leading-body text-ink-sub">
                      Starting over clears this result list.
                    </p>
                    {restrictedResults.length > 0 && (
                      <div className="rounded-sm border border-brand-rose/25 bg-brand-rose/10 px-3 py-2 text-body leading-body text-ink">
                        One or more accounts are restricted by Facebook.
                        Those pages cannot be published to until the
                        restriction is lifted in Facebook Account Status.
                        {retryableFailedCount === 0 &&
                          ' Retry is disabled — retrying will not work until the restriction is lifted.'}
                      </div>
                    )}
                    {results.map((result) => {
                      const published = result.status === 'published';
                      const restricted = isRestrictedResult(result);
                      const diagnosticParts: string[] = [];
                      if (!published) {
                        if (typeof result.graphCode === 'number') {
                          diagnosticParts.push(
                            `Facebook error #${result.graphCode}`
                          );
                        }
                        if (typeof result.graphSubcode === 'number') {
                          diagnosticParts.push(
                            `subcode ${result.graphSubcode}`
                          );
                        }
                        if (
                          typeof result.step === 'string' &&
                          result.step.length > 0
                        ) {
                          diagnosticParts.push(`step: ${result.step}`);
                        }
                        if (typeof result.httpStatus === 'number') {
                          diagnosticParts.push(`HTTP ${result.httpStatus}`);
                        }
                        if (
                          typeof result.fbtraceId === 'string' &&
                          result.fbtraceId.length > 0
                        ) {
                          diagnosticParts.push(`trace: ${result.fbtraceId}`);
                        }
                      }
                      return (
                        <div
                          key={`${result.accountId}:${result.fbPageId}`}
                          className="rounded-xl border border-line bg-canvas p-4"
                        >
                          <div className="flex items-start gap-4">
                            <span
                              aria-hidden
                              className={cn(
                                'flex size-6 shrink-0 items-center justify-center rounded-full text-body font-bold text-neutral-white',
                                published
                                  ? 'bg-brand-emerald'
                                  : 'bg-brand-rose'
                              )}
                            >
                              {published ? '✓' : '×'}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-body font-semibold text-ink">
                                {result.pageName}
                              </div>
                              <div
                                className={cn(
                                  'mt-0.5',
                                  published
                                    ? 'text-metadata text-brand-emerald'
                                    : restricted
                                      ? 'text-body font-semibold text-brand-rose'
                                      : 'text-metadata text-brand-rose'
                                )}
                              >
                                {published
                                  ? 'Published'
                                  : (result.reason ?? 'Publishing failed.')}
                              </div>
                              {diagnosticParts.length > 0 && (
                                <div className="mt-0.5">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      const key = `${result.accountId}:${result.fbPageId}`;
                                      setExpandedDetails((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(key)) {
                                          next.delete(key);
                                        } else {
                                          next.add(key);
                                        }
                                        return next;
                                      });
                                    }}
                                    className="text-metadata font-semibold text-link outline-none focus-visible:outline-2 focus-visible:outline-brand-gold"
                                  >
                                    {expandedDetails.has(
                                      `${result.accountId}:${result.fbPageId}`
                                    )
                                      ? 'Hide details'
                                      : 'View details'}
                                  </button>
                                  {expandedDetails.has(
                                    `${result.accountId}:${result.fbPageId}`
                                  ) && (
                                    <div className="mt-0.5 break-all text-metadata text-ink-sub">
                                      {diagnosticParts.join(' · ')}
                                    </div>
                                  )}
                                </div>
                              )}
                              {published && result.firstCommentFailed && (
                                <div className="mt-1 text-metadata leading-body text-brand-rose">
                                  First comment could not be posted
                                  {result.firstCommentReason
                                    ? `: ${result.firstCommentReason}`
                                    : '.'}{' '}
                                  The post was published.
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {hasRun && (
                <div className="flex flex-col gap-2 border-t border-line bg-canvas p-3">
                  {failedResults.length > 0 && (
                    <Button
                      type="button"
                      disabled={isRetrying || retryableFailedCount === 0}
                      onClick={() => void handleRetryFailedOnly()}
                    >
                      {isRetrying
                        ? 'Retrying...'
                        : retryableFailedCount > 0 &&
                            restrictedResults.length > 0
                          ? 'Retry non-restricted failures'
                          : 'Retry failed only'}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isPublishing || isRetrying}
                    onClick={handleStartOver}
                  >
                    Start over
                  </Button>
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      <MediaLibraryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        subdomain={subdomain}
        pageName="Publish Now"
        mode="single"
        onSingleAttach={attachLibraryMedia}
        onMultiAttach={() => undefined}
        sessionKey={pickerSession}
      />
    </div>
  );
}
