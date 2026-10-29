import { describe, expect, it } from 'vitest';

import {
  PublishNowMediaSchema,
  PublishNowRequestSchema,
  PublishNowTempMediaRequestSchema,
  publishNowValidationMessage,
} from '../../src/publishing/publish-now.js';

/**
 * Publish Now contracts (PR #33): the direct, multi-page publish
 * request, its media shape, the temporary device-media request, and
 * the plain-language validation message the server returns instead
 * of a bare INVALID_REQUEST code. These tests pin the validation
 * behaviour the UI depends on: explicit post types, target limits,
 * caption/first-comment limits, the library/temp media requirements,
 * legitimately omitted media fields (nullish, not a failure), and
 * the image/jpg browser alias.
 */

const ACCOUNT_ID = '11111111-1111-4111-a111-111111111111';

function target(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT_ID,
    fbPageId: '123456789',
    pageName: 'Maddie Lippy',
    ...overrides,
  };
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    caption: 'Hello',
    postType: 'text',
    targets: [target()],
    media: null,
    ...overrides,
  };
}

describe('PublishNowRequestSchema', () => {
  it('accepts a text post with no media and no first comment', () => {
    const parsed = PublishNowRequestSchema.safeParse(baseRequest());
    expect(parsed.success).toBe(true);
  });

  it('accepts all four explicit post types', () => {
    for (const postType of ['text', 'image', 'video', 'reel']) {
      const parsed = PublishNowRequestSchema.safeParse(
        baseRequest({ postType })
      );
      expect(parsed.success).toBe(true);
    }
  });

  it('accepts a first comment up to 8,000 characters and rejects longer', () => {
    expect(
      PublishNowRequestSchema.safeParse(
        baseRequest({ firstComment: 'x'.repeat(8000) })
      ).success
    ).toBe(true);
    expect(
      PublishNowRequestSchema.safeParse(
        baseRequest({ firstComment: 'x'.repeat(8001) })
      ).success
    ).toBe(false);
  });

  it('rejects an empty target list and more than 50 targets', () => {
    expect(
      PublishNowRequestSchema.safeParse(baseRequest({ targets: [] })).success
    ).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) =>
      target({ fbPageId: `page-${i}` })
    );
    expect(
      PublishNowRequestSchema.safeParse(baseRequest({ targets: many })).success
    ).toBe(false);
    const fifty = Array.from({ length: 50 }, (_, i) =>
      target({ fbPageId: `page-${i}` })
    );
    expect(
      PublishNowRequestSchema.safeParse(baseRequest({ targets: fifty }))
        .success
    ).toBe(true);
  });

  it('rejects a non-UUID account id and a caption over 63,206 characters', () => {
    expect(
      PublishNowRequestSchema.safeParse(
        baseRequest({ targets: [target({ accountId: 'not-a-uuid' })] })
      ).success
    ).toBe(false);
    expect(
      PublishNowRequestSchema.safeParse(
        baseRequest({ caption: 'x'.repeat(63207) })
      ).success
    ).toBe(false);
  });
});

describe('PublishNowMediaSchema', () => {
  const libraryMedia = {
    source: 'library',
    mediaId: '22222222-2222-4222-a222-222222222222',
    tempKey: null,
    url: 'https://media.example.com/photo.jpg',
    mediaType: 'image',
    aspectRatio: '4:5',
    width: 1080,
    height: 1350,
    name: 'photo.jpg',
  };

  it('accepts library media and requires its media id', () => {
    expect(PublishNowMediaSchema.safeParse(libraryMedia).success).toBe(true);
    expect(
      PublishNowMediaSchema.safeParse({ ...libraryMedia, mediaId: null })
        .success
    ).toBe(false);
  });

  it('accepts temp media and requires its temp key', () => {
    const temp = {
      ...libraryMedia,
      source: 'temp',
      mediaId: null,
      tempKey: 'users/u1/publish-now-temp/abc/photo.jpg',
    };
    expect(PublishNowMediaSchema.safeParse(temp).success).toBe(true);
    expect(
      PublishNowMediaSchema.safeParse({ ...temp, tempKey: null }).success
    ).toBe(false);
  });

  it('treats omitted media fields as absent instead of failing', () => {
    const parsed = PublishNowMediaSchema.safeParse({
      source: 'library',
      mediaId: '22222222-2222-4222-a222-222222222222',
      url: 'https://media.example.com/photo.jpg',
      mediaType: 'image',
      name: 'photo.jpg',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // .nullish() without a default leaves omitted fields undefined;
      // the route treats undefined and null identically (falsy), so
      // an omitted temp key still satisfies the library requirement.
      expect(parsed.data.tempKey).toBeUndefined();
      expect(parsed.data.aspectRatio).toBeUndefined();
      expect(parsed.data.width).toBeUndefined();
      expect(parsed.data.height).toBeUndefined();
    }
  });

  it('rejects a non-URL media link and an unknown media type', () => {
    expect(
      PublishNowMediaSchema.safeParse({ ...libraryMedia, url: 'not-a-url' })
        .success
    ).toBe(false);
    expect(
      PublishNowMediaSchema.safeParse({ ...libraryMedia, mediaType: 'audio' })
        .success
    ).toBe(false);
  });
});

describe('PublishNowTempMediaRequestSchema', () => {
  it('accepts the allowlisted types and normalises image/jpg to image/jpeg', () => {
    const parsed = PublishNowTempMediaRequestSchema.safeParse({
      fileName: 'photo.jpg',
      fileSize: 1024,
      mimeType: 'image/jpg',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.mimeType).toBe('image/jpeg');
  });

  it('rejects an empty file, an over-cap file, and an unlisted type', () => {
    const base = { fileName: 'a.mp4', mimeType: 'video/mp4' };
    expect(
      PublishNowTempMediaRequestSchema.safeParse({ ...base, fileSize: 0 })
        .success
    ).toBe(false);
    expect(
      PublishNowTempMediaRequestSchema.safeParse({
        ...base,
        fileSize: 524288001,
      }).success
    ).toBe(false);
    expect(
      PublishNowTempMediaRequestSchema.safeParse({
        ...base,
        fileSize: 1024,
        mimeType: 'video/x-matroska',
      }).success
    ).toBe(false);
  });
});

describe('publishNowValidationMessage', () => {
  function messageFor(value: unknown) {
    const parsed = PublishNowRequestSchema.safeParse(value);
    if (parsed.success) throw new Error('expected validation to fail');
    return publishNowValidationMessage(parsed.error);
  }

  it('never returns the bare INVALID_REQUEST code', () => {
    expect(messageFor(baseRequest({ targets: [] }))).not.toBe(
      'INVALID_REQUEST'
    );
    expect(messageFor(baseRequest({ targets: [] }))).toBe(
      'Please select at least one page.'
    );
  });

  it('names the limit for too many targets, long captions, and long first comments', () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      target({ fbPageId: `page-${i}` })
    );
    expect(messageFor(baseRequest({ targets: many }))).toBe(
      'You can publish to at most 50 pages at once.'
    );
    expect(
      messageFor(baseRequest({ caption: 'x'.repeat(63207) }))
    ).toBe('Text exceeds the 63,206-character limit.');
    expect(
      messageFor(baseRequest({ firstComment: 'x'.repeat(8001) }))
    ).toBe('First comment exceeds the 8,000-character limit.');
  });

  it('uses the media superRefine wording for a missing library media id', () => {
    const parsed = PublishNowMediaSchema.safeParse({
      source: 'library',
      mediaId: null,
      tempKey: null,
      url: 'https://media.example.com/photo.jpg',
      mediaType: 'image',
      aspectRatio: null,
      width: null,
      height: null,
      name: 'photo.jpg',
    });
    if (parsed.success) throw new Error('expected validation to fail');
    expect(publishNowValidationMessage(parsed.error)).toBe(
      'Library media requires a media id'
    );
  });
});
