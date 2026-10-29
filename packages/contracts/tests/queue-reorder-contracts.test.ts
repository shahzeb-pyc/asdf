import { describe, it, expect } from 'vitest';
import {
  ReorderQueueItemsRequestSchema,
  ReorderQueueItemsResponseSchema,
} from '../src/domain/queue';

const PAGE_ID = '22222222-2222-4222-a222-222222222222';
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('ReorderQueueItemsRequestSchema', () => {
  it('accepts a full ordered list for a page', () => {
    expect(
      ReorderQueueItemsRequestSchema.safeParse({ pageId: PAGE_ID, itemIds: [ID_A, ID_B] })
        .success
    ).toBe(true);
  });

  it('rejects an empty list', () => {
    expect(
      ReorderQueueItemsRequestSchema.safeParse({ pageId: PAGE_ID, itemIds: [] }).success
    ).toBe(false);
  });

  it('rejects duplicate ids', () => {
    const parsed = ReorderQueueItemsRequestSchema.safeParse({
      pageId: PAGE_ID,
      itemIds: [ID_A, ID_A],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects non-UUID ids and page ids', () => {
    expect(
      ReorderQueueItemsRequestSchema.safeParse({ pageId: 'not-a-uuid', itemIds: [ID_A] })
        .success
    ).toBe(false);
    expect(
      ReorderQueueItemsRequestSchema.safeParse({ pageId: PAGE_ID, itemIds: ['nope'] })
        .success
    ).toBe(false);
  });
});

describe('ReorderQueueItemsResponseSchema', () => {
  it('accepts the success shape and rejects anything else', () => {
    expect(
      ReorderQueueItemsResponseSchema.safeParse({ success: true, itemIds: [ID_B, ID_A] })
        .success
    ).toBe(true);
    expect(
      ReorderQueueItemsResponseSchema.safeParse({ success: false, itemIds: [] }).success
    ).toBe(false);
  });
});
