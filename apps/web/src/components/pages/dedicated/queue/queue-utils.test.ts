import { describe, it, expect } from 'vitest';
import {
  formatQueuePostType,
  formatQueueStatus,
  formatQueueTime,
} from './queue-utils';

describe('formatQueuePostType', () => {
  it('labels every wire format in plain language', () => {
    expect(formatQueuePostType('text')).toBe('Text');
    expect(formatQueuePostType('image')).toBe('Image');
    expect(formatQueuePostType('reel')).toBe('Reel');
    expect(formatQueuePostType('video')).toBe('Video');
    expect(formatQueuePostType('story')).toBe('Story');
    expect(formatQueuePostType('unknown-format')).toBe('Post');
  });
});

describe('formatQueueStatus', () => {
  it('labels every wire status, folding skipped into cancelled', () => {
    expect(formatQueueStatus('queued')).toBe('Queued');
    expect(formatQueueStatus('publishing')).toBe('Publishing');
    expect(formatQueueStatus('published')).toBe('Published');
    expect(formatQueueStatus('failed')).toBe('Failed');
    expect(formatQueueStatus('cancelled')).toBe('Cancelled');
    expect(formatQueueStatus('skipped')).toBe('Cancelled');
  });
});

describe('formatQueueTime', () => {
  it('formats an instant in the given timezone', () => {
    expect(formatQueueTime('2026-10-28T09:00:00.000Z', 'UTC')).toContain('9:00');
    expect(formatQueueTime('2026-10-28T09:00:00.000Z', 'UTC')).toContain('28 Oct');
  });

  it('returns null for null or invalid input', () => {
    expect(formatQueueTime(null, 'UTC')).toBeNull();
    expect(formatQueueTime('not-a-date', 'UTC')).toBeNull();
  });

  it('falls back to UTC for an unknown zone instead of throwing', () => {
    expect(formatQueueTime('2026-10-28T09:00:00.000Z', 'No/Such_Zone')).toContain('9:00');
  });
});
