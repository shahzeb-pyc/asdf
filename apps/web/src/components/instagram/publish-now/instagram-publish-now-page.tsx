'use client';

/**
 * Instagram Publish Now page — the Instagram equivalent of Facebook
 * Publish Now (components/pages/publish-now/publish-now-page.tsx),
 * with the differences the platform forces:
 *
 *   Selector (one step, not two) — connected Instagram accounts
 *     only, checkboxes, search, Select All / Deselect All, selected
 *     count. Expired/disconnected accounts are shown but NOT
 *     selectable, with a link to Instagram Accounts. There is no
 *     pages step and no "pages linked" count: the account IS the
 *     target. The page auto-opens this selector, like Facebook's
 *     page auto-opens its account selector.
 *   Composer — Post Type buttons Photo / Reel only. Instagram has
 *     no text-only feed post (no Text button), every video is a
 *     Reel (no separate Video button), Stories need a Business
 *     account while the target is Creator accounts (no Story
 *     button), and Carousel needs a multi-media composer Facebook
 *     Publish Now does not have (no Carousel button in v1 — see
 *     the spec). Switching type clears attached media.
 *   Media — Media Library picker in single mode, or device upload
 *     through the shared temp-media route (no media_items row,
 *     deleted on Start over / replace / remove, kept alive through
 *     the results panel so Retry can reuse it). Photo device
 *     uploads accept JPEG only (Instagram's photo rule); Reel
 *     uploads accept video. Library photos that are not JPEG are
 *     rejected server-side with the plain JPEG rule.
 *   First comment — the SAME comment is posted to EVERY selected
 *     account, but ONLY after that account's own post succeeds.
 *     A failed comment never fails the row — it shows as a
 *     warning with a "Retry comment" action that resends the run's
 *     idempotency key, and the server retries ONLY the comment
 *     against the stored media id, never re-publishing.
 *   Results panel — this run ONLY, never saved history. Per-account
 *     tick in a green circle / cross in a red circle (never status
 *     dots), failure reason + diagnostic detail behind a collapsed
 *     "View details" per failed row, the account-restriction
 *     mapping, and the retry rules (retry only non-restricted
 *     failures, never successes; disabled when all failed are
 *     restricted). A second Publish click sends only accounts not
 *     yet published in this run and merges results, never replaces
 *     them — the Facebook second-click bug, fixed here from the
 *     start.
 *
 * Nothing in this flow writes to the database except the
 * subscription-usage registry and the idempotency record itself:
 * no queue_items, destinations, publish_logs, media_items, or
 * history rows. Device uploads go to a TEMPORARY R2 prefix and
 * are deleted on Start over / replace / remove.
 */

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Loader2, SearchIcon, SendIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  deriveDefaultCaptionFromFilename,
  IDEMPOTENCY_KEY_HEADER,
  InstagramPublishNowResponseSchema,
  ListInstagramAccountsResponseSchema,
  PublishNowTempMediaResponseSchema,
  isFacebookAccountRestricted,
  type ComposerMedia,
  type InstagramAccountView,
} from '@fbuploadpro/contracts';
import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import { Button } from '@/components/shared/ui/button';
import { Checkbox } from '@/components/shared/ui/checkbox';
import { Input } from '@/components/shared/ui/input';
import { Textarea } from '@/components/shared/ui/textarea';
import { toast } from '@/components/shared/ui/toast';
import { getUserInitials } from '@/lib/user-initials';
import { MediaLibraryPicker } from '@/components/pages/dedicated/create-posts/media-library-picker';
import { cn } from '@/lib/utils';
import type {
  InstagramPublishNowAttachedMedia,
  InstagramPublishNowResultItem,
  InstagramPublishNowSelectedAccount,
} from './types';

export type InstagramPublishNowView = 'accounts' | 'composer';
export type InstagramPublishNowPostType = 'photo' | 'reel';

const POST_TYPES: Array<{ id: InstagramPublishNowPostType; label: string }> = [
  { id: 'photo', label: 'Photo' },
  { id: 'reel', label: 'Reel' },
];

/** Instagram caption cap (all types). */
const CAPTION_LIMIT = 2200;
const FIRST_COMMENT_MAX_LENGTH = 8000;
/** Instagram photos: JPEG only, at most 8 MB (server enforces the same). */
const PHOTO_MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const TEMP_MAX_FILE_SIZE_BYTES = 524288000;

const PHOTO_MIME_TYPES = new Set(['image/jpeg', 'image/jpg']);
const REEL_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

function validationDetailsMessage(cause: unknown): string | null {
  if (cause === null || typeof cause !== 'object') return null;
  const details = (cause as Record<string, unknown>).details;
  if (details === null || typeof details !== 'object') return null;
  const fieldErrors = (details as Record<string, unknown>).fieldErrors;
  if (fieldErrors === null || typeof fieldErrors !== 'object') return null;
  const entries = Object.entries(fieldErrors as Record<string, unknown>);
  const first = entries.find(([, messages]) => Array.isArray(messages) && messages.length > 0);
  if (!first) return null;
  const [path, messages] = first as [string, string[]];
  const labelMap: Record<string, string> = {
    caption: 'Caption',
    postType: 'Post type',
    firstComment: 'First comment',
    targets: 'Accounts',
    media: 'Media',
    fileName: 'File name',
    fileSize: 'File size',
    mimeType: 'File type',
    key: 'File',
  };
  const lastSegment = path.split('.').pop() ?? path;
  const label = labelMap[lastSegment] ?? labelMap[path] ?? 'This request';
  const raw = messages[0] ?? '';
  if (/required/i.test(raw) || /at least 1/i.test(raw)) return `${label} is missing.`;
  if (/too long|at most|maximum/i.test(raw)) return `${label} is too long.`;
  if (/invalid/i.test(raw)) return `${label} is not valid.`;
  return `${label} is not valid.`;
}

function errorText(error: unknown, fallback: string): string {
  if (isApiError(error)) {
    if (error.message && error.message !== 'INVALID_REQUEST') {
      return error.message;
    }
    const fromDetails = validationDetailsMessage(error.cause);
    if (fromDetails) return fromDetails;
    return fallback;
  }
  if (error instanceof Error && error.message && error.message !== 'INVALID_REQUEST') {
    return error.message;
  }
  return fallback;
}

/**
 * A failed result is a Meta active account restriction (structured
 * codes only). Such rows are never re-attempted by "Retry failed
 * only". Detection is shared with Facebook Publish Now; the wording
 * served by the route is Instagram-specific.
 */
function isRestrictedResult(result: InstagramPublishNowResultItem): boolean {
  return (
    result.status === 'failed' &&
    isFacebookAccountRestricted(
      { code: result.graphCode, subcode: result.graphSubcode },
      { messageFallback: false }
    )
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
  const initials = getUserInitials(name) || 'IG';
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

export function InstagramPublishNowPage({ subdomain }: Readonly<{ subdomain: string }>) {
  const [view, setView] = React.useState<InstagramPublishNowView>('accounts');
  const [selectedAccountIds, setSelectedAccountIds] = React.useState<string[]>([]);
  const [accountSearchQuery, setAccountSearchQuery] = React.useState('');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [postType, setPostType] = React.useState<InstagramPublishNowPostType>('photo');
  const [text, setText] = React.useState('');
  const [firstComment, setFirstComment] = React.useState('');
  const [attached, setAttached] = React.useState<InstagramPublishNowAttachedMedia | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerSession, setPickerSession] = React.useState(0);
  const [isUploadingTemp, setIsUploadingTemp] = React.useState(false);
  const [isPublishing, setIsPublishing] = React.useState(false);
  const [isRetrying, setIsRetrying] = React.useState(false);
  const [results, setResults] = React.useState<InstagramPublishNowResultItem[]>([]);
  const [hasRun, setHasRun] = React.useState(false);
  const [retryingCommentKey, setRetryingCommentKey] = React.useState<string | null>(null);
  const publishRunKeysRef = React.useRef<Map<string, string>>(new Map());
  const [expandedDetails, setExpandedDetails] = React.useState<Set<string>>(new Set());
  const tempKeysRef = React.useRef<Set<string>>(new Set());
  const tempInputRef = React.useRef<HTMLInputElement | null>(null);

  const accountsQuery = useQuery({
    queryKey: ['instagram-publish-now', 'accounts', subdomain],
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/instagram/accounts'), {
        schema: ListInstagramAccountsResponseSchema,
        query: { page: 1, limit: 50 },
        signal,
      }),
  });

  const accounts = React.useMemo<InstagramAccountView[]>(
    () => (accountsQuery.data?.accounts ?? []) as InstagramAccountView[],
    [accountsQuery.data]
  );
  const activeAccounts = React.useMemo(
    () => accounts.filter((acc) => acc.status === 'active'),
    [accounts]
  );
  const nonSelectableAccounts = React.useMemo(
    () => accounts.filter((acc) => acc.status === 'expired' || acc.status === 'disconnected'),
    [accounts]
  );
  const filteredActiveAccounts = React.useMemo(() => {
    const query = accountSearchQuery.trim().toLowerCase();
    if (!query) return activeAccounts;
    return activeAccounts.filter((acc) =>
      acc.displayName.toLowerCase().includes(query)
    );
  }, [activeAccounts, accountSearchQuery]);

  const selectedAccounts = React.useMemo<InstagramPublishNowSelectedAccount[]>(
    () =>
      activeAccounts
        .filter((acc) => selectedAccountIds.includes(acc.id))
        .map((acc) => ({
          accountId: acc.id,
          accountName: acc.displayName,
          profilePictureUrl: acc.profilePictureUrl ?? null,
        })),
    [activeAccounts, selectedAccountIds]
  );

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

  const toggleSelectAllAccounts = React.useCallback(() => {
    const allSelected =
      activeAccounts.length > 0 &&
      activeAccounts.every((account) => selectedAccountIds.includes(account.id));
    setSelectedAccountIds(
      allSelected ? [] : activeAccounts.map((account) => account.id)
    );
  }, [activeAccounts, selectedAccountIds]);

  const limit = CAPTION_LIMIT;
  const isOverLimit = text.length > limit;
  const isFirstCommentOverLimit = firstComment.length > FIRST_COMMENT_MAX_LENGTH;
  // Every Instagram post needs media (there is no text-only post).
  const isPostEmpty = !attached;

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
    (nextType: InstagramPublishNowPostType) => {
      if (nextType === postType) return;
      if (attached) removeAttachedMedia();
      setPostType(nextType);
      setErrorMessage(null);
    },
    [attached, postType, removeAttachedMedia]
  );

  const attachLibraryMedia = React.useCallback(
    (media: ComposerMedia) => {
      const expectedMediaType = postType === 'photo' ? 'image' : 'video';
      if (media.mediaType !== expectedMediaType) {
        setErrorMessage(
          `This is a ${media.mediaType === 'image' ? 'photo' : 'video'}, but the post type is ${postType === 'photo' ? 'Photo' : 'Reel'}. Switch the post type or pick matching media.`
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
      setPickerOpen(false);
    },
    [postType, subdomain]
  );

  const handleTempFileSelect = React.useCallback(
    async (file: File) => {
      const isPhoto = postType === 'photo';
      const allowed = isPhoto ? PHOTO_MIME_TYPES : REEL_MIME_TYPES;
      if (!allowed.has(file.type)) {
        setErrorMessage(
          isPhoto
            ? 'Instagram photos must be JPEG files. Choose a JPEG photo and try again.'
            : 'This file type is not supported. Choose a video.'
        );
        return;
      }
      if (isPhoto && file.size > PHOTO_MAX_FILE_SIZE_BYTES) {
        setErrorMessage('Instagram photos can be at most 8 MB. Choose a smaller photo and try again.');
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
        const mimeType = file.type === 'image/jpg' ? 'image/jpeg' : file.type;
        const upload = await api.post(
          buildTenantApiPath(subdomain, '/publishing/publish-now/temp-media'),
          { fileName: file.name, fileSize: file.size, mimeType },
          { schema: PublishNowTempMediaResponseSchema }
        );
        const putResponse = await fetch(upload.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': mimeType },
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
      } catch (error) {
        setErrorMessage(errorText(error, 'The upload failed. Please try again.'));
      } finally {
        setIsUploadingTemp(false);
      }
    },
    [attached, postType, subdomain]
  );

  const publishTargets = React.useCallback(
    async (targets: InstagramPublishNowSelectedAccount[], idempotencyKey: string) => {
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
        buildTenantApiPath(subdomain, '/instagram/publish-now'),
        {
          caption: text,
          postType,
          ...(trimmedFirstComment.length > 0
            ? { firstComment: trimmedFirstComment }
            : {}),
          targets: targets.map((account) => ({
            accountId: account.accountId,
            accountName: account.accountName,
          })),
          media: mediaPayload,
        },
        {
          schema: InstagramPublishNowResponseSchema,
          headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
        }
      );
      const publishedResults = response.results as InstagramPublishNowResultItem[];
      for (const result of publishedResults) {
        if (result.status === 'published') {
          publishRunKeysRef.current.set(result.accountId, idempotencyKey);
        }
      }
      return publishedResults;
    },
    [attached, firstComment, postType, subdomain, text]
  );

  const alreadyPublishedSelectedAccounts = React.useMemo(
    () =>
      selectedAccounts.filter((account) =>
        results.some(
          (result) =>
            result.status === 'published' && result.accountId === account.accountId
        )
      ),
    [selectedAccounts, results]
  );
  const unpublishedSelectedAccounts = React.useMemo(
    () =>
      selectedAccounts.filter(
        (account) => !alreadyPublishedSelectedAccounts.includes(account)
      ),
    [selectedAccounts, alreadyPublishedSelectedAccounts]
  );
  const allSelectedAlreadyPublished =
    hasRun &&
    selectedAccounts.length > 0 &&
    unpublishedSelectedAccounts.length === 0;

  const handlePublish = React.useCallback(async () => {
    if (
      selectedAccounts.length === 0 ||
      unpublishedSelectedAccounts.length === 0 ||
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
      const nextResults = await publishTargets(
        unpublishedSelectedAccounts,
        crypto.randomUUID()
      );
      setResults((prev) => {
        const byKey = new Map(
          nextResults.map((result) => [result.accountId, result])
        );
        const merged = prev.map((result) => byKey.get(result.accountId) ?? result);
        for (const result of nextResults) {
          if (!prev.some((p) => p.accountId === result.accountId)) {
            merged.push(result);
          }
        }
        return merged;
      });
      setHasRun(true);
    } catch (error) {
      setErrorMessage(errorText(error, 'Publishing failed. Please try again.'));
    } finally {
      setIsPublishing(false);
    }
  }, [
    selectedAccounts,
    unpublishedSelectedAccounts,
    isPostEmpty,
    isOverLimit,
    isFirstCommentOverLimit,
    isPublishing,
    publishTargets,
  ]);

  const handleRetryFailedOnly = React.useCallback(async () => {
    const failedAccounts = selectedAccounts.filter((account) =>
      results.some(
        (result) =>
          result.status === 'failed' &&
          !isRestrictedResult(result) &&
          result.accountId === account.accountId
      )
    );
    if (failedAccounts.length === 0 || isRetrying) return;
    setIsRetrying(true);
    setErrorMessage(null);
    try {
      const retried = await publishTargets(failedAccounts, crypto.randomUUID());
      setResults((prev) => {
        const byKey = new Map(retried.map((result) => [result.accountId, result]));
        return prev.map((result) => byKey.get(result.accountId) ?? result);
      });
    } catch (error) {
      setErrorMessage(
        errorText(error, 'Retrying failed accounts did not work. Please try again.')
      );
    } finally {
      setIsRetrying(false);
    }
  }, [selectedAccounts, results, isRetrying, publishTargets]);

  const handleRetryComment = React.useCallback(
    async (result: InstagramPublishNowResultItem) => {
      const runKey = publishRunKeysRef.current.get(result.accountId);
      if (!runKey || retryingCommentKey !== null) return;
      const account = selectedAccounts.find(
        (candidate) => candidate.accountId === result.accountId
      );
      if (!account) return;
      setRetryingCommentKey(result.accountId);
      setErrorMessage(null);
      try {
        const retried = await publishTargets([account], runKey);
        setResults((prev) => {
          const byKey = new Map(retried.map((item) => [item.accountId, item]));
          return prev.map((item) => byKey.get(item.accountId) ?? item);
        });
      } catch (error) {
        setErrorMessage(
          errorText(error, 'Retrying the first comment did not work. Please try again.')
        );
      } finally {
        setRetryingCommentKey(null);
      }
    },
    [publishTargets, retryingCommentKey, selectedAccounts]
  );

  const handleStartOver = React.useCallback(() => {
    void deleteAllTempMedia().then((deleted) => {
      if (!deleted) {
        toast.error("We couldn't remove the uploaded file. Please try again.");
      }
      setView('accounts');
      setSelectedAccountIds([]);
      setAccountSearchQuery('');
      setErrorMessage(null);
      setPostType('photo');
      setText('');
      setFirstComment('');
      setAttached(null);
      setPickerOpen(false);
      setPickerSession((prev) => prev + 1);
      setResults([]);
      setHasRun(false);
      publishRunKeysRef.current.clear();
    });
  }, [deleteAllTempMedia]);

  const publishedCount = results.filter((result) => result.status === 'published').length;
  const failedResults = results.filter((result) => result.status === 'failed');
  const restrictedResults = results.filter((result) => isRestrictedResult(result));
  const retryableFailedCount = failedResults.filter(
    (result) => !isRestrictedResult(result)
  ).length;

  const errorBanner = errorMessage ? (
    <div
      data-testid="instagram-publish-now-error"
      className="mb-4 rounded-sm border border-signal-critical/25 bg-signal-critical/10 px-3 py-2 text-body text-signal-critical-on-tint"
    >
      {errorMessage}
    </div>
  ) : null;

  return (
    <div className="mx-auto w-full max-w-300 px-4 py-6 pb-32 sm:px-6">
      {view !== 'composer' && (
        <div className="mx-auto flex w-full max-w-2xl flex-col items-center py-6 sm:py-10">
          <div className="w-full space-y-8">
            <div className="space-y-3 text-center">
              <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-2xl bg-link/10 text-link ring-1 ring-link/20">
                <SendIcon size={32} aria-hidden />
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
                Publish Now
              </h1>
              <p className="text-base text-ink-sub sm:text-lg">
                Choose the Instagram accounts you want to publish to.
              </p>
              <p className="mx-auto max-w-160 text-body leading-body text-ink-sub">
                Publish one post directly to several Instagram accounts at
                once.
              </p>
            </div>

            {errorBanner}

            <div className="rounded-2xl border border-line bg-subtle p-4 sm:p-6">
              <div className="mb-6 flex items-center gap-3">
                <h2 className="text-xl font-semibold text-ink">Select accounts</h2>
              </div>

              {accountsQuery.isPending && (
                <div className="p-6 text-center text-body text-ink-sub">
                  Loading connected Instagram accounts...
                </div>
              )}

              {accountsQuery.isError && (
                <div className="p-6 text-center text-body text-ink-sub">
                  Couldn&apos;t load your Instagram accounts. Please try again.
                </div>
              )}

              {!accountsQuery.isPending &&
                !accountsQuery.isError &&
                activeAccounts.length === 0 &&
                nonSelectableAccounts.length === 0 && (
                  <div className="flex flex-col items-center p-6 text-center">
                    <div className="mb-1 text-body font-semibold text-ink">
                      No Instagram accounts connected
                    </div>
                    <p className="mb-4 max-w-80 text-body leading-body text-ink-sub">
                      Connect an Instagram account before publishing direct posts.
                    </p>
                    <Button asChild>
                      <Link href={`/tenant/${subdomain}/instagram/accounts`}>
                        Go to Instagram Accounts
                      </Link>
                    </Button>
                  </div>
                )}

              {!accountsQuery.isPending && activeAccounts.length > 0 && (
                <>
                  <div className="relative mb-4">
                    <SearchIcon
                      className="pointer-events-none absolute left-4 top-3.5 size-4 text-ink-dim"
                      aria-hidden
                    />
                    <Input
                      type="text"
                      value={accountSearchQuery}
                      onChange={(event) => setAccountSearchQuery(event.target.value)}
                      placeholder="Search accounts..."
                      aria-label="Search accounts"
                      className="border-line bg-canvas pl-11 shadow-none"
                    />
                  </div>
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <span className="text-metadata text-ink-sub">
                      {accounts.length}{' '}
                      {accounts.length === 1 ? 'account' : 'accounts'} ·{' '}
                      {selectedAccountIds.length} of{' '}
                      {activeAccounts.length} accounts selected
                    </span>
                    <button
                      type="button"
                      aria-pressed={activeAccounts.every((account) =>
                        selectedAccountIds.includes(account.id)
                      )}
                      onClick={toggleSelectAllAccounts}
                      className="inline-flex min-h-11 items-center px-2 text-metadata font-semibold text-link outline-none focus-visible:outline-2 focus-visible:outline-link"
                    >
                      {activeAccounts.every((account) =>
                        selectedAccountIds.includes(account.id)
                      )
                        ? 'Deselect All'
                        : 'Select All'}
                    </button>
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
                            'flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-sm px-3.5 py-3 outline-none transition-colors hover:bg-hover sm:gap-4',
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
                    const expired = account.status === 'expired';
                    return (
                      <div
                        key={account.id}
                        className="flex items-center justify-between gap-3 rounded-sm px-3.5 py-3 opacity-55 sm:gap-4"
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
                        <Button type="button" variant="outline" size="sm" asChild className="shrink-0">
                          <Link href={`/tenant/${subdomain}/instagram/accounts`}>
                            Reconnect
                          </Link>
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="mt-6 sm:text-right">
                <Button
                  type="button"
                  disabled={selectedAccountIds.length === 0}
                  onClick={() => setView('composer')}
                  className="w-full sm:w-auto"
                >
                  {selectedAccountIds.length === 0
                    ? 'Continue'
                    : `Continue (${selectedAccountIds.length} ${selectedAccountIds.length === 1 ? 'account' : 'accounts'})`}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {view === 'composer' && (
        <div className="flex flex-col gap-8">
          <div className="sticky top-0 z-40 -mx-4 border-b border-line bg-canvas/80 px-4 pb-3 pt-4 shadow-sm backdrop-blur-xl sm:-mx-6 sm:px-6 sm:pb-4 sm:pt-6">
            <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center sm:gap-0">
              <div className="flex min-w-0 items-center gap-4">
                <div className="flex shrink-0 items-center">
                  {selectedAccounts.slice(0, 3).map((account, index) => (
                    <div
                      key={account.accountId}
                      className={cn(index > 0 && '-ml-3')}
                    >
                      <Avatar
                        name={account.accountName}
                        pictureUrl={account.profilePictureUrl}
                      />
                    </div>
                  ))}
                  {selectedAccounts.length > 3 && (
                    <div className="-ml-3 flex size-9 shrink-0 items-center justify-center rounded-full border border-line bg-subtle text-metadata font-bold text-ink">
                      +{selectedAccounts.length - 3}
                    </div>
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-semibold leading-tight text-ink">
                      {selectedAccounts[0]?.accountName}
                      {selectedAccounts.length > 1 &&
                        ` + ${selectedAccounts.length - 1} more`}
                    </h2>
                    <span className="shrink-0 rounded-full border border-link/35 px-2 py-0.5 text-metadata font-semibold uppercase tracking-body text-link">
                      Selected
                    </span>
                  </div>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isPublishing || isRetrying}
                onClick={() => setView('accounts')}
                className="w-full shrink-0 rounded-full sm:w-auto"
              >
                Change selection
              </Button>
            </div>
          </div>

          {errorBanner}

          <div className="grid items-start gap-6 sm:gap-8 lg:grid-cols-3">
            <section className="rounded-3xl border border-line bg-subtle p-4 sm:p-8 lg:col-span-2">
              <div className="mb-6 flex items-center justify-between">
                <h2 className="text-xl font-semibold text-ink">Composer</h2>
              </div>

              <div className="space-y-6">
                <div className="space-y-3">
                  <p className="text-body font-medium text-ink">Post Type</p>
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                    {POST_TYPES.map((type) => {
                      const isActive = postType === type.id;
                      return (
                        <Button
                          key={type.id}
                          type="button"
                          variant="outline"
                          disabled={isPublishing || isUploadingTemp}
                          className={cn(
                            'h-11 min-w-0 flex-1',
                            isActive &&
                              'border-link/50 bg-link/10 text-link hover:bg-link/10 hover:text-link'
                          )}
                          onClick={() => handlePostTypeChange(type.id)}
                        >
                          {type.label}
                        </Button>
                      );
                    })}
                  </div>
                  <p className="text-metadata leading-body text-ink-sub">
                    {postType === 'photo'
                      ? 'Instagram photos must be JPEG files, at most 8 MB, between 4:5 and 1.91:1 in shape.'
                      : 'Every Instagram video is published as a Reel and shared to feed.'}
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-body font-medium text-ink">Caption</p>
                    <span
                      className={cn(
                        'text-xs',
                        isOverLimit ? 'text-signal-critical' : 'text-ink-sub'
                      )}
                    >
                      {text.length.toLocaleString()} / {limit.toLocaleString()}
                    </span>
                  </div>
                  <Textarea
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    rows={5}
                    disabled={isPublishing || isUploadingTemp}
                    className="resize-none rounded-xl bg-canvas"
                    placeholder="Write a caption..."
                  />
                  {isOverLimit && (
                    <p className="text-metadata text-signal-critical">
                      Caption is over the {limit.toLocaleString()}-character
                      limit for Instagram.
                    </p>
                  )}
                </div>

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
                          aria-label="Upload file from device"
                          accept={
                            postType === 'photo'
                              ? 'image/jpeg'
                              : 'video/mp4,video/quicktime,video/webm'
                          }
                          className="hidden"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (file) void handleTempFileSelect(file);
                          }}
                        />
                      </div>
                      {isUploadingTemp && (
                        <p className="text-body text-ink-sub">Uploading file...</p>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 rounded-2xl border border-line bg-canvas p-3 sm:gap-4 sm:p-4">
                      {attached.mediaType === 'image' &&
                      (attached.thumbnailUrl || attached.url) ? (
                        <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-line sm:h-16 sm:w-16">
                          <Image
                            src={attached.thumbnailUrl ?? attached.url}
                            alt={attached.name}
                            fill
                            className="object-cover"
                            unoptimized
                          />
                        </div>
                      ) : (
                        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-line bg-subtle text-metadata text-ink-sub sm:h-16 sm:w-16">
                          Video
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink">
                          {attached.name}
                        </p>
                        <p className="text-xs text-ink-sub">
                          {attached.mediaType === 'image' ? 'Photo' : 'Reel'}
                          {attached.libraryId
                            ? ' · from Media Library'
                            : ' · from your device'}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isPublishing || isUploadingTemp}
                        onClick={removeAttachedMedia}
                        className="shrink-0 text-ink-sub hover:text-signal-critical-on-tint"
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-body font-medium text-ink">
                      First comment (optional)
                    </p>
                    <span
                      className={cn(
                        'text-xs',
                        isFirstCommentOverLimit
                          ? 'text-signal-critical'
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
                    The same comment will appear on every account this post
                    publishes to.
                  </p>
                </div>

                {alreadyPublishedSelectedAccounts.length > 0 && (
                  <p
                    data-testid="instagram-publish-now-already-published-note"
                    className="text-metadata leading-body text-ink-sub"
                  >
                    {alreadyPublishedSelectedAccounts.length === 1
                      ? 'Account already published in this run will not be published again.'
                      : 'Accounts already published in this run will not be published again.'}
                  </p>
                )}
                <Button
                  type="button"
                  className="h-12 w-full rounded-xl text-base font-semibold"
                  disabled={
                    isPostEmpty ||
                    isOverLimit ||
                    isFirstCommentOverLimit ||
                    isPublishing ||
                    isUploadingTemp ||
                    allSelectedAlreadyPublished
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

            <section className="flex max-h-200 flex-col overflow-hidden rounded-3xl border border-line bg-subtle lg:col-span-1">
              <div className="border-b border-line p-4 sm:p-5">
                <h2 className="text-lg font-semibold text-ink">
                  Publish results
                </h2>
                {hasRun && (
                  <p className="mt-1 text-metadata text-ink-sub">
                    {publishedCount} of {results.length}{' '}
                    {results.length === 1 ? 'account' : 'accounts'} published
                  </p>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-3">
                {!hasRun && (
                  <div className="flex h-40 flex-col items-center justify-center text-center">
                    <SendIcon className="mb-2 size-8 text-ink-dim" aria-hidden />
                    <p className="text-sm text-ink-sub">
                      No results yet — publish to see per-account results here.
                    </p>
                  </div>
                )}

                {hasRun && (
                  <div className="space-y-3">
                    <p className="px-1 text-metadata leading-body text-ink-sub">
                      Starting over clears this result list.
                    </p>
                    {restrictedResults.length > 0 && (
                      <div className="rounded-sm border border-signal-critical/25 bg-signal-critical/10 px-3 py-2 text-body leading-body text-ink">
                        One or more accounts are restricted by Instagram.
                        Those accounts cannot be published to until the
                        restriction is lifted in Instagram Account Status.
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
                            `Instagram error #${result.graphCode}`
                          );
                        }
                        if (typeof result.graphSubcode === 'number') {
                          diagnosticParts.push(
                            `subcode ${result.graphSubcode}`
                          );
                        }
                        if (typeof result.step === 'string' && result.step.length > 0) {
                          diagnosticParts.push(`step: ${result.step}`);
                        }
                        if (typeof result.httpStatus === 'number') {
                          diagnosticParts.push(`HTTP ${result.httpStatus}`);
                        }
                        if (typeof result.fbtraceId === 'string' && result.fbtraceId.length > 0) {
                          diagnosticParts.push(`trace: ${result.fbtraceId}`);
                        }
                      }
                      return (
                        <div
                          key={result.accountId}
                          className="rounded-xl border border-line bg-canvas p-3 sm:p-4"
                        >
                          <div className="flex items-start gap-3 sm:gap-4">
                            <span
                              aria-hidden
                              className={cn(
                                'flex size-6 shrink-0 items-center justify-center rounded-full text-body font-bold text-neutral-white',
                                published ? 'bg-brand-emerald' : 'bg-brand-rose'
                              )}
                            >
                              {published ? '✓' : '×'}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-body font-semibold text-ink">
                                {result.accountName}
                              </div>
                              <div
                                className={cn(
                                  'mt-0.5',
                                  published
                                    ? 'text-metadata text-brand-emerald'
                                    : restricted
                                      ? 'text-body font-semibold text-signal-critical'
                                      : 'text-metadata text-signal-critical'
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
                                      const key = result.accountId;
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
                                    className="text-metadata font-semibold text-link outline-none focus-visible:outline-2 focus-visible:outline-link"
                                  >
                                    {expandedDetails.has(result.accountId)
                                      ? 'Hide details'
                                      : 'View details'}
                                  </button>
                                  {expandedDetails.has(result.accountId) && (
                                    <div className="mt-0.5 break-all text-metadata text-ink-sub">
                                      {diagnosticParts.join(' · ')}
                                    </div>
                                  )}
                                </div>
                              )}
                              {published && result.firstCommentFailed && (
                                <div className="mt-1 text-metadata leading-body text-signal-critical">
                                  First comment could not be posted
                                  {result.firstCommentReason
                                    ? `: ${result.firstCommentReason}`
                                    : '.'}{' '}
                                  The post was published.{' '}
                                  <button
                                    type="button"
                                    disabled={retryingCommentKey !== null}
                                    onClick={() => void handleRetryComment(result)}
                                    className="font-semibold text-link outline-none focus-visible:outline-2 focus-visible:outline-brand-gold disabled:opacity-50"
                                  >
                                    {retryingCommentKey === result.accountId
                                      ? 'Retrying comment…'
                                      : 'Retry comment'}
                                  </button>
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
                        : retryableFailedCount > 0 && restrictedResults.length > 0
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
