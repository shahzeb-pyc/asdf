'use client';

import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  countInstagramHashtags,
  countInstagramMentions,
  validateInstagramCaption,
  validateInstagramImageFacts,
  validateInstagramVideoFacts,
  type ComposerMedia,
} from '@fbuploadpro/contracts';

import { api, buildTenantApiPath } from '@/lib/api';
import { getErrorMessage } from '@/lib/api/errors';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { Textarea } from '@/components/shared/ui/textarea';
import { toast } from '@/components/shared/ui/toast';
import { MediaLibraryPicker } from '@/components/pages/dedicated/create-posts/media-library-picker';

/**
 * Instagram Schedule single-post composer — the Instagram-supported
 * subset only: Photo, Reel, Carousel. No text-only post (Instagram
 * has no text-only feed format) and no story (stories need a
 * Business account; Schedule targets Creator accounts). Media comes
 * from the existing Media Library picker in browse-and-select mode
 * only: tile click selects, no caption editing inside the picker.
 * Scheduling intents: Now, At a time, Next posting time (queue).
 */

const AckSchema = z.object({}).passthrough();

type ComposerType = 'photo' | 'reel' | 'carousel';

const TYPE_CONFIG: Record<
  ComposerType,
  { kind: string; platformFormat: string | null; label: string }
> = {
  photo: { kind: 'image', platformFormat: null, label: 'Photo' },
  reel: { kind: 'video', platformFormat: 'reel', label: 'Reel' },
  carousel: { kind: 'carousel', platformFormat: null, label: 'Carousel' },
};

export function CreatePostDialog({
  subdomain,
  destinationId,
  accountDisplayName,
  open,
  onOpenChange,
}: Readonly<{
  subdomain: string;
  destinationId: string;
  accountDisplayName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const [type, setType] = React.useState<ComposerType>('photo');
  const [caption, setCaption] = React.useState('');
  const [firstComment, setFirstComment] = React.useState('');
  const [media, setMedia] = React.useState<ComposerMedia[]>([]);
  const [intent, setIntent] = React.useState<'now' | 'scheduled' | 'queue'>('queue');
  const [scheduledAt, setScheduledAt] = React.useState('');
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [sessionKey, setSessionKey] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const captionError = validateInstagramCaption(caption);
  const hashtagCount = countInstagramHashtags(caption);
  const mentionCount = countInstagramMentions(caption);

  const mediaError = React.useMemo(() => {
    if (media.length === 0) return 'Choose media for this post.';
    if (type === 'photo') {
      const item = media[0];
      if (!item || item.mediaType !== 'image') {
        return 'A photo post needs an image.';
      }
      return validateInstagramImageFacts({
        mimeType: undefined,
        sizeBytes: undefined,
        widthPx: item.width ?? undefined,
        heightPx: item.height ?? undefined,
      });
    }
    if (type === 'reel') {
      const item = media[0];
      if (!item || item.mediaType !== 'video') {
        return 'A reel needs a video.';
      }
      return validateInstagramVideoFacts({
        durationSeconds: undefined,
        widthPx: item.width ?? undefined,
      });
    }
    if (media.length < 2) {
      return 'A carousel needs at least 2 items.';
    }
    if (media.length > 10) {
      return 'A carousel can have at most 10 items.';
    }
    return null;
  }, [media, type]);

  const reset = React.useCallback(() => {
    setType('photo');
    setCaption('');
    setFirstComment('');
    setMedia([]);
    setIntent('queue');
    setScheduledAt('');
    setError(null);
    setIsSubmitting(false);
    setSessionKey((key) => key + 1);
  }, []);

  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      if (!next) reset();
      onOpenChange(next);
    },
    [onOpenChange, reset]
  );

  const handleSubmit = React.useCallback(async () => {
    if (captionError || mediaError) return;
    if (intent === 'scheduled' && !scheduledAt) {
      setError('Choose a date and time for this post.');
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      const config = TYPE_CONFIG[type];
      const platformOptions =
        type === 'carousel'
          ? {
              carouselItems: media.map((item) => ({
                mediaUrl: item.url,
                mediaType: item.mediaType,
              })),
            }
          : {};
      await api.post(
        buildTenantApiPath(subdomain, '/publishing/destination-queue'),
        {
          platform: 'instagram',
          destinationId,
          kind: config.kind,
          platformFormat: config.platformFormat,
          caption,
          firstComment: firstComment.trim() ? firstComment.trim() : null,
          mediaItemIds: media.map((item) => item.id),
          platformOptions,
          intent,
          ...(intent === 'scheduled'
            ? { scheduledAt: new Date(scheduledAt).toISOString() }
            : {}),
        },
        { schema: AckSchema }
      );
      handleOpenChange(false);
      toast.success(
        intent === 'now'
          ? 'Post queued for publishing now.'
          : intent === 'scheduled'
            ? 'Post scheduled.'
            : 'Post added to the queue.'
      );
      void queryClient.invalidateQueries({
        queryKey: tenant.instagramSchedule.detail(destinationId),
      });
      void queryClient.invalidateQueries({
        queryKey: tenant.instagramSchedule.list,
      });
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey.includes('instagram') &&
          query.queryKey.includes('schedule') &&
          query.queryKey.includes(destinationId),
      });
    } catch (err) {
      setError(getErrorMessage(err, 'Could not create this post. Please try again.'));
    } finally {
      setIsSubmitting(false);
    }
  }, [
    caption,
    captionError,
    media,
    mediaError,
    type,
    firstComment,
    intent,
    scheduledAt,
    subdomain,
    destinationId,
    handleOpenChange,
    queryClient,
    tenant.instagramSchedule,
  ]);

  const canSubmit =
    !captionError &&
    !mediaError &&
    (intent !== 'scheduled' || Boolean(scheduledAt)) &&
    !isSubmitting;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="sm:max-w-135"
          data-testid="instagram-schedule-create-post-dialog"
        >
          <DialogHeader>
            <DialogTitle>Create post for {accountDisplayName}</DialogTitle>
          </DialogHeader>

          {error && (
            <div
              role="alert"
              className="rounded-sm border border-signal-critical/25 bg-signal-critical/10 px-3 py-2.5 text-body text-ink"
            >
              {error}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {(Object.keys(TYPE_CONFIG) as ComposerType[]).map((key) => (
              <Button
                key={key}
                type="button"
                variant={type === key ? 'default' : 'outline'}
                onClick={() => {
                  setType(key);
                  setMedia([]);
                }}
              >
                {TYPE_CONFIG[key].label}
              </Button>
            ))}
          </div>

          <div>
            <Textarea
              data-testid="instagram-schedule-composer-caption-input"
              value={caption}
              maxLength={2200}
              rows={5}
              placeholder="Write a caption…"
              onChange={(event) => setCaption(event.target.value)}
            />
            <p className="mt-1 mb-0 text-metadata text-ink-sub">
              {caption.length} / 2200 characters · {hashtagCount} hashtags (max 30) ·{' '}
              {mentionCount} mentions (max 20)
            </p>
            {captionError && (
              <p role="alert" className="m-0 mt-1 text-body text-signal-critical">
                {captionError}
              </p>
            )}
          </div>

          <div>
            <p className="mb-2 text-body font-medium">
              Media ({media.length}
              {type === 'carousel' ? ' / 10' : ''})
            </p>
            {media.length > 0 && (
              <ul className="m-0 mb-2 flex flex-col gap-1 p-0 list-none">
                {media.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-2 text-body">
                    <span className="truncate">{item.name}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setMedia(media.filter((m) => m.id !== item.id))
                      }
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => setPickerOpen(true)}
            >
              {media.length > 0 ? 'Change media' : 'Choose media'}
            </Button>
            {mediaError && media.length > 0 && (
              <p role="alert" className="m-0 mt-1 text-body text-signal-critical">
                {mediaError}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1 block text-body font-medium" htmlFor="instagram-schedule-first-comment">
              First comment (optional)
            </label>
            <Textarea
              id="instagram-schedule-first-comment"
              value={firstComment}
              maxLength={2000}
              rows={2}
              placeholder="Posted after the post goes live."
              onChange={(event) => setFirstComment(event.target.value)}
            />
          </div>

          <fieldset className="border-0 p-0">
            <legend className="mb-2 text-body font-medium">When should it go out?</legend>
            <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-body">
                <input
                  type="radio"
                  name="instagram-schedule-intent"
                  checked={intent === 'queue'}
                  onChange={() => setIntent('queue')}
                />
                Next posting time
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-body">
                <input
                  type="radio"
                  name="instagram-schedule-intent"
                  checked={intent === 'scheduled'}
                  onChange={() => setIntent('scheduled')}
                />
                At a specific time
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-body">
                <input
                  type="radio"
                  name="instagram-schedule-intent"
                  checked={intent === 'now'}
                  onChange={() => setIntent('now')}
                />
                Now
              </label>
            </div>
            {intent === 'scheduled' && (
              <input
                data-testid="instagram-schedule-composer-scheduled-at-input"
                type="datetime-local"
                value={scheduledAt}
                onChange={(event) => setScheduledAt(event.target.value)}
                className="mt-2 rounded-sm border border-line bg-panel px-3 py-2 text-body text-ink"
              />
            )}
          </fieldset>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="instagram-schedule-composer-submit-btn"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
            >
              {isSubmitting ? 'Creating…' : 'Create post'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <MediaLibraryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        subdomain={subdomain}
        pageName={accountDisplayName}
        mode={type === 'carousel' ? 'multi' : 'single'}
        sessionKey={sessionKey}
        onSingleAttach={(item) => {
          setMedia([item]);
          setPickerOpen(false);
        }}
        onMultiAttach={(items) => {
          setMedia(items);
          setPickerOpen(false);
        }}
      />
    </>
  );
}
