'use client';

/**
 * Threads Create Post dialog for one In-app Schedule account.
 *
 * Only post types Threads actually supports are offered: text, image,
 * video, carousel. No story, no reel as a separate format, no first
 * comment — those are not offered at all, never silently dropped.
 * Validation runs through threads-create-validation before anything
 * is sent, so an over-limit caption or a wrong media count blocks
 * submission in the dialog with a plain message. Submission reuses
 * the unified destination-enqueue endpoint (platform `threads`) with
 * an Idempotency-Key, so a lost response retried with the same key
 * replays instead of queueing a duplicate.
 */
import * as React from 'react';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, buildTenantApiPath } from '@/lib/api';
import {
  DestinationEnqueueResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  THREADS_SCHEDULE_FORMATS,
  threadsWeightedTextLength,
  type ThreadsScheduleFormat,
} from '@fbuploadpro/contracts';
import { queryKeys } from '@/lib/data';
import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Input } from '@/components/shared/ui/input';
import { Textarea } from '@/components/shared/ui/textarea';
import { Toast, toast } from '@/components/shared/ui/toast';
import { MediaLibraryPicker } from '@/components/pages/dedicated/create-posts/media-library-picker';
import type { ComposerMedia } from '@fbuploadpro/contracts';

import {
  THREADS_REPLY_CONTROL_LABELS,
  validateThreadsCreateDraft,
  type ThreadsCreateIntent,
} from './threads-create-validation';

const TYPE_LABELS: Record<ThreadsScheduleFormat, string> = {
  text: 'Text',
  image: 'Image',
  video: 'Video',
  carousel: 'Carousel',
};

const INTENT_LABELS: Record<ThreadsCreateIntent, string> = {
  now: 'Post now',
  scheduled: 'Schedule for a date',
  queue: 'Add to queue',
};

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  throw new Error('Could not create a safe submission key. Try again.');
}

export interface ThreadsCreatePostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subdomain: string;
  scheduleId: string;
  accountName: string;
  /** Plain reason the composer must stay closed (paused, expired …). */
  disabledReason: string | null;
}

export function ThreadsCreatePostDialog({
  open,
  onOpenChange,
  subdomain,
  scheduleId,
  accountName,
  disabledReason,
}: Readonly<ThreadsCreatePostDialogProps>) {
  const queryClient = useQueryClient();
  const [type, setType] = React.useState<ThreadsScheduleFormat>('text');
  const [caption, setCaption] = React.useState('');
  const [media, setMedia] = React.useState<ComposerMedia[]>([]);
  const [replyControl, setReplyControl] = React.useState('everyone');
  const [topicTag, setTopicTag] = React.useState('');
  const [intent, setIntent] = React.useState<ThreadsCreateIntent>('queue');
  const [scheduledAt, setScheduledAt] = React.useState('');
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [pickerSession, setPickerSession] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  const reset = React.useCallback(() => {
    setType('text');
    setCaption('');
    setMedia([]);
    setReplyControl('everyone');
    setTopicTag('');
    setIntent('queue');
    setScheduledAt('');
    setError(null);
  }, []);

  const submitMutation = useMutation({
    mutationFn: async () => {
      const draftError = validateThreadsCreateDraft({
        type,
        caption,
        media: media.map((item) => ({
          id: item.id,
          mediaType: item.mediaType,
          url: item.url,
        })),
        replyControl,
        topicTag,
        intent,
        scheduledAt,
      });
      if (draftError) throw new Error(draftError);
      const platformOptions: Record<string, unknown> = {
        replyControl,
      };
      const trimmedTopic = topicTag.trim();
      if (trimmedTopic) platformOptions['topicTag'] = trimmedTopic;
      if (type === 'carousel') {
        platformOptions['carouselItems'] = media.map((item) => ({
          mediaUrl: item.url,
          mediaType: item.mediaType,
        }));
      }
      const body: Record<string, unknown> = {
        platform: 'threads',
        destinationId: scheduleId,
        kind: type,
        platformFormat: type,
        caption,
        mediaItemIds: media.map((item) => item.id),
        intent,
        platformOptions,
      };
      if (intent === 'scheduled') {
        body['scheduledAt'] = new Date(scheduledAt).toISOString();
      }
      return api.post(
        buildTenantApiPath(subdomain, '/publishing/destination-queue'),
        body,
        {
          schema: DestinationEnqueueResponseSchema,
          headers: { [IDEMPOTENCY_KEY_HEADER]: newIdempotencyKey() },
        }
      );
    },
    onSuccess: async () => {
      const tenant = queryKeys.tenant(subdomain);
      await queryClient.invalidateQueries({
        queryKey: tenant.threadsSchedule.queue(scheduleId),
      });
      await queryClient.invalidateQueries({
        queryKey: tenant.threadsSchedule.detail(scheduleId),
      });
      toast.success(
        intent === 'now'
          ? 'Post added — it will publish on the next pass.'
          : intent === 'scheduled'
            ? 'Post scheduled.'
            : 'Post added to the queue.'
      );
      reset();
      onOpenChange(false);
    },
    onError: (err: unknown) => {
      setError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not add this post. Try again.'
      );
    },
  });

  const captionWeight = threadsWeightedTextLength(caption);
  const singleMode = type === 'image' || type === 'video';

  return (
    <>
      <Toast />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) reset();
          onOpenChange(next);
        }}
      >
        <DialogContent data-testid="threads-create-post-dialog" className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create post</DialogTitle>
            <DialogDescription>
              Create a Threads post for {accountName}. Only post types
              Threads supports are shown here.
            </DialogDescription>
          </DialogHeader>

          {disabledReason ? (
            <p role="alert" className="text-body text-ink-dim">
              {disabledReason}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Post type">
                {THREADS_SCHEDULE_FORMATS.map((format) => (
                  <Button
                    key={format}
                    type="button"
                    variant={type === format ? 'default' : 'outline'}
                    onClick={() => {
                      setType(format);
                      setMedia([]);
                      setError(null);
                    }}
                  >
                    {TYPE_LABELS[format]}
                  </Button>
                ))}
              </div>

              <div>
                <label className="mb-1 block text-body text-ink-dim" htmlFor="threads-create-caption">
                  Caption
                </label>
                <Textarea
                  id="threads-create-caption"
                  data-testid="threads-create-caption"
                  value={caption}
                  onChange={(event) => setCaption(event.target.value)}
                  rows={5}
                  placeholder="Write your post…"
                />
                <p className="mt-1 text-metadata text-ink-dim" aria-live="polite">
                  {captionWeight} of 500 characters used
                </p>
              </div>

              {type !== 'text' ? (
                <div>
                  <p className="mb-1 text-body text-ink-dim">
                    Media from the Media Library
                    {singleMode
                      ? ' — exactly one photo or video'
                      : ' — 2 to 20 photos or videos'}
                  </p>
                  {media.length > 0 ? (
                    <ul className="mb-2 flex flex-col gap-1">
                      {media.map((item) => (
                        <li
                          key={item.id}
                          className="flex items-center justify-between gap-2 text-body text-ink"
                        >
                          <span className="truncate">
                            {item.name} ({item.mediaType})
                          </span>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() =>
                              setMedia((prev) => prev.filter((m) => m.id !== item.id))
                            }
                          >
                            Remove
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mb-2 text-body text-ink-dim">No media attached yet.</p>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setPickerSession((n) => n + 1);
                      setPickerOpen(true);
                    }}
                  >
                    Choose from Media Library
                  </Button>
                </div>
              ) : null}

              <div className="flex flex-col gap-3 sm:flex-row">
                <label className="flex flex-1 flex-col gap-1 text-body text-ink-dim">
                  Who can reply
                  <select
                    aria-label="Who can reply"
                    value={replyControl}
                    onChange={(event) => setReplyControl(event.target.value)}
                    className="rounded-sm border border-line bg-panel px-2 py-2 text-body text-ink"
                  >
                    {Object.entries(THREADS_REPLY_CONTROL_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-1 flex-col gap-1 text-body text-ink-dim">
                  Topic tag (optional)
                  <Input
                    aria-label="Topic tag"
                    value={topicTag}
                    onChange={(event) => setTopicTag(event.target.value)}
                    placeholder="e.g. photography"
                    maxLength={50}
                  />
                </label>
              </div>

              <div className="flex flex-wrap gap-2" role="group" aria-label="How to post">
                {(Object.keys(INTENT_LABELS) as ThreadsCreateIntent[]).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    variant={intent === value ? 'default' : 'outline'}
                    onClick={() => setIntent(value)}
                  >
                    {INTENT_LABELS[value]}
                  </Button>
                ))}
              </div>

              {intent === 'scheduled' ? (
                <label className="flex flex-col gap-1 text-body text-ink-dim">
                  Date and time
                  <Input
                    type="datetime-local"
                    aria-label="Scheduled date and time"
                    value={scheduledAt}
                    onChange={(event) => setScheduledAt(event.target.value)}
                  />
                </label>
              ) : null}

              {error ? (
                <p role="alert" className="text-body">
                  {error}
                </p>
              ) : null}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="threads-create-submit"
              disabled={disabledReason !== null || submitMutation.isPending}
              onClick={() => submitMutation.mutate()}
            >
              {submitMutation.isPending ? 'Adding…' : 'Add post'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MediaLibraryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        subdomain={subdomain}
        pageName={accountName}
        mode={singleMode ? 'single' : 'multi'}
        sessionKey={pickerSession}
        onSingleAttach={(item) => {
          setMedia([item]);
          setPickerOpen(false);
        }}
        onMultiAttach={(items) => {
          setMedia((prev) => {
            const seen = new Set(prev.map((m) => m.id));
            return [...prev, ...items.filter((m) => !seen.has(m.id))];
          });
          setPickerOpen(false);
        }}
      />
    </>
  );
}
