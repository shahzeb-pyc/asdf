import { describe, expect, it } from 'vitest';
import {
  failedThreadsAccounts,
  mergeThreadsPublishNowResults,
  unpublishedThreadsAccounts,
} from './results';
import type {
  ThreadsPublishNowResultItem,
  ThreadsPublishNowSelectedAccount,
} from './types';

const account = (id: string): ThreadsPublishNowSelectedAccount => ({
  accountId: id,
  threadsUserId: `user-${id}`,
  accountName: `Account ${id}`,
  handle: `handle-${id}`,
  profilePictureUrl: null,
});

const result = (
  id: string,
  status: 'published' | 'failed'
): ThreadsPublishNowResultItem => ({
  accountId: id,
  threadsUserId: `user-${id}`,
  accountName: `Account ${id}`,
  handle: `handle-${id}`,
  status,
  postId: status === 'published' ? `post-${id}` : null,
  reason: status === 'failed' ? 'Publishing failed.' : null,
});

describe('Threads Publish Now results helpers', () => {
  it('excludes already-published accounts from a second Publish click', () => {
    const selected = [account('a'), account('b')];
    const results = [result('a', 'published'), result('b', 'failed')];
    expect(unpublishedThreadsAccounts(selected, results).map((a) => a.accountId)).toEqual(['b']);
    expect(unpublishedThreadsAccounts(selected, [result('a', 'published'), result('b', 'published')])).toEqual([]);
  });

  it('merges run-2 results without losing run-1 successes', () => {
    const run1 = [result('a', 'published'), result('b', 'failed')];
    const run2 = [result('b', 'published')];
    const merged = mergeThreadsPublishNowResults(run1, run2);
    expect(merged.map((r) => [r.accountId, r.status])).toEqual([
      ['a', 'published'],
      ['b', 'published'],
    ]);
    // A brand-new account in run 2 is appended, not dropped.
    const run3 = [result('c', 'failed')];
    expect(mergeThreadsPublishNowResults(merged, run3).map((r) => r.accountId)).toEqual(['a', 'b', 'c']);
  });

  it('retry-failed-only picks only failed accounts, never successes', () => {
    const selected = [account('a'), account('b'), account('c')];
    const results = [result('a', 'published'), result('b', 'failed')];
    expect(failedThreadsAccounts(selected, results).map((a) => a.accountId)).toEqual(['b']);
  });
});
