import { describe, expect, it } from 'vitest';
import {
  THREADS_PUBLISH_NOW_POST_TYPES,
  ThreadsPublishNowRequestSchema,
  ThreadsPublishNowResponseSchema,
  threadsPublishNowValidationMessage,
} from '../../src/index.js';

const target = {
  accountId: '11111111-1111-4111-8111-111111111111',
  threadsUserId: 'threads-user-1',
  accountName: 'Test Threads',
  handle: 'testthreads',
};

describe('Threads Publish Now contracts', () => {
  it('offers only Threads-supported post types: text, image, video', () => {
    expect(THREADS_PUBLISH_NOW_POST_TYPES).toEqual(['text', 'image', 'video']);
    expect(THREADS_PUBLISH_NOW_POST_TYPES).not.toContain('reel');
  });

  it('accepts a text post with no media', () => {
    expect(
      ThreadsPublishNowRequestSchema.safeParse({
        caption: 'Hello Threads',
        postType: 'text',
        targets: [target],
        media: null,
      }).success
    ).toBe(true);
  });

  it('accepts an image post with matching image media and a reply', () => {
    expect(
      ThreadsPublishNowRequestSchema.safeParse({
        caption: 'Photo',
        postType: 'image',
        reply: 'First reply',
        targets: [target],
        media: {
          source: 'library',
          mediaId: '22222222-2222-4222-8222-222222222222',
          url: 'https://cdn.example.com/photo.jpg',
          mediaType: 'image',
          name: 'photo.jpg',
        },
      }).success
    ).toBe(true);
  });

  it('rejects a reel post type outright', () => {
    const parsed = ThreadsPublishNowRequestSchema.safeParse({
      caption: 'Reel',
      postType: 'reel',
      targets: [target],
      media: null,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects media on a text post and mismatched media on image/video posts', () => {
    const media = {
      source: 'library',
      mediaId: '22222222-2222-4222-8222-222222222222',
      url: 'https://cdn.example.com/photo.jpg',
      mediaType: 'image',
      name: 'photo.jpg',
    };
    expect(
      ThreadsPublishNowRequestSchema.safeParse({
        caption: 'Text',
        postType: 'text',
        targets: [target],
        media,
      }).success
    ).toBe(false);
    expect(
      ThreadsPublishNowRequestSchema.safeParse({
        caption: 'Video',
        postType: 'video',
        targets: [target],
        media,
      }).success
    ).toBe(false);
  });

  it('rejects a caption over the Threads 500 weighted-character cap, not Facebook\'s 63,206', () => {
    const parsed = ThreadsPublishNowRequestSchema.safeParse({
      caption: 'x'.repeat(501),
      postType: 'text',
      targets: [target],
      media: null,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(threadsPublishNowValidationMessage(parsed.error)).toContain('500');
    }
    // Emoji count for more than one: 250 emoji = 1,000 weighted chars.
    const emoji = ThreadsPublishNowRequestSchema.safeParse({
      caption: '😀'.repeat(250),
      postType: 'text',
      targets: [target],
      media: null,
    });
    expect(emoji.success).toBe(false);
  });

  it('rejects more than 5 links and more than 50 targets, with plain messages', () => {
    const links = ThreadsPublishNowRequestSchema.safeParse({
      caption: Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`).join(' '),
      postType: 'text',
      targets: [target],
      media: null,
    });
    expect(links.success).toBe(false);
    if (!links.success) {
      expect(threadsPublishNowValidationMessage(links.error)).toContain('at most 5 links');
    }
    const many = ThreadsPublishNowRequestSchema.safeParse({
      caption: 'Hi',
      postType: 'text',
      targets: Array.from({ length: 51 }, (_, i) => ({ ...target, threadsUserId: `user-${i}` })),
      media: null,
    });
    expect(many.success).toBe(false);
    if (!many.success) {
      expect(threadsPublishNowValidationMessage(many.error)).toContain('at most 50 accounts');
    }
  });

  it('never surfaces a bare code for a missing account selection', () => {
    const parsed = ThreadsPublishNowRequestSchema.safeParse({
      caption: 'Hi',
      postType: 'text',
      targets: [],
      media: null,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const message = threadsPublishNowValidationMessage(parsed.error);
      expect(message).not.toBe('INVALID_REQUEST');
      expect(message).toContain('at least one account');
    }
  });

  it('accepts a per-account result with reply-failed warning fields', () => {
    expect(
      ThreadsPublishNowResponseSchema.safeParse({
        results: [
          {
            ...target,
            status: 'published',
            postId: 'media-1',
            reason: null,
            replyFailed: true,
            replyReason: 'Threads could not post the reply.',
          },
        ],
      }).success
    ).toBe(true);
  });
});
