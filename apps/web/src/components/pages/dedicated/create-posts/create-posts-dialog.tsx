'use client';

/**
 * Create Posts dialogue for a dedicated Facebook Page.
 *
 * ONE layout, post blocks — never a single/bulk mode switcher.
 * The dialogue holds a list of post blocks in order, each with its
 * own text, its own attached media, and its own type derived from
 * its content (never picked). The list scrolls in a fixed-height
 * area, so the footer (Cancel / Add all to Queue) never moves as
 * posts are added.
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
 */

import * as React from 'react';
import Image from 'next/image';
import { useQueryClient } from '@tanstack/react-query';
import {
  ComposerDraftBlockSchema,
  composerTextLimitForBlock,
  deriveComposerPostType,
  DestinationEnqueueResponseSchema,
  toComposerEnqueueItem,
  type ComposerDraftBlock,
  type ComposerMedia,
} from '@fbuploadpro/contracts';
import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
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
  const [blocks, setBlocks] = React.useState<ComposerDraftBlock[]>([newEmptyBlock()]);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerMode, setPickerMode] = React.useState<'single' | 'multi'>('multi');
  const [pickerTargetId, setPickerTargetId] = React.useState<string | null>(null);
  const [bulkTextOpen, setBulkTextOpen] = React.useState(false);
  const [isQueueing, setIsQueueing] = React.useState(false);
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

  // Fresh dialogue on every open: a previous session's blocks never
  // leak into the next one.
  React.useEffect(() => {
    if (open) {
      setBlocks([newEmptyBlock()]);
      setPickerOpen(false);
      setBulkTextOpen(false);
      setPickerSession((prev) => prev + 1);
    }
  }, [open ]);

  // P2: while the picker reports live uploads, no dismissal path
  // (Cancel, backdrop, Esc, close button) may close the dialogue
  // unconditionally — that would unmount the picker mid-upload and
  // lose the blocks. Instead the library's leave guard asks first.
  const handleDialogOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next && pickerUploadCount > 0) {
        setLeaveGuardOpen(true);
        return;
      }
      onOpenChange(next);
    },
    [pickerUploadCount, onOpenChange]
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
      updateBlocks((prev) =>
        prev.map((block) => (block.id === id ? { ...block, text } : block))
      );
    },
    [updateBlocks]
  );

  /**
   * Attaching library media prefills the block's text from the
   * item's saved library caption — but only when the block's text
   * is still empty. Text the user already typed is never
   * overwritten, and removing media leaves the text as it stands.
   */
  const attachMediaToBlock = React.useCallback(
    (id: string, media: ComposerMedia) => {
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
    [updateBlocks]
  );

  const removeMediaFromBlock = React.useCallback((id: string) => {
    setBlocks((prev) =>
      prev.map((block) => (block.id === id ? { ...block, media: null } : block))
    );
  }, []);

  const removeBlock = React.useCallback((id: string) => {
    setBlocks((prev) => {
      const next = prev.filter((block) => block.id !== id);
      return next.length === 0 ? [newEmptyBlock()] : next;
    });
  }, []);

  /** Appends new blocks ahead of the trailing empty block. */
  const appendBlocks = React.useCallback((fresh: ComposerDraftBlock[]) => {
    if (fresh.length === 0) return;
    setBlocks((prev) => {
      const last = prev[prev.length - 1];
      const base = last && isBlockEmpty(last) ? prev.slice(0, -1) : prev;
      return [...base, ...fresh, newEmptyBlock()];
    });
  }, []);

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

  const handleAddAllToQueue = React.useCallback(async () => {
    if (readyBlocks.length === 0 || isQueueing) return;
    // Over-limit blocks refuse with a message naming the block and
    // its limit — never silently truncated, never silently dropped.
    // Labels match what the block shows ("Post N", never the
    // filtered ready-list position).
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
      const first = overLimit[0];
      const derived = deriveComposerPostType({
        text: first.block.text,
        mediaType: first.block.media?.mediaType ?? null,
        aspectRatio: first.block.media?.aspectRatio ?? null,
        width: first.block.media?.width ?? null,
        height: first.block.media?.height ?? null,
      });
      toast.error(
        `${first.label} is over the ${first.limit.toLocaleString('en-US')}-character ${typeNouns[derived]} limit by ${first.over.toLocaleString('en-US')} characters. Shorten it and try again.`
      );
      return;
    }
    const parsed = ComposerDraftBlockSchema.array().safeParse(readyBlocks);
    if (!parsed.success) {
      toast.error('One of the posts is too long. Shorten it and try again.');
      return;
    }
    setIsQueueing(true);
    let queued = 0;
    try {
      // Sequential, in order: each enqueue resolves the next vacant
      // posting time from the queue as it stands, so parallel posts
      // could otherwise claim the same time.
      for (const block of parsed.data) {
        const item = toComposerEnqueueItem(block);
        if (!item) continue;
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
          { schema: DestinationEnqueueResponseSchema }
        );
        queued += 1;
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.tenant(subdomain).queue.all,
      });
      toast.success(
        queued === 1 ? 'Post added to queue.' : `${queued} posts added to queue.`
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(
        queued > 0
          ? `${queued} of ${readyBlocks.length} posts queued — then queueing failed: ${errorText(error, 'Please try again.')}`
          : `Couldn't add posts to the queue: ${errorText(error, 'Please try again.')}`
      );
    } finally {
      setIsQueueing(false);
    }
  }, [blocks, readyBlocks, isQueueing, subdomain, page.id, queryClient, onOpenChange]);

  const monogram = (page.pageName || 'P').slice(0, 2).toUpperCase();

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent data-testid="create-posts-dialog">
          <DialogHeader>
            <DialogTitle className="sr-only">Create posts</DialogTitle>
          </DialogHeader>

          {/* Identity row + top-right bulk actions */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2.5">
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
                <span className="block truncate text-body font-semibold text-ink">
                  {page.pageName}
                </span>
                <span className="block text-metadata text-ink-sub">
                  Posting as this Page
                </span>
              </span>
            </div>
            <span className="flex shrink-0 gap-1.5">
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
            </span>
          </div>

          {/* Blocks list: fixed height, internal scroll — the footer
              below never moves, however many posts are added. */}
          <div className="flex h-80 flex-col gap-2.5 overflow-y-auto pr-1">
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
              disabled={readyBlocks.length === 0 || isQueueing}
              onClick={() => void handleAddAllToQueue()}
            >
              {isQueueing
                ? 'Adding to queue…'
                : readyBlocks.length === 0
                  ? 'Add all to Queue'
                  : `Add all to Queue (${readyBlocks.length} post${readyBlocks.length === 1 ? '' : 's'})`}
            </Button>
          </DialogFooter>
          <p className="text-metadata text-ink-sub">
            Goes out at your next posting time.
          </p>
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
    </>
  );
}
