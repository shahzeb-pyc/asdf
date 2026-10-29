'use client';

/**
 * Create Posts dialogue for a dedicated Facebook Page.
 *
 * ONE layout, post blocks — never a single/bulk mode switcher.
 * The dialogue holds a list of post blocks in order, each with its
 * own text, its own attached media, and its own type derived from
 * its content (never picked). The dialogue is a proper, tall
 * composer (90dvh, wider on desktop); the blocks list flexes with
 * that height and only scrolls once the dialogue's own height is
 * the limit, so at least three full post blocks are visible at
 * once on a normal desktop height, and the footer (Cancel / Add
 * all to Queue) stays pinned at the bottom, never scrolled away.
 *
 * Adding posts costs no per-post click:
 *   - Bulk Post (top right) opens the Media Library picker in
 *     multi-select mode; each chosen file becomes its own block.
 *   - Bulk Text (top right) takes one post per line and appends
 *     every line as a text block.
 *   - The trailing "New post" block is always present: typing or
 *     attaching in it turns it into a real post, and a fresh empty
 *     one appears below it.
 *
 * Queue only: there is no publish-now button, no scheduling field,
 * and no date/time picker anywhere here. "Add all to Queue" sends
 * every ready block in order through the existing destination
 * enqueue API with intent 'queue', so each post goes out at the
 * destination's next fitting posting time. There is no Create
 * Stories button: the stories flow is undecided, and a dead button
 * never ships.
 *
 * The header's Create Posts button opens this dialogue; the shell
 * owns that wiring, this component owns the dialogue itself.
 *
 * Functional fixes kept under the original layout (no redesign):
 * duplicate protection in two layers — a synchronous queueing
 * lock set before any await, plus the server's atomic idempotency
 * claim; a block's key rotates when its text or media changes
 * after a queue attempt, so an edit-after-enqueue retries the
 * EDITED post instead of replaying the original, while a pure
 * retry of an unedited block still replays safely; dismissing
 * with non-empty drafts asks first, nothing closes mid-queueing,
 * and following "Go to Posting Times" preserves drafts for the
 * next open; a plain-text page-status gate (blocked statuses
 * refuse, paused warns); and a 150-post batch guard with a plain
 * refusal message (no count badge in the header).
 *
 * Queueing never stays stuck: the button label and one plain
 * line show live progress ("Adding 2 of 4…", "Checking posting
 * times…"), and a Stop queueing button is available DURING
 * queueing. Every request in a queue run (the posting-times
 * pre-check and each enqueue) carries a 30-second timeout and an
 * AbortController, so a hung request ends the run instead of
 * freezing the dialogue forever; Stop aborts the in-flight
 * request immediately. Aborting is duplicate-safe because the
 * timed-out/aborted block is kept in the dialogue with its SAME
 * idempotency key: if the server did insert it, the retry replays
 * the original row (lookup, or the queue-by-key heal path); if it
 * did not insert, the retry executes fresh once any processing
 * sentinel has expired (at most 5 minutes, surfaced as a plain
 * 409 "already being added" message, never a duplicate). Every
 * failure path ends the same way: lock released, button
 * re-enabled, progress cleared, a plain message, failed blocks
 * kept for retry.
 */

import * as React from 'react';
import { ImageIcon, ListIcon, XIcon } from 'lucide-react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  ComposerDraftBlockSchema,
  composerTextLimitForBlock,
  deriveComposerPostType,
  DestinationEnqueueResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  toComposerEnqueueItem,
  type ComposerDraftBlock,
  type ComposerMedia,
} from '@fbuploadpro/contracts';
import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import { ListQueueSlotsResponseSchema } from '@/lib/api/schemas/queue';
import { queryKeys } from '@/lib/data/query-keys';
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
  DialogClose,
  DialogContent,
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

export interface CreatePostsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subdomain: string;
  page: FacebookPageItem;
}

function newEmptyBlock(): ComposerDraftBlock {
  return {
    id: typeof crypto !== 'undefined' ? crypto.randomUUID() : `block-${Date.now()}`,
    text: '',
    media: null,
  };
}

/** Batch guard only: it stops a 500-item Select All from firing
 *  500 sequential enqueue requests. Enforced with a plain refusal
 *  message, never silently dropped — and deliberately NOT shown as
 *  a header badge (that was part of the rejected redesign). */
const MAX_POSTS_PER_BATCH = 150;

/**
 * Idempotency keys must be UUIDs (the server rejects anything else),
 * so this never falls back to an insecure generator: randomUUID when
 * available, otherwise a v4 UUID built from getRandomValues. If
 * neither is available, throw rather than minting a key that the
 * server would reject — or, worse, that could collide.
 */
function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error('Secure random number generation is unavailable');
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

function isBlockEmpty(block: ComposerDraftBlock): boolean {
  return block.text.trim().length === 0 && block.media === null;
}

function errorText(error: unknown, fallback: string): string {
  if (isApiError(error) && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
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
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerMode, setPickerMode] = React.useState<'single' | 'multi'>('multi');
  const [pickerTargetId, setPickerTargetId] = React.useState<string | null>(null);
  const [bulkTextOpen, setBulkTextOpen] = React.useState(false);
  const [isQueueing, setIsQueueing] = React.useState(false);
  // Idempotency keys, one stable key per post block for the life of
  // this dialogue session. A block retried after a response-lost
  // enqueue reuses its key, so the server returns the ORIGINAL
  // queue item instead of a second row — unless the block was
  // edited after the attempt, in which case its key rotates (see
  // rotateKeyIfAttempted). Keys are keyed by block id and die with
  // the dialogue: a block drafted in a new session is a new post.
  const idempotencyKeysRef = React.useRef(new Map<string, string>());
  // Synchronous queueing lock: state updates are async, so a second
  // click arriving before the next render (during the slots await)
  // would still see isQueueing === false. The ref is set before
  // any await, so that window does not exist.
  const queueingLockRef = React.useRef(false);
  // Live queueing progress, shown as plain text (button label +
  // one line above the footer) — never a progress panel or strip
  // box. `phase` is 'checking' while the posting-times pre-check
  // runs (before any post queues) and 'queueing' during the loop.
  const [queueProgress, setQueueProgress] = React.useState<{
    done: number;
    total: number;
    phase: 'checking' | 'queueing';
  } | null>(null);
  // Stop queueing: set by the Stop button, read by the loop.
  // Stop ALSO aborts the in-flight request immediately (see
  // queueAbortControllerRef) — the previous between-posts-only
  // design is what left the dialogue genuinely stuck when one
  // request hung, because neither the slots fetch nor any enqueue
  // carried a timeout or an AbortSignal.
  const abortQueueingRef = React.useRef(false);
  const [abortRequested, setAbortRequested] = React.useState(false);
  // Per-request timeout + abort for a queue run. 30 seconds per
  // request (slots pre-check, each enqueue) is long enough for a
  // normal round trip and short enough that a hung request cannot
  // freeze the dialogue. The controller for the request currently
  // in flight, if any; Stop aborts it, the timeout aborts it when
  // it fires. abortReasonRef distinguishes the two, because the
  // handling differs: a user Stop is not an error, a timeout is.
  const queueAbortControllerRef = React.useRef<AbortController | null>(null);
  const abortReasonRef = React.useRef<'stop' | 'timeout' | null>(null);
  const QUEUE_REQUEST_TIMEOUT_MS = 30_000;
  // Set by the "Go to Posting Times" action: the next open restores
  // the drafts instead of resetting to one empty block.
  const preserveDraftsRef = React.useRef(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = React.useState(false);
  const [failedAvatarUrl, setFailedAvatarUrl] = React.useState<string | null>(null);
  // P11: the picker's session key — bumped on every fresh dialogue
  // open so the picker resets then, and only then.
  const [pickerSession, setPickerSession] = React.useState(0);
  // P2: live upload state reported by the picker, for the leave
  // guard below. Zero whenever the picker is closed or settled.
  const [pickerUploadCount, setPickerUploadCount] = React.useState(0);
  const [pickerFurthestUpload, setPickerFurthestUpload] = React.useState<{
    name: string;
    progressPercent: number;
  } | null>(null);
  const [leaveGuardOpen, setLeaveGuardOpen] = React.useState(false);

  const statusGate = pageStatusGate(page.status);

  // Fresh dialogue on every open: a previous session's blocks never
  // leak into the next one — unless the user is returning from the
  // "Go to Posting Times" action, in which case the drafts survive.
  React.useEffect(() => {
    if (open) {
      if (!preserveDraftsRef.current) {
        setBlocks([newEmptyBlock()]);
        idempotencyKeysRef.current.clear();
      }
      preserveDraftsRef.current = false;
      setPickerOpen(false);
      setBulkTextOpen(false);
      setPickerSession((prev) => prev + 1);
    }
  }, [open ]);

  // P2: while the picker reports live uploads, no dismissal path
  // (Cancel, backdrop, Esc, close button) may close the dialogue
  // unconditionally — that would unmount the picker mid-upload and
  // lose the blocks. Instead the library's leave guard asks first.
  // Draft-loss guard (same paths): nothing dismisses mid-queueing,
  // and dismissing with non-empty drafts asks first.
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
   * overwritten, and removing media leaves the text as it stands.
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

  /** Appends new blocks ahead of the trailing empty block, capped
   *  at the batch cap: bulk adds beyond the cap are refused with
   *  a message, never silently dropped and never queued past it. */
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
      appendBlocks(
        media.map((item) => {
          // New blocks start empty, so a saved library caption (or a
          // device upload's filename-derived caption) becomes the
          // block's text; items without one start with empty text.
          const caption = item.captionText;
          return {
            ...newEmptyBlock(),
            media: item,
            text:
              caption !== null && caption.trim().length > 0 ? caption : '',
          };
        })
      );
    },
    [appendBlocks]
  );

  const handleBulkTextAdd = React.useCallback(
    (texts: string[]) => {
      appendBlocks(texts.map((text) => ({ ...newEmptyBlock(), text })));
    },
    [appendBlocks]
  );

  const readyBlocks = React.useMemo(
    () => blocks.filter((block) => !isBlockEmpty(block)),
    [blocks]
  );

  /** Stop queueing, the safe way out while a run is in flight.
   *  This sets the flag AND aborts the in-flight request at once:
   *  without the abort, a hung request left Stop as "Stopping…"
   *  forever — the exact stuck state being fixed. Aborting is
   *  duplicate-safe (see the header comment): the aborted block
   *  is kept with its same key, so a retry replays it if the
   *  server did insert it, or executes fresh (after any sentinel
   *  expiry) if it did not. Dismiss paths (Cancel, backdrop, Esc,
   *  X) stay blocked mid-queueing — Stop is the exit, so a stopped
   *  run cannot strand a request. */
  const handleStopQueueing = React.useCallback(() => {
    abortQueueingRef.current = true;
    abortReasonRef.current = 'stop';
    queueAbortControllerRef.current?.abort();
    setAbortRequested(true);
  }, []);

  /** Start one timed request in a queue run. Returns its signal
   *  and a `done` that must be called when the request settles
   *  (success or failure) so the timer cannot fire after the fact
   *  and abort an unrelated later request. The timeout sets the
   *  reason BEFORE aborting, so the catch can tell a timeout from
   *  a user Stop. */
  const startTimedRequest = React.useCallback(() => {
    const controller = new AbortController();
    queueAbortControllerRef.current = controller;
    const timer = setTimeout(() => {
      if (abortReasonRef.current === null) {
        abortReasonRef.current = 'timeout';
      }
      controller.abort();
    }, QUEUE_REQUEST_TIMEOUT_MS);
    return {
      signal: controller.signal,
      done: () => {
        clearTimeout(timer);
        if (queueAbortControllerRef.current === controller) {
          queueAbortControllerRef.current = null;
        }
      },
    };
  }, [QUEUE_REQUEST_TIMEOUT_MS]);

  const handleAddAllToQueue = React.useCallback(async () => {
    // The ref lock is checked and set BEFORE any await: this is the
    // fix for the double-click window the old code left open.
    if (queueingLockRef.current || readyBlocks.length === 0) return;
    queueingLockRef.current = true;
    abortQueueingRef.current = false;
    abortReasonRef.current = null;
    queueAbortControllerRef.current = null;
    setAbortRequested(false);
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
    // first one. Labels match what the block shows ("Post N",
    // never the filtered ready-list position).
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
    // queueing is never silently skipped. That fall-through does
    // NOT apply to a timeout or a user Stop: those end the run
    // here (see the catch), because falling through would start
    // queueing after the user already asked to stop, or after a
    // wait that already proved the backend unresponsive.
    // This fetch carries the 30-second timeout + AbortSignal:
    // before that, a hung slots response froze the dialogue with
    // the button on "Checking posting times…" and Stop stuck on
    // "Stopping…" — the run could not end at all.
    setQueueProgress({
      done: 0,
      total: readyBlocks.length,
      phase: 'checking',
    });
    const slotsRequest = startTimedRequest();
    try {
      const slotsResponse = await api.get(
        buildTenantApiPath(subdomain, `/pages/${page.id}/slots`),
        { schema: ListQueueSlotsResponseSchema, signal: slotsRequest.signal }
      );
      slotsRequest.done();
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
      slotsRequest.done();
      if (abortReasonRef.current === 'timeout') {
        // Timed-out pre-check: end the run, do NOT fall through
        // to queueing — the backend just proved unresponsive, and
        // no post has queued yet, so nothing is lost or duplicated.
        toast.error(
          'Checking posting times timed out (30 seconds) — no posts were added. Check your connection and try again.'
        );
        return;
      }
      if (abortReasonRef.current === 'stop') {
        // User Stop aborted the pre-check: fall through to the
        // stopped branch below, which reports "no posts added".
      } else {
        console.error('Failed to check posting times before queueing', error);
      }
    }
    // Stop pressed during the pre-check: the in-flight slots fetch
    // is now aborted at once, and no post has queued yet, so
    // stopping here queues nothing.
    if (abortQueueingRef.current) {
      toast.info('Queueing stopped — no posts were added.');
      return;
    }
    let queued = 0;
    try {
      // Sequential, in order: each enqueue resolves the next vacant
      // posting time from the queue as it stands, so parallel posts
      // could otherwise claim the same time.
      for (const block of parsed.data) {
        // Stop is also checked BETWEEN posts: if Stop was pressed
        // after the previous post finished, the loop ends here
        // without starting another request. If Stop was pressed
        // during a request, that request's abort already rejected
        // it into the catch below — either way the aborted block
        // is kept with its same key, so retry is duplicate-safe.
        if (abortQueueingRef.current) break;
        const item = toComposerEnqueueItem(block);
        if (!item) continue;
        let idempotencyKey = idempotencyKeysRef.current.get(block.id);
        if (!idempotencyKey) {
          idempotencyKey = crypto.randomUUID();
          idempotencyKeysRef.current.set(block.id, idempotencyKey);
        }
        setQueueProgress({
          done: queued,
          total: readyBlocks.length,
          phase: 'queueing',
        });
        // Each enqueue carries the same 30-second timeout +
        // AbortSignal as the pre-check. The finally is load-bearing:
        // without it, a failed request's timer could fire during a
        // later request and misreport that later request as timed
        // out. On abort/timeout the await rejects and the outer
        // catch settles the run — the aborted block itself is kept
        // with its same key (see the catch), so retry is safe.
        const enqueueRequest = startTimedRequest();
        try {
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
              signal: enqueueRequest.signal,
            }
          );
        } finally {
          enqueueRequest.done();
        }
        queued += 1;
        setQueueProgress({
          done: queued,
          total: readyBlocks.length,
          phase: 'queueing',
        });
      }
      if (abortQueueingRef.current) {
        // Stopped run: exactly like a partial success — posts
        // already queued leave the draft, the rest stay for retry,
        // and the dialogue stays open with the button re-enabled
        // (outer finally). Never treated as an error, never closed.
        if (queued > 0) {
          const queuedIds = new Set(
            readyBlocks.slice(0, queued).map((block) => block.id)
          );
          setBlocks((prev) => {
            const next = prev.filter((block) => !queuedIds.has(block.id));
            return next.length === 0 ? [newEmptyBlock()] : next;
          });
          await queryClient.invalidateQueries({
            queryKey: queryKeys.tenant(subdomain).queue.all,
          });
          toast.info(
            `Stopped — ${queued} post${queued === 1 ? '' : 's'} added to queue. The rest are still here.`
          );
        } else {
          toast.info('Queueing stopped — no posts were added.');
        }
      } else {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.tenant(subdomain).queue.all,
        });
        toast.success(
          queued === 1 ? 'Post added to queue.' : `${queued} posts added to queue.`
        );
        onOpenChange(false);
      }
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
      // A user Stop that aborted the in-flight request is NOT an
      // error: the aborted block is kept (it was not counted in
      // `queued`, and the settle above dropped only the queued
      // ones), and the run ends like the between-posts stop —
      // with an info toast, never an error toast. Likewise a
      // timeout is a bounded failure, not a stuck state: the
      // timed-out block (post queued + 1) is kept with its SAME
      // key, so retrying it replays the original row if the
      // server did insert it, or executes fresh if it did not
      // (a surviving processing sentinel, at most 5 minutes,
      // surfaces as the 409 message below on an immediate retry
      // — never as a duplicate).
      if (abortReasonRef.current === 'stop') {
        if (queued > 0) {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.tenant(subdomain).queue.all,
          });
          toast.info(
            `Stopped — ${queued} post${queued === 1 ? '' : 's'} added to queue. The rest are still here.`
          );
        } else {
          toast.info('Queueing stopped — no posts were added.');
        }
      } else if (abortReasonRef.current === 'timeout') {
        if (queued > 0) {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.tenant(subdomain).queue.all,
          });
        }
        toast.error(
          queued > 0
            ? `Adding post ${queued + 1} of ${readyBlocks.length} timed out after 30 seconds — ${queued} post${queued === 1 ? '' : 's'} queued, the rest are still here. Retry the timed-out post; retrying will not duplicate it.`
            : `Adding post 1 of ${readyBlocks.length} timed out after 30 seconds — no posts were added. Check your connection and try again; retrying will not duplicate it.`
        );
      } else {
        // 409 IDEMPOTENCY_IN_PROGRESS is not a stuck state: the
        // post is being added by another in-flight request (another
        // tab/device), the button re-enables via finally below, and
        // a retry replays instead of duplicating. Say so plainly,
        // instead of a generic failure that invites repeated clicks
        // into the same 5-minute processing window.
        const isAlreadyAdding =
          isApiError(error) && error.code === 'IDEMPOTENCY_IN_PROGRESS';
        toast.error(
          isAlreadyAdding
            ? queued > 0
              ? `${queued} of ${readyBlocks.length} posts queued — the next post is already being added (it may be queueing from another tab). Wait a moment, then retry; retrying will not duplicate it.`
              : 'This post is already being added — it may be queueing from another tab. Wait a moment and try again; retrying will not duplicate it.'
            : queued > 0
              ? `${queued} of ${readyBlocks.length} posts queued — then queueing failed: ${errorText(error, 'Please try again.')}`
              : `Couldn't add posts to the queue: ${errorText(error, 'Please try again.')}`
        );
      }
    } finally {
      setIsQueueing(false);
    }
    } finally {
      // Every exit — success, failure, stop, timeout, early
      // return — ends here: lock released, button re-enabled,
      // progress cleared, abort state reset. No path may leave
      // isQueueing true, the lock held, or a stale abort reason
      // that would mislabel the next run's failure.
      queueingLockRef.current = false;
      abortReasonRef.current = null;
      queueAbortControllerRef.current = null;
      setIsQueueing(false);
      setQueueProgress(null);
      setAbortRequested(false);
    }
  }, [blocks, readyBlocks, statusGate, subdomain, page.id, queryClient, onOpenChange, router, searchParams, startTimedRequest]);

  const monogram = (page.pageName || 'P').slice(0, 2).toUpperCase();

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent
          data-testid="create-posts-dialog"
          showCloseButton={false}
          className="flex h-[90dvh] max-h-[90dvh] flex-col gap-3 sm:max-w-2xl lg:max-w-3xl"
        >
          {/* contents: the sr-only title must not take a flex row
              (and its gap) in this column layout. */}
          <DialogHeader className="contents">
            <DialogTitle className="sr-only">Create posts</DialogTitle>
          </DialogHeader>

          {/* Header section, flat on the dialog surface: identity on
              the left, a ghost toolbar (bulk actions + close) on the
              right, one hairline divider below the whole section.
              No boxed identity card, no header panel, no dark
              action boxes — the same flat language as the posts.
              The close button is in flow here (not the shared
              dialog's absolute corner button, which overlapped the
              actions and could clip at the dialog edge); it still
              goes through the dialog's onOpenChange handler, so the
              draft-loss confirmation and queueing lock are kept. */}
          <div className="shrink-0 border-b border-line pb-4">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                {page.profilePictureUrl &&
                failedAvatarUrl !== page.profilePictureUrl ? (
                  <Image
                    src={page.profilePictureUrl}
                    alt={page.pageName}
                    width={44}
                    height={44}
                    onError={() =>
                      setFailedAvatarUrl(page.profilePictureUrl ?? '__error__')
                    }
                    className="size-11 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-brand-gold">
                    {monogram}
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-body font-semibold text-ink">
                    {page.pageName}
                  </span>
                  <span className="block text-metadata text-ink-sub">
                    Posting as this Page
                  </span>
                </span>
              </div>
              <span className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="create-posts-bulk-post-btn"
                  disabled={isQueueing}
                  onClick={() => {
                    setPickerMode('multi');
                    setPickerOpen(true);
                  }}
                >
                  <ImageIcon aria-hidden />
                  Bulk Post
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="create-posts-bulk-text-btn"
                  disabled={isQueueing}
                  onClick={() => setBulkTextOpen(true)}
                >
                  <ListIcon aria-hidden />
                  Bulk Text
                </Button>
                <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-line" />
                <DialogClose asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close"
                    disabled={isQueueing}
                  >
                    <XIcon aria-hidden />
                  </Button>
                </DialogClose>
              </span>
            </div>

            {statusGate.message ? (
              <p className="pt-3 text-body text-ink-sub">{statusGate.message}</p>
            ) : null}
          </div>

          {/* Blocks list: flexes with the dialogue height, internal
              scroll only once the dialogue's own height is the
              limit — the footer below stays pinned, however many
              posts are added. Posts are separated by a single
              hairline divider (divide-y), not by per-post cards:
              the dialogue surface is the only surface. */}
          <div className="flex min-h-0 flex-1 flex-col divide-y divide-line overflow-y-auto pr-1">
            {blocks.map((block, index) => {
              const isLast = index === blocks.length - 1;
              const isDraft = isLast && isBlockEmpty(block);
              return (
                <PostBlock
                  key={block.id}
                  block={block}
                  label={isDraft ? 'New post' : `Post ${index + 1}`}
                  isDraft={isDraft}
                  disabled={isQueueing}
                  onTextChange={(text) => updateBlockText(block.id, text)}
                  onAttachRequest={() => {
                    setPickerMode('single');
                    setPickerTargetId(block.id);
                    setPickerOpen(true);
                  }}
                  onRemoveMedia={() => removeMediaFromBlock(block.id)}
                  onRemove={() => removeBlock(block.id)}
                />
              );
            })}
          </div>

          {/* Live progress as one plain text line — no panel, no
              strip box, nothing that looks like a new UI element.
              It sits above the pinned footer while queueing and
              disappears with the run (outer finally clears it). */}
          {isQueueing && queueProgress ? (
            <p
              aria-live="polite"
              className="shrink-0 text-metadata text-ink-sub"
            >
              {abortRequested
                ? 'Stopping…'
                : queueProgress.phase === 'checking'
                  ? 'Checking posting times…'
                  : `Adding post ${Math.min(queueProgress.done + 1, queueProgress.total)} of ${queueProgress.total}…`}
              {!abortRequested
                ? ' Use Stop queueing to stop now.'
                : ''}
            </p>
          ) : null}

          <DialogFooter className="shrink-0">
            {isQueueing ? (
              <Button
                type="button"
                variant="secondary"
                data-testid="create-posts-stop-queue-btn"
                disabled={abortRequested}
                onClick={handleStopQueueing}
              >
                {abortRequested ? 'Stopping…' : 'Stop queueing'}
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                data-testid="create-posts-cancel-btn"
                onClick={() => handleDialogOpenChange(false)}
              >
                Cancel
              </Button>
            )}
            <Button
              type="button"
              data-testid="create-posts-queue-btn"
              disabled={readyBlocks.length === 0 || isQueueing || statusGate.blocked}
              onClick={() => void handleAddAllToQueue()}
            >
              {isQueueing
                ? abortRequested
                  ? 'Stopping…'
                  : queueProgress?.phase === 'checking'
                    ? 'Checking posting times…'
                    : queueProgress
                      ? `Adding ${Math.min(queueProgress.done + 1, queueProgress.total)} of ${queueProgress.total}…`
                      : 'Adding to queue…'
                : readyBlocks.length === 0
                  ? 'Add all to Queue'
                  : `Add all to Queue (${readyBlocks.length} post${readyBlocks.length === 1 ? '' : 's'})`}
            </Button>
          </DialogFooter>
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
