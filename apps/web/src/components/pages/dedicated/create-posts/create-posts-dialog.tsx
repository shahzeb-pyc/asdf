'use client';

/**
 * Create Posts dialogue for a dedicated Facebook Page.
 *
 * Split-pane workspace, not a single scrolling column: the post list
 * on the left, the selected post's editor + genuine preview on the
 * right, and a pinned footer that can never scroll away. The header
 * is visible (title, subtitle explaining the queue-only model, and
 * a posts count badge), and the dialogue is wide and tall on
 * desktop (~90vh) while stacking list/editor on phones.
 *
 * One layout, post blocks — never a single/bulk mode switcher.
 * The dialogue holds a list of post blocks in order, each with its
 * own text, its own attached media, and its own type derived from
 * its content (never picked). The trailing "New post" block is
 * always present: typing or attaching in it turns it into a real
 * post, and a fresh empty one appears below it.
 *
 * Queue only: there is no publish-now button, no scheduling field,
 * and no date/time picker anywhere here. "Add all to Queue" sends
 * every ready block in order through the existing destination
 * enqueue API with intent 'queue', so each post goes out at the
 * destination's next fitting posting time. There is no Create
 * Stories button: the stories flow is undecided, and a dead button
 * never ships.
 *
 * Duplicate protection, in two layers: the queueing lock is a ref
 * set synchronously at the top of the handler, before the
 * posting-times await, so a second click/Enter during the pre-check
 * cannot start a second loop; and the server claims the block's
 * idempotency key atomically before inserting. A block's key rotates
 * when its text or media changes after a queue attempt, so an
 * edit-after-enqueue retries the EDITED post instead of replaying
 * the original — while a pure retry of an unedited block still
 * replays safely.
 *
 * Drafts: dismissing with non-empty drafts asks first (Cancel,
 * backdrop, Esc, close button all go through the same confirm),
 * and following "Go to Posting Times" preserves the drafts for the
 * next open instead of discarding them. Nothing closes the dialogue
 * mid-queueing.
 */

import * as React from 'react';
import Image from 'next/image';
import { XIcon } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  assignQueueEstimates,
  ComposerDraftBlockSchema,
  composerTextLimitForBlock,
  deriveComposerPostType,
  DestinationEnqueueResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  itemSlotFormat,
  toComposerEnqueueItem,
  type ComposerDraftBlock,
  type ComposerMedia,
} from '@fbuploadpro/contracts';
import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import {
  ListQueueItemsResponseSchema,
  ListQueueSlotsResponseSchema,
} from '@/lib/api/schemas/queue';
import { queryKeys } from '@/lib/data/query-keys';
import { cn } from '@/lib/utils';
import { Button } from '@/components/shared/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/shared/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { toast } from '@/components/shared/ui/toast';
import type { FacebookPageItem } from '@/components/pages/page-card';
import { LeavePageGuardDialog } from '@/components/media/leave-page-guard-dialog';
import { BulkTextDialog } from './bulk-text-dialog';
import { MediaLibraryPicker } from './media-library-picker';
import { PostBlock } from './post-block';
import { PostPreview } from './post-preview';

export interface CreatePostsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subdomain: string;
  page: FacebookPageItem;
}

/** The old composer's batch cap, kept: it stops a 500-item Select All
 *  from firing 500 sequential enqueue requests. */
const MAX_POSTS_PER_BATCH = 150;

function newEmptyBlock(): ComposerDraftBlock {
  return {
    id: typeof crypto !== 'undefined' ? crypto.randomUUID() : `block-${Date.now()}`,
    text: '',
    media: null,
  };
}

function newKey(): string {
  return typeof crypto !== 'undefined'
    ? crypto.randomUUID()
    : `key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isBlockEmpty(block: ComposerDraftBlock): boolean {
  return block.text.trim().length === 0 && block.media === null;
}

function errorText(error: unknown, fallback: string): string {
  if (isApiError(error) && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** Plain-language page-status gate for the composer (the server
 *  enforces the same gate; this is the message the user sees). */
function pageStatusGate(status: FacebookPageItem['status']): {
  blocked: boolean;
  message: string | null;
} {
  switch (status) {
    case 'invalid_token':
      return {
        blocked: true,
        message:
          'This Page’s connection has expired. Reconnect the Page first — queueing is turned off for this Page until then.',
      };
    case 'page_checkpoint':
      return {
        blocked: true,
        message:
          'This Page is waiting on a Facebook identity check. Resolve it in Facebook first — queueing is turned off for this Page until then.',
      };
    case 'fb_rate_limited':
      return {
        blocked: true,
        message:
          'This Page is rate-limited by Facebook right now. Wait for the limit to lift — queueing is turned off for this Page until then.',
      };
    case 'disconnected':
      return {
        blocked: true,
        message:
          'This Page is disconnected. Add it again first — queueing is turned off for this Page until then.',
      };
    case 'paused':
      return {
        blocked: false,
        message:
          'This Page is paused — posts you add will wait until the Page is reactivated.',
      };
    default:
      return { blocked: false, message: null };
  }
}

export function CreatePostsDialog({
  open,
  onOpenChange,
  subdomain,
  page,
}: Readonly<CreatePostsDialogProps>) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [blocks, setBlocks] = React.useState<ComposerDraftBlock[]>([newEmptyBlock()]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [mobileView, setMobileView] = React.useState<'list' | 'editor'>('list');
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerMode, setPickerMode] = React.useState<'single' | 'multi'>('multi');
  const [pickerTargetId, setPickerTargetId] = React.useState<string | null>(null);
  const [bulkTextOpen, setBulkTextOpen] = React.useState(false);
  const [isQueueing, setIsQueueing] = React.useState(false);
  const [queueProgress, setQueueProgress] = React.useState<{
    total: number;
    done: number;
  } | null>(null);
  // Synchronous queueing lock: state updates are async, so a second
  // click arriving before the next render (during the slots await)
  // would still see isQueueing === false. The ref is set before
  // any await, so that window does not exist.
  const queueingLockRef = React.useRef(false);
  // Idempotency keys, one stable key per post block for the life of
  // this dialogue session. A block retried after a response-lost
  // enqueue reuses its key, so the server returns the ORIGINAL
  // queue item instead of a second row. Keys are keyed by block id
  // and die with the dialogue: a block drafted in a new session is
  // a new post. Editing a block that already has a key rotates it
  // (see rotateKeyIfAttempted), so an edit never replays stale content.
  const idempotencyKeysRef = React.useRef(new Map<string, string>());
  // Set by the "Go to Posting Times" action: the next open restores
  // the drafts instead of resetting to one empty block.
  const preserveDraftsRef = React.useRef(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = React.useState(false);
  const [failedAvatarUrl, setFailedAvatarUrl] = React.useState<string | null>(null);
  const [pickerSession, setPickerSession] = React.useState(0);
  const [pickerUploadCount, setPickerUploadCount] = React.useState(0);
  const [pickerFurthestUpload, setPickerFurthestUpload] = React.useState<{
    name: string;
    progressPercent: number;
  } | null>(null);
  const [leaveGuardOpen, setLeaveGuardOpen] = React.useState(false);
  // Estimate inputs, fetched on open: active posting times plus the
  // posts already queued ahead of this batch. A failed fetch leaves
  // estimates blank (the generic "next posting time" line) rather
  // than a wrong time.
  const [estimateSlots, setEstimateSlots] = React.useState<
    Array<{
      id: string;
      timeOfDay: string;
      isActive: boolean;
      allowedFormats: readonly string[] | null;
    }>
  >([]);
  const [existingQueued, setExistingQueued] = React.useState<
    Array<{ id: string; format: string }>
  >([]);

  const statusGate = pageStatusGate(page.status);

  // Fresh dialogue on every open: a previous session's blocks never
  // leak into the next one — unless the user is returning from the
  // "Go to Posting Times" action, in which case the drafts survive.
  React.useEffect(() => {
    if (open) {
      if (!preserveDraftsRef.current) {
        setBlocks([newEmptyBlock()]);
        idempotencyKeysRef.current.clear();
        setSelectedId(null);
        setQueueProgress(null);
      }
      preserveDraftsRef.current = false;
      setPickerOpen(false);
      setBulkTextOpen(false);
      setPickerSession((prev) => prev + 1);
    }
  }, [open ]);

  // Selection follows the blocks: the selected block stays selected
  // across edits, and removing it falls back to the first block.
  React.useEffect(() => {
    if (blocks.length === 0) return;
    if (!selectedId || !blocks.some((block) => block.id === selectedId)) {
      setSelectedId(blocks[0]!.id);
    }
  }, [blocks, selectedId]);

  // Estimate inputs on open (slots + the full queued set, paged).
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        const slotsResponse = await api.get(
          buildTenantApiPath(subdomain, `/pages/${page.id}/slots`),
          { schema: ListQueueSlotsResponseSchema }
        );
        if (!cancelled) {
          setEstimateSlots(
            slotsResponse.slots.map((slot) => ({
              id: slot.id,
              timeOfDay: slot.slotTime,
              isActive: slot.isActive,
              allowedFormats: slot.allowedFormats ?? null,
            }))
          );
        }
      } catch {
        if (!cancelled) setEstimateSlots([]);
      }
      try {
        const all: Array<{ id: string; format: string }> = [];
        let offset = 0;
        for (let pageCount = 0; pageCount < 100; pageCount += 1) {
          const res = await api.get(
            buildTenantApiPath(subdomain, '/publishing/queue'),
            {
              schema: ListQueueItemsResponseSchema,
              query: { pageId: page.id, limit: 100, offset },
            }
          );
          for (const item of res.items) {
            if (item.status === 'queued') {
              all.push({ id: item.id, format: item.postFormat ?? 'text' });
            }
          }
          if (all.length >= res.total || res.items.length < 100) break;
          offset += 100;
        }
        if (!cancelled) setExistingQueued(all);
      } catch {
        if (!cancelled) setExistingQueued([]);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, subdomain, page.id]);

  const handleDialogOpenChange = React.useCallback(
    (next: boolean) => {
      if (next) {
        onOpenChange(true);
        return;
      }
      if (pickerUploadCount > 0) {
        setLeaveGuardOpen(true);
        return;
      }
      // Nothing dismisses mid-queueing: not Cancel (disabled), not
      // backdrop, not Esc, not the close button.
      if (isQueueing || queueingLockRef.current) return;
      if (blocks.some((block) => !isBlockEmpty(block))) {
        setDiscardConfirmOpen(true);
        return;
      }
      onOpenChange(false);
    },
    [pickerUploadCount, isQueueing, blocks, onOpenChange]
  );

  const handlePickerUploadsChange = React.useCallback(
    (
      count: number,
      furthest: { name: string; progressPercent: number } | null
    ) => {
      setPickerUploadCount(count);
      setPickerFurthestUpload(furthest);
    },
    []
  );

  /** Rotate a block's key when it changes after a queue attempt. A
   *  block with no key has never been attempted: nothing to rotate. */
  const rotateKeyIfAttempted = React.useCallback((id: string) => {
    if (idempotencyKeysRef.current.has(id)) {
      idempotencyKeysRef.current.set(id, newKey());
    }
  }, []);

  /** Applies an edit, then restores the trailing-empty invariant:
   *  whenever the last block gains content, a fresh empty block
   *  appears below it. Editing a non-last block never appends. */
  const updateBlocks = React.useCallback(
    (updater: (prev: ComposerDraftBlock[]) => ComposerDraftBlock[]) => {
      setBlocks((prev) => {
        const next = updater(prev);
        const last = next[next.length - 1];
        if (last && !isBlockEmpty(last)) return [...next, newEmptyBlock()];
        return next;
      });
    },
    []
  );

  const updateBlockText = React.useCallback(
    (id: string, text: string) => {
      rotateKeyIfAttempted(id);
      updateBlocks((prev) =>
        prev.map((block) => (block.id === id ? { ...block, text } : block))
      );
    },
    [updateBlocks, rotateKeyIfAttempted]
  );

  /**
   * Attaching library media prefills the block's text from the
   * item's saved library caption — but only when the block's text
   * is still empty. Text the user already typed is never
   * overwritten, and removing media leaves the text as it stands
   * (the editor says so, so it never looks like a silent change).
   */
  const attachMediaToBlock = React.useCallback(
    (id: string, media: ComposerMedia) => {
      rotateKeyIfAttempted(id);
      updateBlocks((prev) =>
        prev.map((block) => {
          if (block.id !== id) return block;
          const caption = media.captionText;
          const text =
            block.text.trim().length === 0 &&
            caption !== null &&
            caption.trim().length > 0
              ? caption
              : block.text;
          return { ...block, media, text };
        })
      );
    },
    [updateBlocks, rotateKeyIfAttempted]
  );

  const removeMediaFromBlock = React.useCallback(
    (id: string) => {
      rotateKeyIfAttempted(id);
      setBlocks((prev) =>
        prev.map((block) => (block.id === id ? { ...block, media: null } : block))
      );
    },
    [rotateKeyIfAttempted]
  );

  const removeBlock = React.useCallback((id: string) => {
    setBlocks((prev) => {
      const next = prev.filter((block) => block.id !== id);
      return next.length === 0 ? [newEmptyBlock()] : next;
    });
  }, []);

  /** Appends new blocks ahead of the trailing empty block, capped at
   *  the batch cap: bulk adds beyond the cap are refused with a
   *  message, never silently dropped and never queued past the cap. */
  const appendBlocks = React.useCallback(
    (fresh: ComposerDraftBlock[]) => {
      if (fresh.length === 0) return;
      const currentReady = blocks.filter((block) => !isBlockEmpty(block)).length;
      const remaining = MAX_POSTS_PER_BATCH - currentReady;
      if (remaining <= 0) {
        toast.error(
          `You already have ${MAX_POSTS_PER_BATCH} posts in this batch. Remove some posts before adding more.`
        );
        return;
      }
      const taken = fresh.slice(0, remaining);
      if (taken.length < fresh.length) {
        toast.error(
          `Only ${MAX_POSTS_PER_BATCH} posts per batch — ${fresh.length - taken.length} post${fresh.length - taken.length === 1 ? '' : 's'} were not added.`
        );
      }
      setBlocks((prev) => {
        const last = prev[prev.length - 1];
        const base = last && isBlockEmpty(last) ? prev.slice(0, -1) : prev;
        return [...base, ...taken, newEmptyBlock()];
      });
    },
    [blocks]
  );

  const handleSingleAttach = React.useCallback(
    (media: ComposerMedia) => {
      if (pickerTargetId) attachMediaToBlock(pickerTargetId, media);
    },
    [pickerTargetId, attachMediaToBlock]
  );

  const handleMultiAttach = React.useCallback(
    (media: ComposerMedia[]) => {
      const fresh = media.map((item) => {
        const caption = item.captionText;
        return {
          ...newEmptyBlock(),
          media: item,
          text:
            caption !== null && caption.trim().length > 0 ? caption : '',
        };
      });
      appendBlocks(fresh);
      if (fresh.length > 0) {
        setSelectedId(fresh[0]!.id);
        setMobileView('editor');
      }
    },
    [appendBlocks]
  );

  const handleBulkTextAdd = React.useCallback(
    (texts: string[]) => {
      const fresh = texts.map((text) => ({ ...newEmptyBlock(), text }));
      appendBlocks(fresh);
      if (fresh.length > 0) {
        setSelectedId(fresh[0]!.id);
        setMobileView('editor');
      }
    },
    [appendBlocks]
  );

  const readyBlocks = React.useMemo(
    () => blocks.filter((block) => !isBlockEmpty(block)),
    [blocks]
  );

  const selectedBlock =
    blocks.find((block) => block.id === selectedId) ?? blocks[0] ?? null;

  /** Expected time for the selected ready block, computed over the
   *  posts already queued plus this batch in order — the same
   *  estimator the dashboard uses. Null when it cannot be computed
   *  (no slots, no ready block, fetch failed): the preview then
   *  falls back to the generic line instead of a wrong time. */
  const selectedEstimateLabel = React.useMemo(() => {
    if (!selectedBlock || isBlockEmpty(selectedBlock)) return null;
    if (estimateSlots.length === 0) return null;
    const batchPosts = readyBlocks.map((block) => {
      const item = toComposerEnqueueItem(block);
      return {
        id: block.id,
        format: item ? itemSlotFormat(item.kind, item.platformFormat) : 'text',
      };
    });
    const estimates = assignQueueEstimates({
      slots: estimateSlots,
      timezone: page.timezone ?? 'UTC',
      posts: [...existingQueued, ...batchPosts],
      now: new Date(),
    });
    const at = estimates.get(selectedBlock.id);
    if (!at) return null;
    return `Expected ${at.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`;
  }, [selectedBlock, readyBlocks, estimateSlots, existingQueued, page.timezone]);

  const handleAddAllToQueue = React.useCallback(async () => {
    // The ref lock is checked and set BEFORE any await: this is the
    // fix for the double-click window the old code left open.
    if (queueingLockRef.current || readyBlocks.length === 0) return;
    queueingLockRef.current = true;
    setIsQueueing(true);
    try {
      if (statusGate.blocked) {
        toast.error(statusGate.message ?? 'This Page cannot publish right now.');
        return;
      }
      if (readyBlocks.length > MAX_POSTS_PER_BATCH) {
        toast.error(
          `You can queue up to ${MAX_POSTS_PER_BATCH} posts at a time — you have ${readyBlocks.length}. Remove some posts and try again.`
        );
        return;
      }
      // Over-limit blocks refuse with a message naming EVERY
      // offending block — never silently truncated, never just the
      // first one. Labels match what the list shows ("Post N").
      const typeNouns = {
        text: 'text post',
        image: 'image post',
        reel: 'reel',
        video: 'video post',
      } as const;
      const overLimit = blocks
        .map((block, index) => {
          const isLast = index === blocks.length - 1;
          const label = isLast && isBlockEmpty(block) ? 'New post' : `Post ${index + 1}`;
          const limit = composerTextLimitForBlock(block);
          const over = block.text.length - limit;
          return { block, label, limit, over };
        })
        .filter((entry) => !isBlockEmpty(entry.block) && entry.over > 0);
      if (overLimit.length > 0) {
        const details = overLimit
          .map((entry) => {
            const derived = deriveComposerPostType({
              text: entry.block.text,
              mediaType: entry.block.media?.mediaType ?? null,
              aspectRatio: entry.block.media?.aspectRatio ?? null,
              width: entry.block.media?.width ?? null,
              height: entry.block.media?.height ?? null,
            });
            return `${entry.label} is over the ${entry.limit.toLocaleString('en-US')}-character ${typeNouns[derived]} limit by ${entry.over.toLocaleString('en-US')} characters`;
          })
          .join('; ');
        toast.error(`${details}. Shorten them and try again.`);
        return;
      }
      const parsed = ComposerDraftBlockSchema.array().safeParse(readyBlocks);
      if (!parsed.success) {
        toast.error('One of the posts is too long. Shorten it and try again.');
        return;
      }
      // No-posting-times pre-check: when the page has zero ACTIVE
      // posting times, send nothing at all — show the friendly message
      // with a button to the Posting Times tab instead of queueing
      // and failing with a raw server error. A slots-fetch failure
      // falls through to the queue attempt below (logged, not
      // swallowed): the server then surfaces the real error, so
      // queueing is never silently skipped.
      try {
        const slotsResponse = await api.get(
          buildTenantApiPath(subdomain, `/pages/${page.id}/slots`),
          { schema: ListQueueSlotsResponseSchema }
        );
        if (!slotsResponse.slots.some((slot) => slot.isActive)) {
          toast.error(
            'No posting times set yet. Add a posting time on the Posting Times tab, and your queued posts will go out automatically.',
            {
              action: {
                label: 'Go to Posting Times',
                onClick: () => {
                  // Drafts survive this: the next open restores them.
                  preserveDraftsRef.current = true;
                  onOpenChange(false);
                  const nextParams = new URLSearchParams(searchParams.toString());
                  nextParams.set('tab', 'calendar');
                  router.push(
                    `/tenant/${subdomain}/pages/${page.id}?${nextParams.toString()}`,
                    { scroll: false }
                  );
                },
              },
            }
          );
          return;
        }
      } catch (error) {
        console.error('Failed to check posting times before queueing', error);
      }
      let queued = 0;
      try {
        // Sequential, in order: each enqueue resolves the next vacant
        // posting time from the queue as it stands, so parallel posts
        // could otherwise claim the same time.
        setQueueProgress({ total: parsed.data.length, done: 0 });
        for (const [index, block] of parsed.data.entries()) {
          setQueueProgress({ total: parsed.data.length, done: index });
          const item = toComposerEnqueueItem(block);
          if (!item) continue;
          let idempotencyKey = idempotencyKeysRef.current.get(block.id);
          if (!idempotencyKey) {
            idempotencyKey = newKey();
            idempotencyKeysRef.current.set(block.id, idempotencyKey);
          }
          await api.post(
            buildTenantApiPath(subdomain, '/publishing/destination-queue'),
            {
              platform: 'facebook',
              destinationId: page.id,
              kind: item.kind,
              platformFormat: item.platformFormat,
              caption: item.caption,
              mediaItemIds: item.mediaItemIds,
              intent: 'queue',
            },
            {
              schema: DestinationEnqueueResponseSchema,
              headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
            }
          );
          queued += 1;
          setQueueProgress({ total: parsed.data.length, done: queued });
        }
        await queryClient.invalidateQueries({
          queryKey: queryKeys.tenant(subdomain).queue.all,
        });
        toast.success(
          queued === 1 ? 'Post added to queue.' : `${queued} posts added to queue.`
        );
        onOpenChange(false);
      } catch (error) {
        if (queued > 0) {
          // Settle: queueing is sequential and in order, and every
          // input is disabled while queueing, so the first `queued`
          // ready blocks are exactly the ones already queued (a
          // ready block is never skipped: toComposerEnqueueItem
          // returns null only for empty blocks, which readyBlocks
          // already excludes). Drop them, so a retry sends only the
          // blocks still unqueued instead of duplicating the queued
          // ones. Matched by id, not by reference — edits replace
          // block objects. The count toast below still reports the
          // pre-drop totals, so the user knows the dropped posts
          // are already safely queued.
          const queuedIds = new Set(readyBlocks.slice(0, queued).map((block) => block.id));
          setBlocks((prev) => {
            const next = prev.filter((block) => !queuedIds.has(block.id));
            return next.length === 0 ? [newEmptyBlock()] : next;
          });
        }
        toast.error(
          queued > 0
            ? `${queued} of ${readyBlocks.length} posts queued — then queueing failed: ${errorText(error, 'Please try again.')}`
            : `Couldn't add posts to the queue: ${errorText(error, 'Please try again.')}`
        );
      }
    } finally {
      queueingLockRef.current = false;
      setIsQueueing(false);
      setQueueProgress(null);
    }
  }, [blocks, readyBlocks, statusGate, subdomain, page.id, queryClient, onOpenChange, router, searchParams]);

  const monogram = (page.pageName || 'P').slice(0, 2).toUpperCase();
  const readyIndexById = new Map(readyBlocks.map((block, index) => [block.id, index]));

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent
          data-testid="create-posts-dialog"
          className="flex h-[90vh] max-h-[95vh] flex-col gap-0 overflow-hidden rounded-3xl p-0 shadow-modal sm:max-w-5xl lg:max-w-6xl"
        >
          {/* Visible header: identity, title, subtitle, count badge. */}
          <DialogHeader className="shrink-0 border-b border-line px-5 pt-5 pr-12 pb-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 items-start gap-3">
                {page.profilePictureUrl &&
                failedAvatarUrl !== page.profilePictureUrl ? (
                  <Image
                    src={page.profilePictureUrl}
                    alt={page.pageName}
                    width={40}
                    height={40}
                    onError={() =>
                      setFailedAvatarUrl(page.profilePictureUrl ?? '__error__')
                    }
                    className="size-10 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-brand-gold">
                    {monogram}
                  </span>
                )}
                <span className="min-w-0">
                  <DialogTitle className="text-lg font-bold text-ink">
                    Create posts
                  </DialogTitle>
                  <DialogDescription className="text-body text-ink-sub">
                    Write posts, attach media, and add them to the queue
                    for {page.pageName}. They go out at your next
                    posting time.
                  </DialogDescription>
                </span>
              </div>
              <span className="shrink-0 rounded-full border border-line px-2.5 py-1 text-metadata font-semibold text-ink-sub tabular-nums">
                {readyBlocks.length} / {MAX_POSTS_PER_BATCH} posts
              </span>
            </div>
          </DialogHeader>

          {statusGate.message ? (
            <div className="shrink-0 border-b border-line px-5 py-3 text-body text-ink-sub">
              {statusGate.message}
            </div>
          ) : null}

          {/* Split pane: list left, editor + preview right. */}
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            {/* Post list */}
            <div
              className={cn(
                'flex min-h-0 w-full flex-col border-b border-line md:w-[340px] md:shrink-0 md:border-r md:border-b-0',
                mobileView === 'editor' ? 'hidden md:flex' : 'flex'
              )}
            >
              <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line p-3">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid="create-posts-bulk-post-btn"
                  disabled={isQueueing}
                  onClick={() => {
                    setPickerMode('multi');
                    setPickerOpen(true);
                  }}
                >
                  Bulk Post
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid="create-posts-bulk-text-btn"
                  disabled={isQueueing}
                  onClick={() => setBulkTextOpen(true)}
                >
                  Bulk Text
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="create-posts-add-text-btn"
                  disabled={isQueueing}
                  onClick={() => {
                    const last = blocks[blocks.length - 1];
                    if (last) {
                      setSelectedId(last.id);
                      setMobileView('editor');
                    }
                  }}
                >
                  Add text post
                </Button>
              </div>

              <div className="shrink-0 border-b border-line p-3">
                <p className="text-metadata font-bold tracking-wide text-brand-gold uppercase">
                  Filename captions enabled
                </p>
                <p className="mt-1 text-metadata text-ink-sub">
                  New media captions are prefilled from filenames. Edit
                  captions in the editor — a file&apos;s caption only
                  fills an empty post.
                </p>
              </div>

              <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
                {blocks.map((block, index) => {
                  const isLast = index === blocks.length - 1;
                  const isDraft = isLast && isBlockEmpty(block);
                  const isSelected = block.id === selectedId;
                  const readyIndex = readyIndexById.get(block.id);
                  const progressState =
                    queueProgress && readyIndex !== undefined
                      ? readyIndex < queueProgress.done
                        ? 'Done'
                        : readyIndex === queueProgress.done
                          ? 'Adding…'
                          : 'Waiting'
                      : null;
                  const snippet = block.text.trim()
                    ? block.text.trim().split('\n')[0]!.slice(0, 80)
                    : block.media
                      ? block.media.name
                      : 'Empty post — write or attach to start';
                  return (
                    <div
                      key={block.id}
                      role="button"
                      tabIndex={0}
                      aria-label={isDraft ? 'New post' : `Post ${index + 1}`}
                      onClick={() => {
                        setSelectedId(block.id);
                        setMobileView('editor');
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedId(block.id);
                          setMobileView('editor');
                        }
                      }}
                      className={cn(
                        'flex w-full cursor-pointer items-start gap-3 rounded-md border p-3 text-left outline-none focus-visible:outline-2 focus-visible:outline-brand-gold',
                        isSelected
                          ? 'border-brand-gold bg-brand-gold/10 ring-1 ring-brand-gold'
                          : 'border-line bg-canvas hover:bg-hover'
                      )}
                    >
                      {block.media?.thumbnailUrl ? (
                        <Image
                          src={block.media.thumbnailUrl}
                          alt=""
                          width={44}
                          height={44}
                          className="size-11 shrink-0 rounded-md object-cover"
                        />
                      ) : (
                        <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-subtle text-body font-bold text-brand-gold">
                          {isDraft ? '+' : `${(readyIndex ?? index) + 1}`}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-semibold text-ink">
                          {isDraft ? 'New post' : `Post ${index + 1}`}
                        </span>
                        <span className="block truncate text-metadata text-ink-sub">
                          {snippet}
                        </span>
                        {progressState ? (
                          <span className="block text-metadata text-brand-gold">
                            {progressState}
                          </span>
                        ) : null}
                      </span>
                      {!isDraft && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          data-testid="create-posts-list-remove-btn"
                          aria-label={`Remove Post ${index + 1}`}
                          disabled={isQueueing}
                          onClick={(event) => {
                            event.stopPropagation();
                            removeBlock(block.id);
                          }}
                        >
                          <XIcon aria-hidden />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>

              {pickerUploadCount > 0 && (
                <div className="shrink-0 border-t border-line p-3">
                  <p
                    data-testid="create-posts-upload-status"
                    className="text-body text-ink-sub"
                  >
                    Uploading {pickerUploadCount} file
                    {pickerUploadCount === 1 ? '' : 's'}…
                    {pickerFurthestUpload && (
                      <span className="tabular-nums">
                        {' '}
                        {pickerFurthestUpload.name} ·{' '}
                        {pickerFurthestUpload.progressPercent}%
                      </span>
                    )}
                  </p>
                </div>
              )}
            </div>

            {/* Editor + preview */}
            <div
              className={cn(
                'flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-5',
                mobileView === 'list' ? 'hidden md:flex' : 'flex'
              )}
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start md:hidden"
                onClick={() => setMobileView('list')}
              >
                ← Back to posts
              </Button>
              {selectedBlock ? (
                <>
                  <PostBlock
                    block={selectedBlock}
                    label={
                      (() => {
                        const idx = blocks.findIndex(
                          (block) => block.id === selectedBlock.id
                        );
                        const isLast = idx === blocks.length - 1;
                        return isLast && isBlockEmpty(selectedBlock)
                          ? 'New post'
                          : `Post ${idx + 1}`;
                      })()
                    }
                    isDraft={
                      (() => {
                        const idx = blocks.findIndex(
                          (block) => block.id === selectedBlock.id
                        );
                        return idx === blocks.length - 1 && isBlockEmpty(selectedBlock);
                      })()
                    }
                    disabled={isQueueing}
                    onTextChange={(text) => updateBlockText(selectedBlock.id, text)}
                    onAttachRequest={() => {
                      setPickerMode('single');
                      setPickerTargetId(selectedBlock.id);
                      setPickerOpen(true);
                    }}
                    onRemoveMedia={() => removeMediaFromBlock(selectedBlock.id)}
                    onRemove={() => removeBlock(selectedBlock.id)}
                  />
                  <PostPreview
                    block={selectedBlock}
                    estimateLabel={selectedEstimateLabel}
                    disabled={isQueueing}
                    onAttachRequest={() => {
                      setPickerMode('single');
                      setPickerTargetId(selectedBlock.id);
                      setPickerOpen(true);
                    }}
                  />
                </>
              ) : (
                <p className="text-body text-ink-sub">
                  Pick a post on the left to edit it.
                </p>
              )}
            </div>
          </div>

          {/* Pinned footer: progress strip + actions. */}
          <div className="shrink-0 border-t border-line px-5 py-4">
            {queueProgress ? (
              <p
                data-testid="create-posts-progress"
                className="mb-3 text-body text-ink-sub tabular-nums"
              >
                Adding {Math.min(queueProgress.done + 1, queueProgress.total)}{' '}
                of {queueProgress.total} posts…
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                data-testid="create-posts-cancel-btn"
                disabled={isQueueing}
                onClick={() => handleDialogOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="create-posts-queue-btn"
                disabled={
                  readyBlocks.length === 0 || isQueueing || statusGate.blocked
                }
                onClick={() => void handleAddAllToQueue()}
              >
                {isQueueing
                  ? 'Adding to queue…'
                  : readyBlocks.length === 0
                    ? 'Add all to Queue'
                    : `Add all to Queue (${readyBlocks.length} post${readyBlocks.length === 1 ? '' : 's'})`}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <MediaLibraryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        subdomain={subdomain}
        pageName={page.pageName}
        mode={pickerMode}
        onSingleAttach={handleSingleAttach}
        onMultiAttach={handleMultiAttach}
        sessionKey={pickerSession}
        onUploadsActiveChange={handlePickerUploadsChange}
      />
      <BulkTextDialog
        open={bulkTextOpen}
        onOpenChange={setBulkTextOpen}
        onAdd={handleBulkTextAdd}
      />
      <LeavePageGuardDialog
        isOpen={leaveGuardOpen}
        activeUploadsCount={pickerUploadCount}
        furthestAlongFile={pickerFurthestUpload}
        onStay={() => setLeaveGuardOpen(false)}
        onLeaveAnyway={() => {
          setLeaveGuardOpen(false);
          onOpenChange(false);
        }}
      />
      <AlertDialog
        open={discardConfirmOpen}
        onOpenChange={setDiscardConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard these posts?</AlertDialogTitle>
            <AlertDialogDescription>
              You have posts that are not in the queue yet. Closing now
              will discard them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDiscardConfirmOpen(false);
                onOpenChange(false);
              }}
            >
              Discard posts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
