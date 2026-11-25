import { describe, expect, it } from 'vitest';
import {
  InstagramPublishNowRequestSchema,
  InstagramPublishNowResponseSchema,
  instagramPublishNowValidationMessage,
} from '../../src/publishing/instagram-publish-now.js';

const accountId = '11111111-1111-4111-a111-111111111111';

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    caption: 'A photo caption',
    postType: 'image',
    targets: [{ accountId, accountName: 'Creator One' }],
    media: {
      source: 'post-owned',
      mediaId: null,
      tempKey: null,
      postOwnedKey: 'users/user-1/post-media/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/photo.jpg',
      url: 'https://media.example.com/photo.jpg',
      mediaType: 'image',
      aspectRatio: '4:5',
      width: 1080,
      height: 1350,
      name: 'photo.jpg',
    },
    ...overrides,
  };
}

describe('InstagramPublishNowRequestSchema', () => {
  it('accepts an image post to one account', () => {
    const parsed = InstagramPublishNowRequestSchema.parse(baseRequest());
    expect(parsed.postType).toBe('image');
    expect(parsed.targets).toHaveLength(1);
  });

  it('accepts a video post with video media', () => {
    const parsed = InstagramPublishNowRequestSchema.parse(
      baseRequest({
        postType: 'video',
        media: {
          source: 'post-owned',
          mediaId: null,
          tempKey: null,
          postOwnedKey: 'users/user-1/post-media/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/reel.mp4',
          url: 'https://media.example.com/reel.mp4',
          mediaType: 'video',
          aspectRatio: null,
          width: null,
          height: null,
          name: 'reel.mp4',
        },
      })
    );
    expect(parsed.postType).toBe('video');
  });

  it('accepts a reel post with video media', () => {
    const parsed = InstagramPublishNowRequestSchema.parse(
      baseRequest({
        postType: 'reel',
        media: {
          source: 'post-owned',
          mediaId: null,
          tempKey: null,
          postOwnedKey: 'users/user-1/post-media/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/reel.mp4',
          url: 'https://media.example.com/reel.mp4',
          mediaType: 'video',
          aspectRatio: null,
          width: null,
          height: null,
          name: 'reel.mp4',
        },
      })
    );
    expect(parsed.postType).toBe('reel');
  });

  it('rejects a text post type: Instagram has no text-only feed post', () => {
    const result = InstagramPublishNowRequestSchema.safeParse(
      baseRequest({ postType: 'text', media: null })
    );
    expect(result.success).toBe(false);
  });

  it('rejects an image post carrying video media', () => {
    const result = InstagramPublishNowRequestSchema.safeParse(
      baseRequest({
        media: {
          source: 'post-owned',
          mediaId: null,
          tempKey: null,
          postOwnedKey: 'users/user-1/post-media/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/reel.mp4',
          url: 'https://media.example.com/reel.mp4',
          mediaType: 'video',
          aspectRatio: null,
          width: null,
          height: null,
          name: 'reel.mp4',
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it('rejects a video post carrying image media', () => {
    const result = InstagramPublishNowRequestSchema.safeParse(
      baseRequest({
        postType: 'video',
        media: {
          source: 'post-owned',
          mediaId: null,
          tempKey: null,
          postOwnedKey: 'users/user-1/post-media/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/photo.jpg',
          url: 'https://media.example.com/photo.jpg',
          mediaType: 'image',
          aspectRatio: '4:5',
          width: 1080,
          height: 1350,
          name: 'photo.jpg',
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it('rejects a reel post carrying image media', () => {
    const result = InstagramPublishNowRequestSchema.safeParse(
      baseRequest({
        postType: 'reel',
        media: {
          source: 'post-owned',
          mediaId: null,
          tempKey: null,
          postOwnedKey: 'users/user-1/post-media/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/photo.jpg',
          url: 'https://media.example.com/photo.jpg',
          mediaType: 'image',
          aspectRatio: '4:5',
          width: 1080,
          height: 1350,
          name: 'photo.jpg',
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it('rejects captions over 2,200 characters', () => {
    const result = InstagramPublishNowRequestSchema.safeParse(
      baseRequest({ caption: 'x'.repeat(2201) })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(instagramPublishNowValidationMessage(result.error)).toContain('2,200');
    }
  });

  it('rejects captions over 30 hashtags', () => {
    const caption = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ');
    const result = InstagramPublishNowRequestSchema.safeParse(
      baseRequest({ caption })
    );
    expect(result.success).toBe(false);
  });

  it('rejects an empty target list and more than 50 targets', () => {
    expect(
      InstagramPublishNowRequestSchema.safeParse(baseRequest({ targets: [] }))
        .success
    ).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => ({
      accountId,
      accountName: `Account ${i}`,
    }));
    const result = InstagramPublishNowRequestSchema.safeParse(
      baseRequest({ targets: many })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(instagramPublishNowValidationMessage(result.error)).toContain('50 accounts');
    }
  });

  it('never returns a bare code for a validation failure', () => {
    const result = InstagramPublishNowRequestSchema.safeParse(
      baseRequest({ targets: [] })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = instagramPublishNowValidationMessage(result.error);
      expect(message).not.toBe('INVALID_REQUEST');
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

describe('InstagramPublishNowResponseSchema', () => {
  it('accepts a published result with diagnostics fields absent', () => {
    const parsed = InstagramPublishNowResponseSchema.parse({
      results: [
        {
          accountId,
          accountName: 'Creator One',
          status: 'published',
          postId: 'media_123',
          reason: null,
        },
      ],
    });
    expect(parsed.results[0]?.status).toBe('published');
  });
});
