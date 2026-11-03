import { describe, expect, it } from 'vitest';
import { normalizeReelCaption, DEFAULT_REEL_CAPTION } from './caption.js';

describe('normalizeReelCaption', () => {
  it('passes a real title through', () => {
    expect(normalizeReelCaption('Sunset over the hills', '12345')).toBe('Sunset over the hills');
  });

  it('maps empty and placeholder captions to the default', () => {
    for (const raw of [null, undefined, '', '   ', '...', '…', '.', '-', 'n/a', 'na', 'none']) {
      expect(normalizeReelCaption(raw, '12345')).toBe(DEFAULT_REEL_CAPTION);
    }
  });

  it('maps generic titles to the default', () => {
    for (const raw of ['TikTok', 'TikTok 123', 'video', 'Reel 42', 'instagram reel', 'YouTube Shorts', 'untitled']) {
      expect(normalizeReelCaption(raw, '12345')).toBe(DEFAULT_REEL_CAPTION);
    }
  });

  it('maps ID-like captions to the default', () => {
    expect(normalizeReelCaption('123456789', '12345')).toBe(DEFAULT_REEL_CAPTION);
    expect(normalizeReelCaption('video_123456', '12345')).toBe(DEFAULT_REEL_CAPTION);
    expect(normalizeReelCaption('tiktok 987654321', '12345')).toBe(DEFAULT_REEL_CAPTION);
  });

  it('maps a title that is just the reel id plus a generic word to the default', () => {
    expect(normalizeReelCaption('video 740123456789', '740123456789')).toBe(DEFAULT_REEL_CAPTION);
    // But a real title that merely contains digits stays.
    expect(normalizeReelCaption('My top 10 moments', '740123456789')).toBe('My top 10 moments');
  });

  it('keeps titles with hashtags and emoji', () => {
    expect(normalizeReelCaption('#fyp dancing all night 🔥', '12345')).toBe('#fyp dancing all night 🔥');
  });
});
