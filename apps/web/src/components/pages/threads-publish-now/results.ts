import type {
  ThreadsPublishNowResultItem,
  ThreadsPublishNowSelectedAccount,
} from './types';

/**
 * Merge a new publish run's results into the previous run's:
 * rows for accounts in the new run are replaced, all other
 * rows are kept, and brand-new accounts are appended. This is
 * what stops a second Publish click from wiping run-1
 * successes off the results panel.
 */
export function mergeThreadsPublishNowResults(
  prev: ThreadsPublishNowResultItem[],
  next: ThreadsPublishNowResultItem[]
): ThreadsPublishNowResultItem[] {
  const byKey = new Map(next.map((result) => [result.accountId, result]));
  const merged = prev.map((result) => byKey.get(result.accountId) ?? result);
  for (const result of next) {
    if (!prev.some((p) => p.accountId === result.accountId)) merged.push(result);
  }
  return merged;
}

/** Accounts in this run that have NOT published yet. */
export function unpublishedThreadsAccounts(
  selected: ThreadsPublishNowSelectedAccount[],
  results: ThreadsPublishNowResultItem[]
): ThreadsPublishNowSelectedAccount[] {
  const publishedIds = new Set(
    results.filter((r) => r.status === 'published').map((r) => r.accountId)
  );
  return selected.filter((account) => !publishedIds.has(account.accountId));
}

/** Accounts whose latest result is a failure (retry candidates). */
export function failedThreadsAccounts(
  selected: ThreadsPublishNowSelectedAccount[],
  results: ThreadsPublishNowResultItem[]
): ThreadsPublishNowSelectedAccount[] {
  const failedIds = new Set(
    results.filter((r) => r.status === 'failed').map((r) => r.accountId)
  );
  return selected.filter((account) => failedIds.has(account.accountId));
}
