'use client';

/**
 * Threads Publish Now page — Facebook Publish Now's full page,
 * for Threads. Differences, all deliberate:
 *
 * - Wizard has ONE step, Select Accounts: Threads accounts ARE
 *   the destinations (Threads has no pages), so there is no
 *   pages step and no page discovery. Expired/disconnected
 *   accounts are shown but NOT selectable, with Reconnect to
 *   Threads Accounts.
 * - Post types are Threads-only: Text / Image / Video. There
 *   is no Reel type on Threads, and carousel is out of scope
 *   for this single-media composer.
 * - Caption is counted the Threads way: at most 500
 *   UTF-8-weighted characters (emoji count for more than one)
 *   and at most 5 links — not Facebook's 63,206 limit.
 * - "First comment" is a Threads reply: after an account's
 *   post succeeds, the same reply text is posted as a reply
 *   to that post. A failed reply never fails the row — it is
 *   a warning with a "Retry reply" action that resends the
 *   run's idempotency key, so the server retries only the
 *   reply, never re-publishing the post.
 * - Results are this run ONLY, never saved history. Per
 *   account: tick in a green circle / cross in a red circle
 *   (never status dots), failure reason, diagnostics behind
 *   a collapsed "View details" per failed row. Duplicate
 *   account names are shown with their @handle.
 * - Device uploads go to a TEMPORARY upload (the existing
 *   Publish Now temp-media upload) and are deleted on Start
 *   over / replace / remove (kept alive through the results
 *   panel so Retry can reuse them). They never appear in
 *   the Media Library. Known carry-over from Facebook: the
 *   library picker's own device tab still goes through the
 *   normal library import — use "Upload from device" here
 *   for a temporary upload.
 * - A second Publish click in the same run publishes only
 *   accounts not yet published in that run; results merge,
 *   never replace. "Retry failed only" never re-publishes a
 *   success.
 */

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Loader2, SearchIcon, SendIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  countThreadsLinks,
  deriveDefaultCaptionFromFilename,
  IDEMPOTENCY_KEY_HEADER,
  PublishNowTempMediaResponseSchema,
  threadsWeightedTextLength,
  THREADS_MAX_TEXT_WEIGHTED_CHARACTERS,
  THREADS_MAX_LINKS,
  ThreadsPublishNowResponseSchema,
  type ComposerMedia,
} from '@fbuploadpro/contracts';
import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import { ListThreadsAccountsResponseSchema } from '@fbuploadpro/contracts';
import { Button } from '@/components/shared/ui/button';
import { Checkbox } from '@/components/shared/ui/checkbox';
import { Input } from '@/components/shared/ui/input';
import { Textarea } from '@/components/shared/ui/textarea';
import { toast } from '@/components/shared/ui/toast';
import { cn } from '@/lib/utils';
import { getAccountHealth } from '@/components/accounts/account-health';
import { getUserInitials } from '@/lib/user-initials';
import { MediaLibraryPicker } from '@/components/pages/dedicated/create-posts/media-library-picker';
import type {
  ThreadsPublishNowAttachedMedia,
  ThreadsPublishNowResultItem,
  ThreadsPublishNowSelectedAccount,
} from './types';
import {
  failedThreadsAccounts,
  mergeThreadsPublishNowResults,
  unpublishedThreadsAccounts,
} from './results';

export type ThreadsPublishNowView = 'accounts' | 'composer';
export type ThreadsPublishNowPostType = 'text' | 'image' | 'video';

const POST_TYPES: Array<{ id: ThreadsPublishNowPostType; label: string }> = [
  { id: 'text', label: 'Text' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
];

const TEMP_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'image/jpeg',
  'image/jpg',
  'image/png',
]);
const TEMP_MAX_FILE_SIZE_BYTES = 524288000;
const THREADS_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const THREADS_VIDEO_MAX_DURATION_SECONDS = 5 * 60;
const REPLY_MAX_LENGTH = 8000;

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
    caption: 'Text',
    postType: 'Post type',
    reply: 'Reply',
    targets: 'Accounts',
    media: 'Media',
    fileName: 'File name',
    fileSize: 'File size',
    mimeType: 'File type',
    key: 'File',
  };
  const lastSegment = path.split('.').pop() ?? path;
  const label = labelMap[lastSegment] ?? 'This request';
  const raw = messages[0] ?? '';
  if (/required/i.test(raw) || /at least 1/i.test(raw)) return `${label} is missing.`;
  if (/too long|at most|maximum/i.test(raw)) return `${label} is too long.`;
  if (/invalid/i.test(raw)) return `${label} is not valid.`;
  return `${label} is not valid.`;
}

function errorText(error: unknown, fallback: string): string {
  if (isApiError(error)) {
    if (error.message && error.message !== 'INVALID_REQUEST') return error.message;
    const fromDetails = validationDetailsMessage(error.cause);
    if (fromDetails) return fromDetails;
    return fallback;
  }
  if (error instanceof Error && error.message && error.message !== 'INVALID_REQUEST') {
    return error.message;
  }
  return fallback;
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
  const initials = getUserInitials(name) || 'TH';
  const sizeClass = size === 'lg' ? 'size-12' : 'size-9';
  if (showImg) {
    return (
      <Image
        src={pictureUrl!}
        alt={name}
        width={size === 'lg' ? 48 : 36}
        height={size === 'lg' ? 48 : 36}
        onError={() => setFailedUrl(pictureUrl ?? '__error__')}
        className={cn(sizeClass, 'shrink-0 rounded-full border border-line object-cover')}
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

async function mediaInfo(
  file: File,
  mediaType: 'image' | 'video'
): Promise<{ width: number | null; height: number | null; durationSeconds: number | null }> {
  const url = URL.createObjectURL(file);
  try {
    if (mediaType === 'image') {
      return await new Promise((resolve) => {
        const img = new window.Image();
        img.onload = () =>
          resolve({ width: img.naturalWidth || null, height: img.naturalHeight || null, durationSeconds: null });
        img.onerror = () => resolve({ width: null, height: null, durationSeconds: null });
        img.src = url;
      });
    }
    return await new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () =>
        resolve({
          width: video.videoWidth || null,
          height: video.videoHeight || null,
          durationSeconds: Number.isFinite(video.duration) ? video.duration : null,
        });
      video.onerror = () => resolve({ width: null, height: null, durationSeconds: null });
      video.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function ThreadsPublishNowPage({ subdomain }: Readonly<{ subdomain: string }>) {
  const [view, setView] = React.useState<ThreadsPublishNowView>('accounts');
  const [selectedAccountIds, setSelectedAccountIds] = React.useState<string[]>([]);
  const [accountSearchQuery, setAccountSearchQuery] = React.useState('');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [postType, setPostType] = React.useState<ThreadsPublishNowPostType>('text');
  const [text, setText] = React.useState('');
  const [reply, setReply] = React.useState('');
  const [attached, setAttached] = React.useState<ThreadsPublishNowAttachedMedia | null>(null);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerSession, setPickerSession] = React.useState(0);
  const [isUploadingTemp, setIsUploadingTemp] = React.useState(false);
  const [isPublishing, setIsPublishing] = React.useState(false);
  const [isRetrying, setIsRetrying] = React.useState(false);
  const [results, setResults] = React.useState<ThreadsPublishNowResultItem[]>([]);
  const [hasRun, setHasRun] = React.useState(false);
  const [retryingReplyKey, setRetryingReplyKey] = React.useState<string | null>(null);
  const publishRunKeysRef = React.useRef<Map<string, string>>(new Map());
  const [expandedDetails, setExpandedDetails] = React.useState<Set<string>>(new Set());
  const tempKeysRef = React.useRef<Set<string>>(new Set());
  const tempInputRef = React.useRef<HTMLInputElement | null>(null);

  const accountsQuery = useQuery({
    queryKey: ['threads-publish-now', 'accounts', subdomain],
    queryFn: async ({ signal }) => {
      // The accounts list is paginated: walk every page so the
      // selector sees every connected account, not just the
      // first page slice.
      const all: Array<Record<string, unknown>> = [];
      let page = 1;
      let total = Number.POSITIVE_INFINITY;
      while (all.length < total) {
        const pageData = await api.get(buildTenantApiPath(subdomain, '/threads/accounts'), {
          schema: ListThreadsAccountsResponseSchema,
          query: { page, limit: 100 },
          signal,
        });
        all.push(...(pageData.accounts as unknown as Array<Record<string, unknown>>));
        total = pageData.total;
        if (pageData.accounts.length === 0) break;
        page += 1;
      }
      return { accounts: all, total };
    },
  });
  const accountsRaw = (accountsQuery.data?.accounts ?? []) as Array<{
    id: string;
    threadsAccountId: string;
    displayName: string;
    profilePictureUrl?: string | null | undefined;
    handle?: string | null | undefined;
    status: string;
    tokenExpiresAt?: string | Date | null | undefined;
  }>;
  const accounts: ThreadsPublishNowSelectedAccount[] = React.useMemo(
    () =>
      accountsRaw.map((acc) => ({
        accountId: acc.id,
        threadsUserId: acc.threadsAccountId,
        accountName: acc.displayName,
        handle: acc.handle ?? null,
        profilePictureUrl: acc.profilePictureUrl ?? null,
      })),
    [accountsRaw]
  );
  const activeAccounts = React.useMemo(
    () => accountsRaw.filter((acc) => getAccountHealth(acc) === 'connected'),
    [accountsRaw]
  );
  const nonSelectableAccounts = React.useMemo(
    () =>
      accountsRaw.filter((acc) => {
        const health = getAccountHealth(acc);
        return health === 'expired' || health === 'error';
      }),
    [accountsRaw]
  );
  const activeById = React.useMemo(
    () => new Map(accounts.map((acc) => [acc.accountId, acc])),
    [accounts]
  );
  const selectedAccounts = React.useMemo(
    () =>
      selectedAccountIds
        .map((id) => activeById.get(id))
        .filter((acc): acc is ThreadsPublishNowSelectedAccount => Boolean(acc)),
    [selectedAccountIds, activeById]
  );
  const filteredActiveAccounts = React.useMemo(() => {
    const query = accountSearchQuery.trim().toLowerCase();
    if (!query) return activeAccounts;
    return activeAccounts.filter(
      (acc) =>
        acc.displayName.toLowerCase().includes(query) ||
        (acc.handle ?? '').toLowerCase().includes(query)
    );
  }, [activeAccounts, accountSearchQuery]);

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
          if (response.ok) tempKeysRef.current.delete(key);
          else allDeleted = false;
        } catch {
          allDeleted = false;
        }
      })
    );
    return allDeleted;
  }, [subdomain]);

  const toggleAccount = React.useCallback((accountId: string) => {
    setSelectedAccountIds((prev) =>
      prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId]
    );
  }, []);

  const toggleSelectAllAccounts = React.useCallback(() => {
    const allSelected =
      activeAccounts.length > 0 &&
      activeAccounts.every((account) => selectedAccountIds.includes(account.id));
    setSelectedAccountIds(allSelected ? [] : activeAccounts.map((account) => account.id));
  }, [activeAccounts, selectedAccountIds]);

  const weightedLength = threadsWeightedTextLength(text);
  const linkCount = countThreadsLinks(text);
  const isOverLimit = weightedLength > THREADS_MAX_TEXT_WEIGHTED_CHARACTERS || linkCount > THREADS_MAX_LINKS;
  const isReplyOverLimit = reply.length > REPLY_MAX_LENGTH;
  const isPostEmpty = postType === 'text' ? text.trim().length === 0 : !attached;

  const removeAttachedMedia = React.useCallback(() => {
    if (attached?.tempKey) {
      const key = attached.tempKey;
      void fetch(buildTenantApiPath(subdomain, '/publishing/publish-now/temp-media'), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      }).then((response) => {
        if (response.ok) tempKeysRef.current.delete(key);
      });
    }
    setAttached(null);
  }, [attached, subdomain]);

  const handlePostTypeChange = React.useCallback(
    (nextType: ThreadsPublishNowPostType) => {
      if (nextType === postType) return;
      if (attached) removeAttachedMedia();
      setPostType(nextType);
      setErrorMessage(null);
    },
    [attached, postType, removeAttachedMedia]
  );

  const attachLibraryMedia = React.useCallback(
    (media: ComposerMedia) => {
      const expectedMediaType = postType === 'image' ? 'image' : 'video';
      if (postType !== 'text' && media.mediaType !== expectedMediaType) {
        setErrorMessage(
          `This is a ${media.mediaType === 'image' ? 'photo' : 'video'}, but the post type is ${postType === 'image' ? 'Image' : 'Video'}. Switch the post type or pick matching media.`
        );
        setPickerOpen(false);
        return;
      }
      setAttached((prev) => {
        if (prev?.tempKey) {
          void fetch(buildTenantApiPath(subdomain, '/publishing/publish-now/temp-media'), {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: prev.tempKey }),
          }).then((response) => {
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
        if (prev.trim().length === 0 && media.captionText !== null && media.captionText.trim().length > 0) {
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
      if (!TEMP_MIME_TYPES.has(file.type)) {
        setErrorMessage(
          'This file type is not supported on Threads. Choose a JPEG or PNG photo, or an MP4 or MOV video.'
        );
        return;
      }
      const expectedKind = postType === 'image' ? 'image' : 'video';
      if (!file.type.startsWith(`${expectedKind}/`)) {
        setErrorMessage(
          `This is a ${file.type.startsWith('video/') ? 'video' : 'photo'}, but the post type is ${postType === 'image' ? 'Image' : 'Video'}. Switch the post type or pick matching media.`
        );
        return;
      }
      if (file.size > TEMP_MAX_FILE_SIZE_BYTES) {
        setErrorMessage('This file is over the 500 MB limit.');
        return;
      }
      if (postType === 'image' && file.size > THREADS_IMAGE_MAX_BYTES) {
        setErrorMessage('This photo is over the 8 MB limit for Threads. Choose a smaller photo and try again.');
        return;
      }
      setIsUploadingTemp(true);
      setErrorMessage(null);
      try {
        const mediaType = file.type.startsWith('video/') ? 'video' : 'image';
        const mimeType = file.type === 'image/jpg' ? 'image/jpeg' : file.type;
        const info = await mediaInfo(file, mediaType);
        if (
          mediaType === 'video' &&
          info.durationSeconds !== null &&
          info.durationSeconds > THREADS_VIDEO_MAX_DURATION_SECONDS
        ) {
          setErrorMessage('This video is over the 5-minute limit for Threads. Choose a shorter video and try again.');
          return;
        }
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
        if (!putResponse.ok) throw new Error('The upload failed. Please try again.');
        tempKeysRef.current.add(upload.key);
        if (attached?.tempKey) {
          const oldKey = attached.tempKey;
          void fetch(buildTenantApiPath(subdomain, '/publishing/publish-now/temp-media'), {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: oldKey }),
          }).then((response) => {
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
          width: info.width,
          height: info.height,
          captionText: defaultCaption || null,
          libraryId: null,
          tempKey: upload.key,
        });
        setText((prev) => (prev.trim().length === 0 && defaultCaption ? defaultCaption : prev));
      } catch (error) {
        setErrorMessage(errorText(error, 'The upload failed. Please try again.'));
      } finally {
        setIsUploadingTemp(false);
      }
    },
    [attached, postType, subdomain]
  );

  const publishTargets = React.useCallback(
    async (targets: ThreadsPublishNowSelectedAccount[], idempotencyKey: string) => {
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
      const trimmedReply = reply.trim();
      const response = await api.post(
        buildTenantApiPath(subdomain, '/threads/publish-now'),
        {
          caption: text,
          postType,
          ...(trimmedReply.length > 0 ? { reply: trimmedReply } : {}),
          targets: targets.map((account) => ({
            accountId: account.accountId,
            threadsUserId: account.threadsUserId,
            accountName: account.accountName,
            handle: account.handle,
          })),
          media: mediaPayload,
        },
        {
          schema: ThreadsPublishNowResponseSchema,
          headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
        }
      );
      const publishedResults = response.results as ThreadsPublishNowResultItem[];
      for (const result of publishedResults) {
        if (result.status === 'published') {
          publishRunKeysRef.current.set(result.accountId, idempotencyKey);
        }
      }
      return publishedResults;
    },
    [attached, postType, reply, subdomain, text]
  );

  const unpublishedSelectedAccounts = React.useMemo(
    () => unpublishedThreadsAccounts(selectedAccounts, results),
    [selectedAccounts, results]
  );
  const alreadyPublishedSelectedAccounts = React.useMemo(
    () =>
      selectedAccounts.filter((account) => !unpublishedSelectedAccounts.includes(account)),
    [selectedAccounts, unpublishedSelectedAccounts]
  );
  const allSelectedAlreadyPublished =
    hasRun && selectedAccounts.length > 0 && unpublishedSelectedAccounts.length === 0;

  const handlePublish = React.useCallback(async () => {
    if (
      selectedAccounts.length === 0 ||
      unpublishedSelectedAccounts.length === 0 ||
      isPostEmpty ||
      isOverLimit ||
      isReplyOverLimit ||
      isPublishing
    ) {
      return;
    }
    setIsPublishing(true);
    setErrorMessage(null);
    try {
      const nextResults = await publishTargets(unpublishedSelectedAccounts, crypto.randomUUID());
      setResults((prev) => mergeThreadsPublishNowResults(prev, nextResults));
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
    isReplyOverLimit,
    isPublishing,
    publishTargets,
  ]);

  const handleRetryFailedOnly = React.useCallback(async () => {
    const failedAccounts = failedThreadsAccounts(selectedAccounts, results);
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
      setErrorMessage(errorText(error, 'Retrying failed accounts did not work. Please try again.'));
    } finally {
      setIsRetrying(false);
    }
  }, [selectedAccounts, results, isRetrying, publishTargets]);

  const handleRetryReply = React.useCallback(
    async (result: ThreadsPublishNowResultItem) => {
      const runKey = publishRunKeysRef.current.get(result.accountId);
      if (!runKey || retryingReplyKey !== null) return;
      const account = selectedAccounts.find((candidate) => candidate.accountId === result.accountId);
      if (!account) return;
      setRetryingReplyKey(result.accountId);
      setErrorMessage(null);
      try {
        const retried = await publishTargets([account], runKey);
        setResults((prev) => {
          const byKey = new Map(retried.map((item) => [item.accountId, item]));
          return prev.map((item) => byKey.get(item.accountId) ?? item);
        });
      } catch (error) {
        setErrorMessage(errorText(error, 'Retrying the reply did not work. Please try again.'));
      } finally {
        setRetryingReplyKey(null);
      }
    },
    [publishTargets, retryingReplyKey, selectedAccounts]
  );

  const handleStartOver = React.useCallback(() => {
    void deleteAllTempMedia().then((deleted) => {
      if (!deleted) toast.error("We couldn't remove the uploaded file. Please try again.");
      setView('accounts');
      setSelectedAccountIds([]);
      setAccountSearchQuery('');
      setErrorMessage(null);
      setPostType('text');
      setText('');
      setReply('');
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

  const errorBanner = errorMessage ? (
    <div
      data-testid="threads-publish-now-error"
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
              <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">Publish Now</h1>
              <p className="text-base text-ink-sub sm:text-lg">
                Choose the Threads accounts you want to publish to.
              </p>
              <p className="mx-auto max-w-160 text-body leading-body text-ink-sub">
                Publish one post directly to several Threads accounts at once.
              </p>
            </div>

            {errorBanner}

            <div className="rounded-2xl border border-line bg-subtle p-4 sm:p-6">
              <div className="mb-6 flex items-center gap-3">
                <h2 className="text-xl font-semibold text-ink">Select accounts</h2>
              </div>

              {accountsQuery.isPending && (
                <div className="p-6 text-center text-body text-ink-sub">Loading connected Threads accounts...</div>
              )}
              {accountsQuery.isError && (
                <div className="p-6 text-center text-body text-ink-sub">
                  Couldn&apos;t load your Threads accounts. Please try again.
                </div>
              )}
              {!accountsQuery.isPending &&
                !accountsQuery.isError &&
                activeAccounts.length === 0 &&
                nonSelectableAccounts.length === 0 && (
                  <div className="flex flex-col items-center p-6 text-center">
                    <div className="mb-1 text-body font-semibold text-ink">No Threads accounts connected</div>
                    <p className="mb-4 max-w-80 text-body leading-body text-ink-sub">
                      Connect a Threads account before publishing direct posts.
                    </p>
                    <Button asChild>
                      <Link href={`/tenant/${subdomain}/threads/accounts`}>Go to Threads Accounts</Link>
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
                      {accountsRaw.length} {accountsRaw.length === 1 ? 'account' : 'accounts'} ·{' '}
                      {selectedAccountIds.length} of {activeAccounts.length} accounts selected
                    </span>
                    <button
                      type="button"
                      aria-pressed={activeAccounts.every((account) =>
                        selectedAccountIds.includes(account.id)
                      )}
                      onClick={toggleSelectAllAccounts}
                      className="inline-flex min-h-11 items-center px-2 text-metadata font-semibold text-link outline-none focus-visible:outline-2 focus-visible:outline-link"
                    >
                      {activeAccounts.every((account) => selectedAccountIds.includes(account.id))
                        ? 'Deselect All'
                        : 'Select All'}
                    </button>
                  </div>
                  <div className="flex max-h-75 flex-col gap-1 overflow-y-auto pr-2">
                    {filteredActiveAccounts.length === 0 && (
                      <div className="p-8 text-center text-ink-sub">No accounts match your search</div>
                    )}
                    {filteredActiveAccounts.map((account) => {
                      const checked = selectedAccountIds.includes(account.id);
                      const selected = activeById.get(account.id);
                      return (
                        <label
                          key={account.id}
                          className={cn(
                            'flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-sm px-3.5 py-3 outline-none transition-colors hover:bg-hover sm:gap-4',
                            checked && 'bg-hover'
                          )}
                        >
                          <Checkbox checked={checked} onCheckedChange={() => toggleAccount(account.id)} />
                          <Avatar
                            name={account.displayName}
                            pictureUrl={account.profilePictureUrl}
                            size="lg"
                          />
                          <span className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">
                            {account.displayName}
                            {selected?.handle ? (
                              <span className="block truncate text-body font-normal text-ink-sub">
                                @{selected.handle}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </>
              )}

              {!accountsQuery.isPending && nonSelectableAccounts.length > 0 && (
                <div className={cn('flex flex-col gap-1', activeAccounts.length > 0 && 'mt-4')}>
                  {nonSelectableAccounts.map((account) => {
                    const expired = getAccountHealth(account) === 'expired';
                    return (
                      <div
                        key={account.id}
                        className="flex items-center justify-between gap-3 rounded-sm px-3.5 py-3 opacity-55 sm:gap-4"
                      >
                        <div className="flex min-w-0 items-center gap-4">
                          <Avatar name={account.displayName} pictureUrl={account.profilePictureUrl} size="lg" />
                          <div className="min-w-0">
                            <div className="truncate text-body font-semibold text-ink">{account.displayName}</div>
                            <div className="mt-0.5 text-metadata text-ink-sub">
                              {expired ? 'Session expired' : 'Disconnected'}
                              {account.handle ? ` · @${account.handle}` : ''}
                            </div>
                          </div>
                        </div>
                        <Button type="button" variant="outline" size="sm" asChild className="shrink-0">
                          <Link href={`/tenant/${subdomain}/threads/accounts`}>Reconnect</Link>
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
                    <div key={account.accountId} className={cn(index > 0 && '-ml-3')}>
                      <Avatar name={account.accountName} pictureUrl={account.profilePictureUrl} />
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
                      {selectedAccounts.length > 1 && ` + ${selectedAccounts.length - 1} more`}
                    </h2>
                    <span className="shrink-0 rounded-full border border-link/35 px-2 py-0.5 text-metadata font-semibold uppercase tracking-body text-link">
                      Selected
                    </span>
                  </div>
                  {selectedAccounts[0]?.handle && (
                    <p className="mt-0.5 truncate text-sm leading-tight text-ink-sub">
                      @{selectedAccounts[0].handle}
                      {selectedAccounts.length > 1 && ` + ${selectedAccounts.length - 1} more`}
                    </p>
                  )}
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
                  <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
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
                            isActive && 'border-link/50 bg-link/10 text-link hover:bg-link/10 hover:text-link'
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
                    <span className={cn('text-xs', isOverLimit ? 'text-signal-critical' : 'text-ink-sub')}>
                      {weightedLength.toLocaleString()} / {THREADS_MAX_TEXT_WEIGHTED_CHARACTERS.toLocaleString()}
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
                    <p className="text-metadata text-signal-critical">
                      {weightedLength > THREADS_MAX_TEXT_WEIGHTED_CHARACTERS
                        ? `Caption is over the ${THREADS_MAX_TEXT_WEIGHTED_CHARACTERS}-character limit for Threads. Emoji count for more than one.`
                        : `Threads posts can include at most ${THREADS_MAX_LINKS} links. Remove a link and try again.`}
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
                            aria-label="Upload file from device"
                            accept={postType === 'image' ? 'image/jpeg,image/png' : 'video/mp4,video/quicktime'}
                            className="hidden"
                            onChange={(event) => {
                              const file = event.target.files?.[0];
                              event.target.value = '';
                              if (file) void handleTempFileSelect(file);
                            }}
                          />
                        </div>
                        {isUploadingTemp && <p className="text-body text-ink-sub">Uploading file...</p>}
                        <p className="text-metadata leading-body text-ink-sub">
                          {postType === 'image'
                            ? 'Photos on Threads: JPEG or PNG, at most 8 MB.'
                            : 'Videos on Threads: at most 5 minutes.'}
                        </p>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 rounded-2xl border border-line bg-canvas p-3 sm:gap-4 sm:p-4">
                        {attached.mediaType === 'image' && (attached.thumbnailUrl || attached.url) ? (
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
                          <p className="truncate text-sm font-medium text-ink">{attached.name}</p>
                          <p className="text-xs text-ink-sub">
                            {attached.mediaType === 'image' ? 'Image' : 'Video'}
                            {attached.libraryId ? ' · from Media Library' : ' · from your device'}
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
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-body font-medium text-ink">Reply (optional)</p>
                    <span className={cn('text-xs', isReplyOverLimit ? 'text-signal-critical' : 'text-ink-sub')}>
                      {reply.length.toLocaleString()} / {REPLY_MAX_LENGTH.toLocaleString()}
                    </span>
                  </div>
                  <Input
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    disabled={isPublishing || isUploadingTemp}
                    className="h-11 rounded-xl bg-canvas"
                    placeholder="Write a reply..."
                    aria-label="Reply (optional)"
                  />
                  <p className="text-metadata leading-body text-ink-sub">
                    The same reply will appear on every account this post publishes to, posted as a reply to
                    that account&apos;s post.
                  </p>
                </div>

                {alreadyPublishedSelectedAccounts.length > 0 && (
                  <p
                    data-testid="threads-publish-now-already-published-note"
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
                    isReplyOverLimit ||
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
                <h2 className="text-lg font-semibold text-ink">Publish results</h2>
                {hasRun && (
                  <p className="mt-1 text-metadata text-ink-sub">
                    {publishedCount} of {results.length} {results.length === 1 ? 'account' : 'accounts'} published
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
                    {results.map((result) => {
                      const published = result.status === 'published';
                      const diagnosticParts: string[] = [];
                      if (!published) {
                        if (typeof result.graphCode === 'number') diagnosticParts.push(`Threads error #${result.graphCode}`);
                        if (typeof result.graphSubcode === 'number') diagnosticParts.push(`subcode ${result.graphSubcode}`);
                        if (typeof result.step === 'string' && result.step.length > 0) diagnosticParts.push(`step: ${result.step}`);
                        if (typeof result.httpStatus === 'number') diagnosticParts.push(`HTTP ${result.httpStatus}`);
                        if (typeof result.fbtraceId === 'string' && result.fbtraceId.length > 0) diagnosticParts.push(`trace: ${result.fbtraceId}`);
                      }
                      const key = result.accountId;
                      return (
                        <div key={key} className="rounded-xl border border-line bg-canvas p-3 sm:p-4">
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
                              <div className="truncate text-body font-semibold text-ink">{result.accountName}</div>
                              {result.handle && (
                                <div className="truncate text-metadata text-ink-sub">@{result.handle}</div>
                              )}
                              <div
                                className={cn(
                                  'mt-0.5',
                                  published ? 'text-metadata text-brand-emerald' : 'text-metadata text-signal-critical'
                                )}
                              >
                                {published ? 'Published' : (result.reason ?? 'Publishing failed.')}
                              </div>
                              {diagnosticParts.length > 0 && (
                                <div className="mt-0.5">
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setExpandedDetails((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(key)) next.delete(key);
                                        else next.add(key);
                                        return next;
                                      });
                                    }}
                                    className="text-metadata font-semibold text-link outline-none focus-visible:outline-2 focus-visible:outline-link"
                                  >
                                    {expandedDetails.has(key) ? 'Hide details' : 'View details'}
                                  </button>
                                  {expandedDetails.has(key) && (
                                    <div className="mt-0.5 break-all text-metadata text-ink-sub">
                                      {diagnosticParts.join(' · ')}
                                    </div>
                                  )}
                                </div>
                              )}
                              {published && result.replyFailed && (
                                <div className="mt-1 text-metadata leading-body text-signal-critical">
                                  Reply could not be posted
                                  {result.replyReason ? `: ${result.replyReason}` : '.'} The post was published.{' '}
                                  <button
                                    type="button"
                                    disabled={retryingReplyKey !== null}
                                    onClick={() => void handleRetryReply(result)}
                                    className="font-semibold text-link outline-none focus-visible:outline-2 focus-visible:outline-brand-gold disabled:opacity-50"
                                  >
                                    {retryingReplyKey === key ? 'Retrying reply…' : 'Retry reply'}
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
                    <Button type="button" disabled={isRetrying} onClick={() => void handleRetryFailedOnly()}>
                      {isRetrying ? 'Retrying...' : 'Retry failed only'}
                    </Button>
                  )}
                  <Button type="button" variant="outline" disabled={isPublishing || isRetrying} onClick={handleStartOver}>
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
