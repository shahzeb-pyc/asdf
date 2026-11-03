import { describe, it, expect } from 'vitest';
import {
  AgentKeyCreateResponseSchema,
  AgentKeyCreateSchema,
  AgentKeyListResponseSchema,
  AgentKeySchema,
  MUSE_CONNECT_PROMPT,
  MUSE_KEY_SCOPES,
  MuseActivityResponseSchema,
  isMuseKeyFormat,
  museKeyPrefix,
} from '../src/index.js';

describe('Muse key contracts', () => {
  it('locks scopes to media read/write only', () => {
    expect(MUSE_KEY_SCOPES).toEqual(['media:read', 'media:write']);
  });

  it('formats keys as fbu_ + 32 hex chars and prefixes by last 4', () => {
    const key = `fbu_${'a'.repeat(32)}`;
    expect(isMuseKeyFormat(key)).toBe(true);
    expect(museKeyPrefix(key)).toBe('fbu_…aaaa');
    expect(isMuseKeyFormat('fbu_short')).toBe(false);
    expect(isMuseKeyFormat('other_' + 'a'.repeat(32))).toBe(false);
  });

  it('rejects a key name that is empty or too long', () => {
    expect(AgentKeyCreateSchema.safeParse({ name: '' }).success).toBe(false);
    expect(
      AgentKeyCreateSchema.safeParse({ name: 'x'.repeat(101) }).success
    ).toBe(false);
    expect(
      AgentKeyCreateSchema.safeParse({ name: 'My Muse' }).success
    ).toBe(true);
  });

  it('never lets a list response carry a plaintext key', () => {
    const parsed = AgentKeyListResponseSchema.safeParse({
      keys: [
        {
          id: '11111111-1111-4111-a111-111111111111',
          name: 'My Muse',
          keyPrefix: 'fbu_…aaaa',
          scopes: ['media:read', 'media:write'],
          expiresAt: null,
          createdAt: '2026-11-03T00:00:00.000Z',
          lastUsedAt: null,
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('key' in parsed.data.keys[0]).toBe(false);
      expect('keyHash' in parsed.data.keys[0]).toBe(false);
    }
  });

  it('only the create response carries the key, and rejects other scopes', () => {
    const good = AgentKeyCreateResponseSchema.safeParse({
      id: '11111111-1111-4111-a111-111111111111',
      name: 'My Muse',
      keyPrefix: 'fbu_…aaaa',
      scopes: ['media:read', 'media:write'],
      expiresAt: null,
      createdAt: '2026-11-03T00:00:00.000Z',
      lastUsedAt: null,
      key: `fbu_${'b'.repeat(32)}`,
    });
    expect(good.success).toBe(true);
    const bad = AgentKeySchema.safeParse({
      id: '11111111-1111-4111-a111-111111111111',
      name: 'My Muse',
      keyPrefix: 'fbu_…aaaa',
      scopes: ['media:read'],
      expiresAt: null,
      createdAt: '2026-11-03T00:00:00.000Z',
      lastUsedAt: null,
    });
    expect(bad.success).toBe(false);
  });

  it('keeps the connect prompt exact: key first, guide, sign-in for browser help', () => {
    expect(MUSE_CONNECT_PROMPT).toContain(
      'https://app.fbuploadpro.com/muse_guide.md'
    );
    expect(MUSE_CONNECT_PROMPT).toContain(
      'Never ask me to paste the key in chat'
    );
    expect(MUSE_CONNECT_PROMPT).toContain('FBUploadPro sign-in');
    expect(MUSE_CONNECT_PROMPT).toContain(
      'help me use everything else in my browser'
    );
  });

  it('validates the activity response shape (today counts + day groups)', () => {
    const parsed = MuseActivityResponseSchema.safeParse({
      today: { videos: 2, images: 1, total: 3 },
      days: [
        {
          label: 'Today',
          date: '2026-11-03',
          rows: [
            {
              id: '22222222-2222-4222-a222-222222222222',
              mediaId: '33333333-3333-4333-a333-333333333333',
              mediaType: 'video',
              folderId: null,
              name: 'reel.mp4',
              createdAt: '2026-11-03T10:00:00.000Z',
            },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});
