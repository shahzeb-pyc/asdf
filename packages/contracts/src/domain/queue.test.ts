import { describe, expect, it } from 'vitest';
import { UpdateQueueItemRequestSchema } from './queue.js';

describe('UpdateQueueItemRequestSchema firstComment cap', () => {
  it('accepts a firstComment of exactly 8,000 characters', () => {
    const parsed = UpdateQueueItemRequestSchema.safeParse({
      firstComment: 'c'.repeat(8000),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.firstComment).toHaveLength(8000);
    }
  });

  it('rejects a firstComment over 8,000 characters', () => {
    const parsed = UpdateQueueItemRequestSchema.safeParse({
      firstComment: 'c'.repeat(8001),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) => issue.path.includes('firstComment'))
      ).toBe(true);
    }
  });

  it('accepts the 2,001–8,000 range the old 2,000 cap rejected', () => {
    const parsed = UpdateQueueItemRequestSchema.safeParse({
      firstComment: 'c'.repeat(5000),
    });
    expect(parsed.success).toBe(true);
  });
});
