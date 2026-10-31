/**
 * Pure validation for the Threads Create Post composer.
 *
 * Kept out of the dialog so it is unit-testable without rendering:
 * every rule here mirrors a Threads limit the contracts already
 * define (500 weighted characters, 5 links, 2–20 carousel items,
 * topic-tag shape), never a limit invented in the UI. Unsupported
 * types (story, reel, first comment) are not representable here at
 * all — the composer simply never offers them.
 */
import {
  THREADS_CAROUSEL_MAX_ITEMS,
  THREADS_CAROUSEL_MIN_ITEMS,
  THREADS_MAX_TOPIC_TAG_CHARACTERS,
  THREADS_REPLY_CONTROLS,
  validateThreadsText,
  type ThreadsScheduleFormat,
} from '@fbuploadpro/contracts';

export type ThreadsCreateIntent = 'now' | 'scheduled' | 'queue';

export interface ThreadsCreateMediaSelection {
  id: string;
  mediaType: 'image' | 'video';
  url: string;
}

export interface ThreadsCreateDraft {
  type: ThreadsScheduleFormat;
  caption: string;
  media: ThreadsCreateMediaSelection[];
  replyControl: string;
  topicTag: string;
  intent: ThreadsCreateIntent;
  scheduledAt: string;
}

/** First error found, or null when the draft can be submitted. */
export function validateThreadsCreateDraft(draft: ThreadsCreateDraft): string | null {
  const textError = validateThreadsText(draft.caption);
  if (textError) return textError;
  if (draft.type === 'text') {
    if (draft.media.length > 0) {
      return 'A text post cannot carry media. Remove the media or pick a media post type.';
    }
    if (!draft.caption.trim()) {
      return 'Write something for a text post first.';
    }
  }
  if (draft.type === 'image') {
    if (draft.media.length !== 1 || draft.media[0]?.mediaType !== 'image') {
      return 'An image post needs exactly one photo.';
    }
  }
  if (draft.type === 'video') {
    if (draft.media.length !== 1 || draft.media[0]?.mediaType !== 'video') {
      return 'A video post needs exactly one video.';
    }
  }
  if (draft.type === 'carousel') {
    if (draft.media.length < THREADS_CAROUSEL_MIN_ITEMS) {
      return `A carousel post needs at least ${THREADS_CAROUSEL_MIN_ITEMS} photos or videos.`;
    }
    if (draft.media.length > THREADS_CAROUSEL_MAX_ITEMS) {
      return `A carousel post can have at most ${THREADS_CAROUSEL_MAX_ITEMS} photos or videos.`;
    }
  }
  if (
    draft.replyControl &&
    !(THREADS_REPLY_CONTROLS as readonly string[]).includes(draft.replyControl)
  ) {
    return 'Choose who can reply from the list provided.';
  }
  const topic = draft.topicTag.trim();
  if (topic) {
    if (topic.length > THREADS_MAX_TOPIC_TAG_CHARACTERS) {
      return `A topic tag can be at most ${THREADS_MAX_TOPIC_TAG_CHARACTERS} characters.`;
    }
    if (/[.&]/.test(topic)) {
      return 'Topic tags cannot contain periods or ampersands.';
    }
  }
  if (draft.intent === 'scheduled') {
    if (!draft.scheduledAt) {
      return 'Pick a date and time for a scheduled post.';
    }
    const when = new Date(draft.scheduledAt).getTime();
    if (Number.isNaN(when)) {
      return 'That date and time is not valid.';
    }
    if (when <= Date.now()) {
      return 'A scheduled post must be in the future.';
    }
  }
  return null;
}

export const THREADS_REPLY_CONTROL_LABELS: Record<string, string> = {
  everyone: 'Everyone',
  accounts_you_follow: 'Accounts you follow',
  mentioned_only: 'Mentioned accounts only',
  parent_post_author_only: 'Parent post author only',
  followers_only: 'Followers only',
};
