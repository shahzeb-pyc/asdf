'use client';

/**
 * Publish Now dialogue — the approved 4-step flow, built on the
 * Add Page and Create Posts patterns but with the deliberate
 * differences the product owner approved:
 *
 *   Step 1 — accounts: MULTI-select checkboxes (Add Page used a
 *     single-click row). Each row shows ONLY the account (avatar +
 *     display name) — never a "pages linked" count, because an
 *     account can publish to ANY of its pages, even one that is
 *     not added to the workspace Pages list.
 *   Step 2 — pages: ALL discovered pages for the selected
 *     accounts, grouped by account. Already-added pages are NOT
 *     disabled and NOT excluded (Add Page's "Already added"
 *     behaviour does not apply here), and selecting a page here
 *     does NOT add it to Pages. Pages whose already-added
 *     destination is paused / rate-limited / checkpoint /
 *     invalid-token / disconnected are disabled with a reason;
 *     not-added pages have no such status and are selectable, and
 *     a page whose status cannot be determined stays selectable
 *     so its publish result reports any failure.
 *   Step 3 — one post only: a single composer block (no Bulk Post,
 *     no Bulk Text, no trailing empty block), type derived from
 *     content, caption + one media, no queue, no scheduling, no
 *     posting-times pre-check. Library attach is a read; device
 *     upload goes to a TEMPORARY R2 prefix and is deleted when
 *     the run ends (kept alive through the results screen so
 *     "Retry failed only" can reuse it).
 *   Step 4 — results: one row per page, tick in a green circle /
 *     cross in a red circle (never status dots), failure reason,
 *     "Retry failed only" (never re-publishes successes), Done.
 *
 * Nothing in this flow writes to the database. The direct-publish
 * route publishes synchronously and returns per-page results;
 * closing or refreshing the results screen therefore loses the
 * in-memory success tracking — an accepted trade-off, stated in
 * the results copy, not hidden.
 */

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeftIcon, SearchIcon } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  composerTextLimitForBlock,
  deriveComposerPostType,
  deriveDefaultCaptionFromFilename,
  PublishNowResponseSchema,
  PublishNowTempMediaResponseSchema,
  type ComposerDraftBlock,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Input } from '@/components/shared/ui/input';
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
import { PostBlock } from '@/components/pages/dedicated/create-posts/post-block';
import { MediaLibraryPicker } from '@/components/pages/dedicated/create-posts/media-library-picker';
import { cn } from '@/lib/utils';
import type {
  PublishNowAttachedMedia,
  PublishNowDiscoveredGroup,
  PublishNowResultItem,
  PublishNowSelectedPage,
} from './types';

export type PublishNowStep = 'accounts' | 'pages' | 'compose' | 'results';

export interface PublishNowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subdomain: string;
  /** Called when the run ends via Done (after temp cleanup). */
  onDone: () => void;
}

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

function errorText(error: unknown, fallback: string): string {
  if (isApiError(error) && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function Avatar({
  name,
  pictureUrl,
}: Readonly<{ name: string; pictureUrl?: string | null | undefined }>) {
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const showImg = Boolean(pictureUrl) && failedUrl !== pictureUrl;
  const initials = getUserInitials(name) || 'FB';
  if (showImg) {
    return (
      <Image
        src={pictureUrl!}
        alt={name}
        width={36}
        height={36}
        onError={() => setFailedUrl(pictureUrl ?? '__error__')}
        className="size-9 shrink-0 rounded-full border border-line object-cover"
      />
    );
  }
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-line bg-subtle text-body font-bold text-ink">
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

export function PublishNowDialog({
  open,
  onOpenChange,
  subdomain,
  onDone,
}: Readonly<PublishNowDialogProps>) {
  const [step, setStep] = React.useState<PublishNowStep>('accounts');
  const [selectedAccountIds, setSelectedAccountIds] = React.useState<string[]>([]);
  const [groups, setGroups] = React.useState<PublishNowDiscoveredGroup[]>([]);
  const [selectedPageKeys, setSelectedPageKeys] = React.useState<string[]>([]);
  const [pageSearchQuery, setPageSearchQuery] = React.useState('');
  const [isDiscovering, setIsDiscovering] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [text, setText] = React.useState('');
  const [attached, setAttached] = React.useState<PublishNowAttachedMedia | null>(null);
  const [attachChoiceOpen, setAttachChoiceOpen] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerSession, setPickerSession] = React.useState(0);
  const [isUploadingTemp, setIsUploadingTemp] = React.useState(false);
  const [isPublishing, setIsPublishing] = React.useState(false);
  const [isRetrying, setIsRetrying] = React.useState(false);
  const [results, setResults] = React.useState<PublishNowResultItem[]>([]);
  const [hasRun, setHasRun] = React.useState(false);
  const tempKeysRef = React.useRef<Set<string>>(new Set());
  const tempInputRef = React.useRef<HTMLInputElement | null>(null);
  const closeGuardRef = React.useRef(false);

  const accountsQuery = useQuery({
    queryKey: ['publish-now', 'accounts', subdomain],
    enabled: open,
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/accounts'), {
        schema: ListFacebookAccountsResponseSchema,
        query: { page: 1, limit: 50 },
        signal,
      }),
  });
  const byocQuery = useQuery({
    queryKey: ['publish-now', 'byoc', subdomain],
    enabled: open,
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
  const facebookAppConfigured = byocQuery.data
    ? Boolean(byocQuery.data.fbAppId && byocQuery.data.hasSecret)
    : undefined;
  const showMissingAppGuidance =
    step === 'accounts' &&
    facebookAppConfigured === false &&
    activeAccounts.length === 0;

  // Fresh run on every open: a previous session never leaks in.
  React.useEffect(() => {
    if (open) {
      setStep('accounts');
      setSelectedAccountIds([]);
      setGroups([]);
      setSelectedPageKeys([]);
      setPageSearchQuery('');
      setIsDiscovering(false);
      setErrorMessage(null);
      setText('');
      setAttached(null);
      setAttachChoiceOpen(false);
      setPickerOpen(false);
      setPickerSession((prev) => prev + 1);
      setIsUploadingTemp(false);
      setIsPublishing(false);
      setIsRetrying(false);
      setResults([]);
      setHasRun(false);
      tempKeysRef.current = new Set();
      closeGuardRef.current = false;
    }
  }, [open ]);

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

  const handleClose = React.useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        // Never unmount mid-publish: the temp file must survive
        // until the results screen, and a publish in flight must
        // not lose its media underneath it.
        if (isPublishing || isRetrying) return;
        if (!closeGuardRef.current) {
          closeGuardRef.current = true;
          void deleteAllTempMedia().then((deleted) => {
            if (!deleted) {
              toast.error(
                'A temporary upload could not be deleted. It was not saved to your Media Library.'
              );
            }
            onOpenChange(false);
          });
          return;
        }
      }
      onOpenChange(nextOpen);
    },
    [isPublishing, isRetrying, deleteAllTempMedia, onOpenChange]
  );

  const handleDone = React.useCallback(() => {
    void deleteAllTempMedia().then((deleted) => {
      if (!deleted) {
        toast.error(
          'A temporary upload could not be deleted. It was not saved to your Media Library.'
        );
      }
      onDone();
    });
  }, [deleteAllTempMedia, onDone]);

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
      setStep('pages');
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
    setStep('accounts');
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

  const composerBlock: ComposerDraftBlock = React.useMemo(() => {
    const media: ComposerMedia | null = attached
      ? {
          id: attached.libraryId ?? crypto.randomUUID(),
          name: attached.name,
          mediaType: attached.mediaType,
          aspectRatio: attached.aspectRatio ?? 'unknown',
          thumbnailUrl: attached.thumbnailUrl,
          url: attached.url,
          width: attached.width,
          height: attached.height,
          captionText: attached.captionText,
        }
      : null;
    return { id: 'publish-now-post', text, media };
  }, [text, attached]);

  const derivedType = deriveComposerPostType({
    text,
    mediaType: attached?.mediaType ?? null,
    aspectRatio: attached?.aspectRatio ?? null,
    width: attached?.width ?? null,
    height: attached?.height ?? null,
  });
  const limit = composerTextLimitForBlock(composerBlock);
  const isOverLimit = text.length > limit;
  const isPostEmpty = text.trim().length === 0 && !attached;

  const attachLibraryMedia = React.useCallback(
    (media: ComposerMedia) => {
      setAttached((prev) => {
        if (prev?.tempKey) {
          // A previous temp file is replaced: it becomes orphaned
          // for the run-end cleanup below.
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
    [subdomain]
  );

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
  }, [attached]);

  const handleTempFileSelect = React.useCallback(
    async (file: File) => {
      if (!TEMP_MIME_TYPES.has(file.type)) {
        setErrorMessage('This file type is not supported. Choose an image or video.');
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
          throw new Error('The upload to storage failed.');
        }
        tempKeysRef.current.add(upload.key);
        const dimensions = await mediaDimensions(file, mediaType);
        // A replaced temp file is cleaned up best-effort now; if
        // that delete fails it stays tracked for run-end cleanup.
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
          errorText(error, 'The temporary upload failed. Please try again.')
        );
      } finally {
        setIsUploadingTemp(false);
      }
    },
    [attached, subdomain]
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
      const response = await api.post(
        buildTenantApiPath(subdomain, '/publishing/publish-now'),
        {
          caption: text,
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
    [attached, subdomain, text]
  );

  const handlePublish = React.useCallback(async () => {
    if (selectedPages.length === 0 || isPostEmpty || isOverLimit || isPublishing) {
      return;
    }
    setIsPublishing(true);
    setErrorMessage(null);
    try {
      const nextResults = await publishTargets(selectedPages);
      setResults(nextResults);
      setHasRun(true);
      setStep('results');
    } catch (error) {
      setErrorMessage(
        errorText(error, 'Publishing failed. Please try again.')
      );
    } finally {
      setIsPublishing(false);
    }
  }, [selectedPages, isPostEmpty, isOverLimit, isPublishing, publishTargets]);

  const handleRetryFailedOnly = React.useCallback(async () => {
    const failedPages = selectedPages.filter((page) =>
      results.some(
        (result) =>
          result.status === 'failed' &&
          result.accountId === page.accountId &&
          result.fbPageId === page.fbPageId
      )
    );
    if (failedPages.length === 0 || isRetrying) return;
    setIsRetrying(true);
    setErrorMessage(null);
    try {
      const retried = await publishTargets(failedPages);
      // Merge by page: successes are never touched, so a retry
      // can never re-publish a page that already succeeded.
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

  const publishedCount = results.filter(
    (result) => result.status === 'published'
  ).length;
  const failedResults = results.filter((result) => result.status === 'failed');

  const headerTitle =
    step === 'accounts'
      ? 'Select Facebook Accounts'
      : step === 'pages'
        ? 'Select Facebook Pages'
        : step === 'compose'
          ? 'Create post'
          : 'Publish results';
  const headerSubtitle =
    step === 'accounts'
      ? 'Choose which connected Facebook accounts you want to publish from. You can select more than one.'
      : step === 'pages'
        ? `${selectedAccountIds.length} ${selectedAccountIds.length === 1 ? 'account' : 'accounts'} selected · ${allPages.length} ${allPages.length === 1 ? 'page' : 'pages'} available`
        : step === 'compose'
          ? 'One post only. The same post will publish to all selected pages.'
          : hasRun
            ? `${publishedCount} of ${results.length} ${results.length === 1 ? 'page' : 'pages'} published`
            : '';

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent
          className="sm:max-w-135"
          data-testid="publish-now-dialog"
        >
          <DialogHeader>
            <div className="flex items-start gap-2">
              {step === 'pages' && (
                <button
                  type="button"
                  data-testid="publish-now-back-to-accounts-btn"
                  onClick={handleBackToAccounts}
                  aria-label="Back to account selection"
                  className="mt-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-xs text-ink-sub outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-gold"
                >
                  <ArrowLeftIcon className="size-4" aria-hidden />
                </button>
              )}
              {step === 'compose' && (
                <button
                  type="button"
                  data-testid="publish-now-back-to-pages-btn"
                  onClick={() => setStep('pages')}
                  aria-label="Back to page selection"
                  className="mt-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-xs text-ink-sub outline-none transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-brand-gold"
                >
                  <ArrowLeftIcon className="size-4" aria-hidden />
                </button>
              )}
              <div className="min-w-0 flex-1">
                <DialogTitle>{headerTitle}</DialogTitle>
                <DialogDescription>{headerSubtitle}</DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div>
            {errorMessage && (
              <div
                data-testid="publish-now-error"
                className="mb-4 rounded-sm border border-brand-rose/25 bg-brand-rose/10 px-3 py-2 text-body text-brand-rose"
              >
                {errorMessage}
              </div>
            )}

            {step === 'accounts' && (
              <div>
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
                      onClick={() => handleClose(false)}
                    >
                      Add App ID and Secret in Settings
                    </Link>
                  </div>
                )}

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
                        No active Facebook accounts connected
                      </div>
                      <p className="mb-4 max-w-80 text-body leading-body text-ink-sub">
                        Connect a Facebook account first so you can discover
                        and publish to its pages.
                      </p>
                      <Button asChild>
                        <Link
                          href={buildAccountsHref(subdomain)}
                          onClick={() => handleClose(false)}
                        >
                          Go to Facebook Accounts
                        </Link>
                      </Button>
                    </div>
                  )}

                {!accountsQuery.isPending && activeAccounts.length > 0 && (
                  <div className="flex flex-col gap-1">
                    {activeAccounts.map((account) => {
                      const checked = selectedAccountIds.includes(account.id);
                      return (
                        <label
                          key={account.id}
                          className={cn(
                            'flex min-h-11 w-full cursor-pointer items-center gap-4 rounded-sm px-3.5 py-3 outline-none transition-colors hover:bg-hover',
                            checked && 'bg-subtle'
                          )}
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={() => toggleAccount(account.id)}
                          />
                          <Avatar
                            name={account.displayName}
                            pictureUrl={account.profilePictureUrl}
                          />
                          <span className="min-w-0 truncate text-body font-semibold text-ink">
                            {account.displayName}
                          </span>
                        </label>
                      );
                    })}
                  </div>
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
              </div>
            )}

            {step === 'pages' && (
              <div className="flex flex-col gap-2">
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
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-4 px-0.5">
                      <div className="relative flex max-w-60 flex-1 items-center">
                        <SearchIcon
                          className="pointer-events-none absolute left-2.5 size-3.5 text-ink-dim"
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
                          className="border-line bg-canvas pl-8 shadow-none"
                        />
                      </div>
                      <div className="flex items-center gap-2">
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
                    </div>
                    <div className="flex max-h-85 flex-col overflow-y-auto border-t border-line">
                      {filteredGroups.map((group) => (
                        <div key={group.accountId}>
                          <div className="border-b border-line bg-subtle px-3 py-2 text-metadata font-semibold tracking-body text-ink-sub">
                            {group.accountName}
                          </div>
                          {group.pages.map((page) => {
                            const key = `${page.accountId}:${page.fbPageId}`;
                            const checked = selectedPageKeys.includes(key);
                            const disabled = Boolean(page.disabledReason);
                            return (
                              <label
                                key={key}
                                className={cn(
                                  'flex items-center gap-4 rounded-xs border-b border-line px-3 py-2.5 transition-colors',
                                  checked && !disabled && 'bg-subtle',
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
                                </div>
                                {disabled && page.disabledReason && (
                                  <span className="shrink-0 text-metadata font-medium text-ink-dim">
                                    {page.disabledReason}
                                  </span>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                    <p className="px-0.5 text-metadata leading-body text-ink-sub">
                      Selecting a page here does not add it to your Pages
                      list. It is published to directly, and nothing is saved.
                    </p>
                  </>
                )}
              </div>
            )}

            {step === 'compose' && (
              <div className="flex flex-col gap-3">
                <p className="text-body text-ink-sub">
                  Posting to:{' '}
                  <span className="font-semibold text-ink">
                    {selectedPages.map((page) => page.pageName).join(', ')}
                  </span>
                </p>
                <PostBlock
                  block={composerBlock}
                  label="Post"
                  isDraft
                  disabled={isPublishing || isUploadingTemp}
                  onTextChange={setText}
                  onAttachRequest={() => setAttachChoiceOpen(true)}
                  onRemoveMedia={removeAttachedMedia}
                  onRemove={() => undefined}
                />
                {attachChoiceOpen && !attached && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isUploadingTemp}
                      onClick={() => setPickerOpen(true)}
                    >
                      Attach from Media Library
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isUploadingTemp}
                      onClick={() => tempInputRef.current?.click()}
                    >
                      Upload from device (temporary)
                    </Button>
                    <input
                      ref={tempInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm"
                      className="hidden"
                      aria-hidden
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = '';
                        if (file) void handleTempFileSelect(file);
                      }}
                    />
                  </div>
                )}
                {isUploadingTemp && (
                  <p className="text-body text-ink-sub">
                    Uploading temporary file...
                  </p>
                )}
                {attached?.tempKey && (
                  <p className="text-metadata leading-body text-ink-sub">
                    This device file is temporary: it is used only for this
                    post and deleted when this run ends. It is not saved in
                    your Media Library.
                  </p>
                )}
              </div>
            )}

            {step === 'results' && (
              <div className="flex flex-col gap-2">
                <p className="text-metadata leading-body text-ink-sub">
                  Nothing was saved in the database. Closing this screen
                  loses this result list.
                </p>
                <div className="flex max-h-85 flex-col overflow-y-auto border-t border-line">
                  {results.map((result) => {
                    const published = result.status === 'published';
                    return (
                      <div
                        key={`${result.accountId}:${result.fbPageId}`}
                        className="flex items-center gap-4 border-b border-line px-3 py-2.5"
                      >
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
                            {result.pageName}
                          </div>
                          <div
                            className={cn(
                              'mt-0.5 text-metadata',
                              published ? 'text-brand-emerald' : 'text-brand-rose'
                            )}
                          >
                            {published ? 'Published' : (result.reason ?? 'Publishing failed.')}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            {step === 'accounts' && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleClose(false)}
                >
                  Cancel
                </Button>
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
              </>
            )}
            {step === 'pages' && (
              <>
                <Button type="button" variant="outline" onClick={handleBackToAccounts}>
                  Back
                </Button>
                <Button
                  type="button"
                  disabled={selectedPages.length === 0}
                  onClick={() => setStep('compose')}
                >
                  {selectedPages.length === 0
                    ? 'Continue'
                    : `Continue (${selectedPages.length} ${selectedPages.length === 1 ? 'page' : 'pages'})`}
                </Button>
              </>
            )}
            {step === 'compose' && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isPublishing}
                  onClick={() => setStep('pages')}
                >
                  Back
                </Button>
                <Button
                  type="button"
                  disabled={
                    isPostEmpty || isOverLimit || isPublishing || isUploadingTemp
                  }
                  onClick={() => void handlePublish()}
                >
                  {isPublishing ? 'Publishing...' : 'Publish'}
                </Button>
              </>
            )}
            {step === 'results' && (
              <>
                {failedResults.length > 0 && (
                  <Button
                    type="button"
                    disabled={isRetrying}
                    onClick={() => void handleRetryFailedOnly()}
                  >
                    {isRetrying ? 'Retrying...' : 'Retry failed only'}
                  </Button>
                )}
                <Button type="button" onClick={handleDone}>
                  Done
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
    </>
  );
}
