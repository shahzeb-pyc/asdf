/**
 * Worker publisher registry — spec 237.
 *
 * Instagram and Threads publishers were removed with those sections:
 * with no registered publisher, claiming is registry-driven, so no
 * Instagram/Threads queue item is ever claimed or published again.
 * These tests fail on the old registry (which registered both).
 */
import { describe, expect, it } from 'vitest';
import { createWorkerPublisherRegistry } from './registry.js';

describe('createWorkerPublisherRegistry (spec 237)', () => {
  it('registers no Instagram or Threads publisher', () => {
    const registry = createWorkerPublisherRegistry();
    expect(registry.has('instagram')).toBe(false);
    expect(registry.has('threads')).toBe(false);
    expect(registry.get('instagram')).toBeUndefined();
    expect(registry.get('threads')).toBeUndefined();
    expect(registry.platforms()).not.toContain('instagram');
    expect(registry.platforms()).not.toContain('threads');
  });

  it('still registers Facebook (and the other live platforms)', () => {
    const registry = createWorkerPublisherRegistry();
    expect(registry.has('facebook')).toBe(true);
    expect(registry.has('x')).toBe(true);
  });
});
