import { describe, expect, it } from 'vitest';
import {
  THREADS_OAUTH_SCOPES,
  ThreadsPlatformOptionsSchema,
  countThreadsLinks,
  parseThreadsPlatformOptions,
  threadsWeightedTextLength,
  truncateThreadsCaption,
  validateThreadsText,
} from '../../src/index.js';

describe('Threads options (spec 124)', () => {
  it('requests the publish scopes at connect', () => {
    expect(THREADS_OAUTH_SCOPES).toEqual([
      'threads_basic',
      'threads_content_publish',
    ]);
  });

  it('accepts a valid options set and defaults to empty', () => {
    expect(parseThreadsPlatformOptions({})).toEqual({});
    expect(parseThreadsPlatformOptions(undefined)).toEqual({});
    const parsed = parseThreadsPlatformOptions({
      replyControl: 'mentioned_only',
      topicTag: 'LaunchDay',
      altText: 'A screenshot of the new dashboard',
      carouselItems: [
        { mediaUrl: 'https://cdn.example.com/1.jpg', mediaType: 'image' },
        { mediaUrl: 'https://cdn.example.com/2.jpg', mediaType: 'image' },
      ],
      replyChain: [{ text: 'Part two' }, { text: 'Part three' }],
    });
    expect(parsed.replyControl).toBe('mentioned_only');
    expect(parsed.carouselItems).toHaveLength(2);
    expect(parsed.replyChain).toHaveLength(2);
  });

  it('rejects carousels outside 2–20 items', () => {
    const item = { mediaUrl: 'https://cdn.example.com/1.jpg', mediaType: 'image' as const };
    expect(ThreadsPlatformOptionsSchema.safeParse({ carouselItems: [item] }).success).toBe(false);
    expect(
      ThreadsPlatformOptionsSchema.safeParse({
        carouselItems: Array.from({ length: 21 }, () => item),
      }).success
    ).toBe(false);
  });

  it('rejects unknown reply controls and topic tags with periods or ampersands', () => {
    expect(ThreadsPlatformOptionsSchema.safeParse({ replyControl: 'nobody' }).success).toBe(false);
    expect(ThreadsPlatformOptionsSchema.safeParse({ topicTag: 'bad.tag' }).success).toBe(false);
    expect(ThreadsPlatformOptionsSchema.safeParse({ topicTag: 'bad&tag' }).success).toBe(false);
    expect(ThreadsPlatformOptionsSchema.safeParse({ topicTag: 'x'.repeat(51) }).success).toBe(false);
  });

  it('rejects combining a text attachment with a link attachment, and quote with reply', () => {
    expect(
      ThreadsPlatformOptionsSchema.safeParse({
        textAttachment: 'long form',
        linkAttachment: 'https://example.com',
      }).success
    ).toBe(false);
    expect(
      ThreadsPlatformOptionsSchema.safeParse({
        quotePostId: 'post-1',
        replyToId: 'post-2',
      }).success
    ).toBe(false);
  });

  it('caps the text attachment at 10,000 characters', () => {
    expect(
      ThreadsPlatformOptionsSchema.safeParse({ textAttachment: 'x'.repeat(10000) }).success
    ).toBe(true);
    expect(
      ThreadsPlatformOptionsSchema.safeParse({ textAttachment: 'x'.repeat(10001) }).success
    ).toBe(false);
  });

  it('weighted text length counts UTF-8 bytes, so emoji weigh more than one', () => {
    expect(threadsWeightedTextLength('hello')).toBe(5);
    // 🎉 is a single visible character but 4 UTF-8 bytes.
    expect(threadsWeightedTextLength('🎉')).toBe(4);
    expect(threadsWeightedTextLength('café')).toBe(5);
  });

  it('text validation enforces the 500 weighted cap and the 5-link cap', () => {
    expect(validateThreadsText('short post')).toBeNull();
    expect(validateThreadsText('x'.repeat(501))).toContain('500');
    // 126 party emoji = 504 weighted characters — over the cap while
    // looking like a short post.
    expect(validateThreadsText('🎉'.repeat(126))).toContain('500');
    expect(validateThreadsText('🎉'.repeat(125))).toBeNull();
    const sixLinks = Array(6).fill('https://example.com').join(' ');
    expect(validateThreadsText(sixLinks)).toContain('5 links');
    expect(countThreadsLinks('see https://a.com and https://b.com/x')).toBe(2);
  });

  it('mirror caption truncation leaves valid text untouched', () => {
    expect(truncateThreadsCaption('short post')).toBe('short post');
    expect(truncateThreadsCaption('x'.repeat(500))).toBe('x'.repeat(500));
    expect(validateThreadsText(truncateThreadsCaption('short post'))).toBeNull();
  });

  it('mirror caption truncation cuts plain text to 500 weighted characters with no marker', () => {
    const truncated = truncateThreadsCaption('x'.repeat(600));
    expect(truncated).toBe('x'.repeat(500));
    expect(truncated).not.toContain('…');
    expect(truncated).not.toContain('...');
    expect(validateThreadsText(truncated)).toBeNull();
  });

  it('mirror caption truncation never splits an emoji at the boundary', () => {
    // 124 party emoji = 496 weighted characters; one more would be 500,
    // the next would push it to 504, so the cut keeps exactly 125.
    const truncated = truncateThreadsCaption('🎉'.repeat(200));
    expect(truncated).toBe('🎉'.repeat(125));
    expect(threadsWeightedTextLength(truncated)).toBe(500);
    expect(validateThreadsText(truncated)).toBeNull();
    // A ZWJ family emoji is one grapheme: cutting must not split it.
    const family = '👨‍👩‍👧';
    const mixed = `a${family.repeat(200)}`;
    const cut = truncateThreadsCaption(mixed);
    expect(validateThreadsText(cut)).toBeNull();
    expect(cut).not.toContain('�');
    // The cut must land on a whole family emoji, never mid-cluster.
    expect(cut.endsWith(family)).toBe(true);
  });

  it('mirror caption truncation keeps the first 5 links and removes the rest, keeping the words', () => {
    const links = Array.from({ length: 7 }, (_, i) => `https://example.com/${i}`);
    const text = `start ${links.join(' middle ')} end`;
    const truncated = truncateThreadsCaption(text);
    expect(countThreadsLinks(truncated)).toBe(5);
    for (let i = 0; i < 5; i += 1) {
      expect(truncated).toContain(`https://example.com/${i}`);
    }
    expect(truncated).not.toContain('https://example.com/5');
    expect(truncated).not.toContain('https://example.com/6');
    expect(truncated).toContain('start');
    expect(truncated).toContain('middle');
    expect(truncated).toContain('end');
    expect(truncated).not.toContain('  ');
    expect(validateThreadsText(truncated)).toBeNull();
  });

  it('mirror caption truncation applies the length cut after removing extra links', () => {
    const links = Array.from({ length: 7 }, (_, i) => `https://example.com/${i}`);
    const text = `${'y'.repeat(600)} ${links.join(' ')}`;
    const truncated = truncateThreadsCaption(text);
    expect(threadsWeightedTextLength(truncated)).toBeLessThanOrEqual(500);
    expect(countThreadsLinks(truncated)).toBeLessThanOrEqual(5);
    expect(validateThreadsText(truncated)).toBeNull();
  });

  it('mirror caption truncation never cuts in the middle of a link', () => {
    // 480 plain characters, then a 40-character link: the 500 cut
    // would land inside the link, so the link must be dropped whole.
    const link = `https://example.com/${'a'.repeat(20)}`;
    expect(link.length).toBeGreaterThan(20);
    const text = `${'x'.repeat(480)} ${link}`;
    const truncated = truncateThreadsCaption(text);
    expect(truncated).toBe('x'.repeat(480));
    expect(validateThreadsText(truncated)).toBeNull();
  });
});
