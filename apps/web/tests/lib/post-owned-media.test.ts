import { describe, expect, it, vi } from 'vitest';
import {
  STAGED_SWEEP_MAX_DELETE,
  classifyBackfillRow,
  deletePostOwnedBytesBestEffort,
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

  it('records a per-key delete failure and keeps sweeping the rest', async () => {
    const store = new MockStorageProvider();
    const failing = `users/${userId}/post-staging/a/failing.mp4`;
    const ok = `users/${userId}/post-staging/b/ok.mp4`;
    for (const key of [failing, ok]) {
      await store.putObject({
        key,
        body: new Uint8Array([1]),
        contentType: 'video/mp4',
      });
      store.uploadedObjects.get(key)!.uploadedAt = OLD;
    }
    const realDelete = MockStorageProvider.prototype.deleteObject.bind(store);
    store.deleteObject = async (key: string) => {
      if (key === failing) throw new Error('R2 delete refused');
      return realDelete(key);
    };
    const report = await sweepUnclaimedStagedUploads(store, userId, new Set(), NOW);
    expect(report.failed).toEqual([failing]);
    expect(report.deleted).toEqual([ok]);
    expect(report.error).toBeNull();
  });

  it('skips staged keys of unknown age instead of deleting them', async () => {
    const store = new MockStorageProvider();
    const oldKey = `users/${userId}/post-staging/a/old.mp4`;
    const unknownAgeKey = `users/${userId}/post-staging/b/unknown.mp4`;
    store.listObjects = async () => [
      { key: oldKey, lastModified: OLD },
      { key: unknownAgeKey, lastModified: null },
    ];
    const report = await sweepUnclaimedStagedUploads(store, userId, new Set(), NOW);
    expect(report.deleted).toEqual([oldKey]);
    expect(report.skipped).toBe(1);
  });
});

describe('deletePostOwnedBytesBestEffort', () => {
  it('deletes only the owning user\u2019s post-owned keys', async () => {
    const store = new MockStorageProvider();
    const owned = `users/${userId}/post-media/uuid/photo.jpg`;
    const staged = `users/${userId}/post-staging/uuid/clip.mp4`;
    const deleteSpy = vi.spyOn(store, 'deleteObject');

    await deletePostOwnedBytesBestEffort(store, userId, null);
    await deletePostOwnedBytesBestEffort(store, userId, undefined);
    await deletePostOwnedBytesBestEffort(store, userId, 'users/abc/media/1/photo.jpg');
    await deletePostOwnedBytesBestEffort(
      store,
      userId,
      `users/${otherUserId}/post-media/uuid/photo.jpg`
    );
    expect(deleteSpy).not.toHaveBeenCalled();

    await deletePostOwnedBytesBestEffort(store, userId, owned);
    await deletePostOwnedBytesBestEffort(store, userId, staged);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy).toHaveBeenNthCalledWith(1, owned);
    expect(deleteSpy).toHaveBeenNthCalledWith(2, staged);
  });

  it('never throws when the delete itself fails', async () => {
    const store = new MockStorageProvider();
    store.deleteObject = async () => {
      throw new Error('R2 delete refused');
    };
    await expect(
      deletePostOwnedBytesBestEffort(
        store,
        userId,
        `users/${userId}/post-media/uuid/photo.jpg`
      )
    ).resolves.toBeUndefined();
  });
});
