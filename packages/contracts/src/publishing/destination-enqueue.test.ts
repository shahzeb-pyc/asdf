import { describe, expect, it } from 'vitest';
import { DestinationEnqueueRequestSchema } from './destination-enqueue.js';

const base = {
  destinationId: '11111111-1111-4111-8111-111111111111',
  kind: 'text' as const,
  caption: 'hello',
  intent: 'now' as const,
  platform: 'facebook' as const,
};

describe('DestinationEnqueueRequestSchema firstComment cap', () => {
  it('accepts a firstComment of exactly 8,000 characters', () => {
    const parsed = DestinationEnqueueRequestSchema.safeParse({
      ...base,
      firstComment: 'c'.repeat(8000),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.firstComment).toHaveLength(8000);
    }
  });

  it('rejects a firstComment over 8,000 characters', () => {
    const parsed = DestinationEnqueueRequestSchema.safeParse({
      ...base,
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
    const parsed = DestinationEnqueueRequestSchema.safeParse({
      ...base,
      firstComment: 'c'.repeat(5000),
    });
    expect(parsed.success).toBe(true);
  });
});
