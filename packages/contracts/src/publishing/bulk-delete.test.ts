import { describe, expect, it } from 'vitest';
import {
  BULK_DELETE_CLIENT_BATCH_SIZE,
  BULK_DELETE_CLIENT_PAUSE_SECONDS,
  BULK_DELETE_MAX_BATCH,
  BULK_DELETE_MAX_PREVIEW,
  BulkDeleteBatchRequestSchema,
  BulkDeleteBatchResponseSchema,
  BulkDeleteContentRequestSchema,
  BulkDeletePreviewRequestSchema,
  BulkDeletePreviewResponseSchema,
} from './bulk-delete.js';

const basePreview = {
  accountId: '11111111-1111-4111-8111-111111111111',
  pageId: '123456789',
  type: 'all',
  sort: 'oldest_first',
} as const;

describe('BulkDeletePreviewRequestSchema', () => {
  it('accepts all types, sort and a valid date range', () => {
    const parsed = BulkDeletePreviewRequestSchema.parse({
      ...basePreview,
      dateFrom: '2026-01-01',
      dateTo: '2026-06-30',
    });
    expect(parsed.type).toBe('all');
    expect(parsed.sort).toBe('oldest_first');
  });

  it('rejects a token field — the client must never supply a token', () => {
    const parsed = BulkDeletePreviewRequestSchema.safeParse({
      ...basePreview,
      pageAccessToken: 'EAABsecret',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown type and a reversed date range', () => {
    expect(
      BulkDeletePreviewRequestSchema.safeParse({ ...basePreview, type: 'stories' }).success,
    ).toBe(false);
    expect(
      BulkDeletePreviewRequestSchema.safeParse({
        ...basePreview,
        dateFrom: '2026-06-30',
        dateTo: '2026-01-01',
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed date', () => {
    expect(
      BulkDeletePreviewRequestSchema.safeParse({ ...basePreview, dateFrom: 'Jan 1' }).success,
    ).toBe(false);
  });
});

describe('BulkDeleteContentRequestSchema', () => {
  it('defaults limit to 25 and clamps the range', () => {
    expect(BulkDeleteContentRequestSchema.parse({
      accountId: basePreview.accountId,
      pageId: '123',
      type: 'posts',
    }).limit).toBe(25);
    expect(
      BulkDeleteContentRequestSchema.safeParse({
        accountId: basePreview.accountId,
        pageId: '123',
        type: 'posts',
        limit: '0',
      }).success,
    ).toBe(false);
    expect(
      BulkDeleteContentRequestSchema.safeParse({
        accountId: basePreview.accountId,
        pageId: '123',
        type: 'posts',
        limit: '101',
      }).success,
    ).toBe(false);
  });
});

describe('BulkDeleteBatchRequestSchema', () => {
  it('accepts 1–25 ids and rejects an empty list', () => {
    expect(
      BulkDeleteBatchRequestSchema.parse({
        accountId: basePreview.accountId,
        contentIds: ['123_456'],
      }).contentIds,
    ).toEqual(['123_456']);
    expect(
      BulkDeleteBatchRequestSchema.safeParse({
        accountId: basePreview.accountId,
        contentIds: [],
      }).success,
    ).toBe(false);
  });

  it('rejects more than 25 ids instead of silently truncating', () => {
    const ids = Array.from({ length: 26 }, (_, i) => `123_${i}`);
    expect(
      BulkDeleteBatchRequestSchema.safeParse({
        accountId: basePreview.accountId,
        contentIds: ids,
      }).success,
    ).toBe(false);
  });

  it('rejects a token field', () => {
    expect(
      BulkDeleteBatchRequestSchema.safeParse({
        accountId: basePreview.accountId,
        contentIds: ['123_456'],
        pageAccessToken: 'EAABsecret',
      }).success,
    ).toBe(false);
  });
});

describe('bulk delete limits', () => {
  it('keeps the old numbers: preview 500, client batch 20, pause 60s', () => {
    expect(BULK_DELETE_MAX_PREVIEW).toBe(500);
    expect(BULK_DELETE_MAX_BATCH).toBe(25);
    expect(BULK_DELETE_CLIENT_BATCH_SIZE).toBe(20);
    expect(BULK_DELETE_CLIENT_PAUSE_SECONDS).toBe(60);
  });
});

describe('BulkDeletePreviewResponseSchema / BulkDeleteBatchResponseSchema', () => {
  it('rejects a preview with more than 500 candidates', () => {
    const candidates = Array.from({ length: 501 }, (_, i) => ({
      id: `123_${i}`,
      type: 'posts' as const,
      title: 'Post',
      createdTime: null,
      permalinkUrl: null,
      previewImageUrl: null,
    }));
    expect(
      BulkDeletePreviewResponseSchema.safeParse({ total: 501, candidates }).success,
    ).toBe(false);
  });

  it('accepts an already-deleted success in a batch result', () => {
    const parsed = BulkDeleteBatchResponseSchema.parse({
      total: 2,
      succeeded: 2,
      failed: 0,
      results: [
        { id: '123_1', success: true },
        { id: '123_2', success: true, alreadyDeleted: true },
      ],
    });
    expect(parsed.results[1]?.alreadyDeleted).toBe(true);
  });
});
