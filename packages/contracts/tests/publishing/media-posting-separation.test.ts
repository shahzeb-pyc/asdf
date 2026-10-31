import { describe, expect, it } from 'vitest';
import {
  DestinationEnqueueRequestSchema,
  StagedPostMediaSchema,
} from '../../src/publishing/destination-enqueue.js';
import {
  ComposerMediaSchema,
  toComposerEnqueueItem,
} from '../../src/publishing/create-posts-composer.js';
import {
  UploadPurposeSchema,
  UploadUrlRequestSchema,
  MultipartInitiateRequestSchema,
} from '../../src/domain/media.js';

const destinationId = '33333333-3333-4333-a333-333333333333';
const stagedKey = 'users/11111111-1111-4111-a111-111111111111/post-staging/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/clip.mp4';

function stagedImage(overrides: Record<string, unknown> = {}) {
  return {
    storageKey: 'users/11111111-1111-4111-a111-111111111111/post-staging/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/photo.jpg',
    mediaType: 'image',
    ...overrides,
  };
}

function enqueueBody(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'facebook',
    destinationId,
    kind: 'image',
    caption: 'Hello',
    intent: 'queue',
    ...overrides,
  };
}

describe('StagedPostMediaSchema', () => {
  it('accepts staged video with facts', () => {
    const parsed = StagedPostMediaSchema.parse({
      storageKey: stagedKey,
      mediaType: 'video',
      fileSize: 1024,
      durationSeconds: 45,
      aspectRatio: '9:16',
    });
    expect(parsed.storageKey).toBe(stagedKey);
    expect(parsed.durationSeconds).toBe(45);
  });

  it('accepts staged media with unknown facts (nulls pass like null library facts)', () => {
    const parsed = StagedPostMediaSchema.parse({
      storageKey: stagedKey,
      mediaType: 'video',
      fileSize: null,
      durationSeconds: null,
      aspectRatio: null,
    });
    expect(parsed.fileSize).toBeNull();
  });

  it('rejects an empty storage key and an unknown media type', () => {
    expect(() =>
      StagedPostMediaSchema.parse({ storageKey: '', mediaType: 'image' })
    ).toThrow();
    expect(() =>
      StagedPostMediaSchema.parse({ storageKey: stagedKey, mediaType: 'audio' })
    ).toThrow();
  });
});

describe('DestinationEnqueueRequestSchema — staged media refinements', () => {
  it('accepts staged media alone (no library ids)', () => {
    const parsed = DestinationEnqueueRequestSchema.parse(
      enqueueBody({ mediaItemIds: [], stagedMedia: stagedImage() })
    );
    expect(parsed.stagedMedia?.storageKey).toContain('/post-staging/');
  });

  it('rejects staged media mixed with library ids', () => {
    const result = DestinationEnqueueRequestSchema.safeParse(
      enqueueBody({
        mediaItemIds: ['44444444-4444-4444-a444-444444444444'],
        stagedMedia: stagedImage(),
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['stagedMedia']);
    }
  });

  it('rejects staged media whose type disagrees with the post kind', () => {
    const result = DestinationEnqueueRequestSchema.safeParse(
      enqueueBody({
        kind: 'video',
        mediaItemIds: [],
        stagedMedia: stagedImage(),
      })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['stagedMedia']);
    }
  });

  it('rejects staged media on a text post', () => {
    const result = DestinationEnqueueRequestSchema.safeParse(
      enqueueBody({
        kind: 'text',
        mediaItemIds: [],
        stagedMedia: stagedImage(),
      })
    );
    expect(result.success).toBe(false);
  });

  it('still accepts a plain library media post (no stagedMedia)', () => {
    const parsed = DestinationEnqueueRequestSchema.parse(
      enqueueBody({ mediaItemIds: ['44444444-4444-4444-a444-444444444444'] })
    );
    expect(parsed.stagedMedia).toBeUndefined();
  });
});

describe('ComposerMediaSchema + toComposerEnqueueItem — staged mapping', () => {
  it('parses staged composer media with its key and facts', () => {
    const parsed = ComposerMediaSchema.parse({
      id: '55555555-5555-4555-a555-555555555555',
      name: 'photo.jpg',
      mediaType: 'image',
      aspectRatio: '1:1',
      thumbnailUrl: null,
      url: 'https://media.example.com/photo.jpg',
      captionText: 'photo',
      source: 'staged',
      storageKey: stagedImage().storageKey as string,
      fileSize: 2048,
    });
    expect(parsed.source).toBe('staged');
    expect(parsed.storageKey).toContain('/post-staging/');
  });

  it('maps a staged block to stagedMedia with empty mediaItemIds (never invents a link)', () => {
    const item = toComposerEnqueueItem({
      id: 'block-1',
      text: '',
      media: {
        id: '55555555-5555-4555-a555-555555555555',
        name: 'photo.jpg',
        mediaType: 'image',
        aspectRatio: '1:1',
        thumbnailUrl: null,
        url: 'https://media.example.com/photo.jpg',
        captionText: 'photo',
        source: 'staged',
        storageKey: stagedImage().storageKey as string,
        fileSize: 2048,
      },
    });
    expect(item).not.toBeNull();
    expect(item?.kind).toBe('image');
    expect(item?.mediaItemIds).toEqual([]);
    expect(item?.stagedMedia?.storageKey).toContain('/post-staging/');
    expect(item?.stagedMedia?.fileSize).toBe(2048);
  });

  it('maps a library block to mediaItemIds with no stagedMedia', () => {
    const item = toComposerEnqueueItem({
      id: 'block-1',
      text: '',
      media: {
        id: '44444444-4444-4444-a444-444444444444',
        name: 'photo.jpg',
        mediaType: 'image',
        aspectRatio: '1:1',
        thumbnailUrl: null,
        url: 'https://cdn.example.com/photo.jpg',
        captionText: 'photo',
      },
    });
    expect(item).not.toBeNull();
    expect(item?.mediaItemIds).toEqual(['44444444-4444-4444-a444-444444444444']);
    expect(item?.stagedMedia).toBeNull();
  });
});

describe('UploadPurposeSchema', () => {
  it('accepts library and post-staging, rejects anything else', () => {
    expect(UploadPurposeSchema.parse('library')).toBe('library');
    expect(UploadPurposeSchema.parse('post-staging')).toBe('post-staging');
    expect(() => UploadPurposeSchema.parse('page-folder')).toThrow();
  });

  it('upload-url and multipart initiate default purpose to library', () => {
    const body = {
      fileName: 'photo.jpg',
      fileSize: 1024,
      mimeType: 'image/jpeg',
    };
    expect(UploadUrlRequestSchema.parse(body).purpose).toBe('library');
    expect(MultipartInitiateRequestSchema.parse(body).purpose).toBe('library');
    expect(
      UploadUrlRequestSchema.parse({ ...body, purpose: 'post-staging' }).purpose
    ).toBe('post-staging');
  });
});
