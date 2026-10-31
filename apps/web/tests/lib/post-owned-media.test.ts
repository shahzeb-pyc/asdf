import { describe, expect, it } from 'vitest';
import {
  STAGED_SWEEP_MAX_DELETE,
  classifyBackfillRow,
  isPostOwnedStorageKey,
  isPostStagingStorageKey,
  postOwnedCopyKey,
  storageKeyBasename,
  sweepUnclaimedStagedUploads,
} from '@/lib/publishing/post-owned-media';
import { MockStorageProvider } from '../helpers/mock-storage';

const userId = '11111111-1111-4111-a111-111111111111';
const otherUserId = '99999999-9999-4999-a999-999999999999';

describe('post-owned key helpers', () => {
  it('builds a post-media copy key that never escapes the user prefix', () => {
    const key = postOwnedCopyKey(userId, 'users/abc/media/123/My Photo (1).jpg');
    expect(key).toMatch(
      new RegExp(`^users/${userId}/post-media/[^/]+/My_Photo__1_\\.jpg$`)
    );
  });

  it('sanitises basenames (no directories, no leading dots/underscores)', () => {
    expect(storageKeyBasename('users/x/media/1/../../etc/passwd')).toBe('passwd');
    expect(storageKeyBasename('users/x/media/1/.hidden')).toBe('file');
    expect(storageKeyBasename('users/x/media/1/')).toBe('file');
  });

  it('recognises post-owned and staging prefixes, and only for the owning user', () => {
    const owned = `users/${userId}/post-media/uuid/photo.jpg`;
    const staged = `users/${userId}/post-staging/uuid/clip.mp4`;
    expect(isPostOwnedStorageKey(userId, owned)).toBe(true);
    expect(isPostOwnedStorageKey(userId, staged)).toBe(true);
    expect(isPostStagingStorageKey(userId, staged)).toBe(true);
    expect(isPostStagingStorageKey(userId, owned)).toBe(false);
    expect(isPostOwnedStorageKey(userId, 'users/abc/media/1/photo.jpg')).toBe(false);
    expect(isPostOwnedStorageKey(userId, `users/${otherUserId}/post-media/uuid/photo.jpg`)).toBe(false);
  });
});

describe('classifyBackfillRow', () => {
  it('copy: linked with bytes to copy', () => {
    expect(
      classifyBackfillRow({
        media_item_id: '44444444-4444-4444-a444-444444444444',
        media_storage_key: 'users/x/media/1/photo.jpg',
      })
    ).toBe('copy');
  });

  it('unlink-only: already post-owned bytes, link still set', () => {
    expect(
      classifyBackfillRow({
        media_item_id: '44444444-4444-4444-a444-444444444444',
        media_storage_key: `users/${userId}/post-media/uuid/photo.jpg`,
      })
    ).toBe('unlink-only');
    expect(
      classifyBackfillRow({
        media_item_id: '44444444-4444-4444-a444-444444444444',
        media_storage_key: `users/${userId}/post-staging/uuid/clip.mp4`,
      })
    ).toBe('unlink-only');
  });

  it('skip: already unlinked', () => {
    expect(
      classifyBackfillRow({ media_item_id: null, media_storage_key: 'users/x/media/1/photo.jpg' })
    ).toBe('skip');
  });

  it('unrecoverable: linked but no storage key survives', () => {
    expect(
      classifyBackfillRow({
        media_item_id: '44444444-4444-4444-a444-444444444444',
        media_storage_key: null,
      })
    ).toBe('unrecoverable');
    expect(
      classifyBackfillRow({
        media_item_id: '44444444-4444-4444-a444-444444444444',
        media_storage_key: '',
      })
    ).toBe('unrecoverable');
  });
});

describe('sweepUnclaimedStagedUploads', () => {
  const OLD = new Date('2026-01-01T00:00:00.000Z');
  const NOW = new Date('2026-10-31T00:00:00.000Z');

  async function seedStorage() {
    const store = new MockStorageProvider();
    const keys = {
      oldUnreferenced: `users/${userId}/post-staging/a/old.mp4`,
      oldReferenced: `users/${userId}/post-staging/b/kept.mp4`,
      fresh: `users/${userId}/post-staging/c/fresh.mp4`,
      library: `users/${userId}/media/d/photo.jpg`,
    };
    for (const key of Object.values(keys)) {
      await store.putObject({
        key,
        body: new Uint8Array([1]),
        contentType: 'video/mp4',
      });
    }
    // Backdate the two old entries; the mock records uploadedAt on
    // put, so rewrite it directly for a deterministic age.
    store.uploadedObjects.get(keys.oldUnreferenced)!.uploadedAt = OLD;
    store.uploadedObjects.get(keys.oldReferenced)!.uploadedAt = OLD;
    return { store, keys };
  }

  it('deletes old unreferenced staged uploads, keeps referenced/fresh/library keys', async () => {
    const { store, keys } = await seedStorage();
    const report = await sweepUnclaimedStagedUploads(
      store,
      userId,
      new Set([keys.oldReferenced]),
      NOW
    );
    expect(report.deleted).toEqual([keys.oldUnreferenced]);
    expect(store.uploadedObjects.has(keys.oldUnreferenced)).toBe(false);
    expect(store.uploadedObjects.has(keys.oldReferenced)).toBe(true);
    expect(store.uploadedObjects.has(keys.fresh)).toBe(true);
    expect(store.uploadedObjects.has(keys.library)).toBe(true);
    expect(report.error).toBeNull();
  });

  it('respects the per-run delete cap', async () => {
    const store = new MockStorageProvider();
    const total = STAGED_SWEEP_MAX_DELETE + 5;
    for (let i = 0; i < total; i++) {
      const key = `users/${userId}/post-staging/${i}/old.mp4`;
      await store.putObject({
        key,
        body: new Uint8Array([1]),
        contentType: 'video/mp4',
      });
      store.uploadedObjects.get(key)!.uploadedAt = OLD;
    }
    const report = await sweepUnclaimedStagedUploads(store, userId, new Set(), NOW);
    expect(report.deleted).toHaveLength(STAGED_SWEEP_MAX_DELETE);
    expect(report.skipped).toBe(5);
  });

  it('never throws: a listing failure is reported, not raised', async () => {
    const broken = new MockStorageProvider();
    broken.listObjects = async () => {
      throw new Error('R2 down');
    };
    const report = await sweepUnclaimedStagedUploads(broken, userId, new Set(), NOW);
    expect(report.error).toContain('R2 down');
    expect(report.deleted).toHaveLength(0);
  });
});
