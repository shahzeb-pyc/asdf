import { describe, expect, it } from 'vitest';

import {
  validateThreadsCreateDraft,
  type ThreadsCreateDraft,
} from './threads-create-validation';

const BASE: ThreadsCreateDraft = {
  type: 'text',
  caption: 'Hello Threads',
  media: [],
  replyControl: 'everyone',
  topicTag: '',
  intent: 'queue',
  scheduledAt: '',
};

const IMAGE = { id: 'media-1', mediaType: 'image' as const, url: 'https://media.example.com/photo.jpg' };
const VIDEO = { id: 'media-2', mediaType: 'video' as const, url: 'https://media.example.com/clip.mp4' };

describe('validateThreadsCreateDraft', () => {
  it('accepts a plain text post', () => {
    expect(validateThreadsCreateDraft(BASE)).toBeNull();
  });

  it('blocks a caption over the 500 weighted-character limit', () => {
    expect(validateThreadsCreateDraft({ ...BASE, caption: 'x'.repeat(501) })).not.toBeNull();
  });

  it('blocks emoji-weighted captions that pass a visible-character count', () => {
    // One emoji weighs 4, so 200 emoji exceed 500 even though only 200 characters show.
    expect(validateThreadsCreateDraft({ ...BASE, caption: '😀'.repeat(200) })).not.toBeNull();
  });

  it('blocks media on a text post', () => {
    expect(validateThreadsCreateDraft({ ...BASE, media: [IMAGE] })).not.toBeNull();
  });

  it('requires exactly one photo for an image post', () => {
    expect(validateThreadsCreateDraft({ ...BASE, type: 'image', media: [] })).not.toBeNull();
    expect(
      validateThreadsCreateDraft({ ...BASE, type: 'image', media: [IMAGE, IMAGE] })
    ).not.toBeNull();
    expect(
      validateThreadsCreateDraft({ ...BASE, type: 'image', media: [VIDEO] })
    ).not.toBeNull();
    expect(validateThreadsCreateDraft({ ...BASE, type: 'image', media: [IMAGE] })).toBeNull();
  });

  it('requires exactly one video for a video post', () => {
    expect(
      validateThreadsCreateDraft({ ...BASE, type: 'video', media: [VIDEO] })
    ).toBeNull();
    expect(validateThreadsCreateDraft({ ...BASE, type: 'video', media: [IMAGE] })).not.toBeNull();
  });

  it('requires 2 to 20 items for a carousel', () => {
    expect(
      validateThreadsCreateDraft({ ...BASE, type: 'carousel', media: [IMAGE] })
    ).not.toBeNull();
    expect(
      validateThreadsCreateDraft({ ...BASE, type: 'carousel', media: [IMAGE, VIDEO] })
    ).toBeNull();
    expect(
      validateThreadsCreateDraft({
        ...BASE,
        type: 'carousel',
        media: Array.from({ length: 21 }, (_, i) => ({
          id: `media-${i}`,
          mediaType: 'image' as const,
          url: `https://media.example.com/photo-${i}.jpg`,
        })),
      })
    ).not.toBeNull();
  });

  it('rejects a topic tag with a period or ampersand', () => {
    expect(validateThreadsCreateDraft({ ...BASE, topicTag: 'a.b' })).not.toBeNull();
    expect(validateThreadsCreateDraft({ ...BASE, topicTag: 'a&b' })).not.toBeNull();
    expect(validateThreadsCreateDraft({ ...BASE, topicTag: 'photography' })).toBeNull();
  });

  it('rejects a scheduled post in the past and accepts one in the future', () => {
    expect(
      validateThreadsCreateDraft({
        ...BASE,
        intent: 'scheduled',
        scheduledAt: '2000-01-01T00:00',
      })
    ).not.toBeNull();
    expect(
      validateThreadsCreateDraft({
        ...BASE,
        intent: 'scheduled',
        scheduledAt: '2999-01-01T00:00',
      })
    ).toBeNull();
    expect(
      validateThreadsCreateDraft({ ...BASE, intent: 'scheduled', scheduledAt: '' })
    ).not.toBeNull();
  });

  it('rejects an unknown reply control', () => {
    expect(validateThreadsCreateDraft({ ...BASE, replyControl: 'nobody' })).not.toBeNull();
  });
});
