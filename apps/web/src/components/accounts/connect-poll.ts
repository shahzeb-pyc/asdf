/**
 * Connect-modal polling — pure helpers (moved verbatim from
 * connect-account-modal.tsx so they are unit-testable without
 * mounting the dialog; the modal re-exports them).
 *
 * Audit BG15: the poll must see EVERY account, not just page 1
 * (the list API defaults to 30 per page). fetchAllAccountsForPoll
 * pages through the whole list at the API's max page size, bounded
 * so a pathological workspace cannot loop forever.
 *
 * Audit BG19: in the reconnect branch, a mismatch must come from
 * an actual (re)connection event on another account — a brand-new
 * id, or an expired→active flip — never from a mere updatedAt
 * bump, which background refreshes also produce. The old code
 * fired `reconnected_mismatch` on any unrelated update, before
 * the target had a chance to reconnect.
 */

export interface AccountStateRecord {
  status?: string | undefined;
  updatedAt?: string | undefined;
}

export interface AccountSnapshot {
  id: string;
  fbAccountId?: string | undefined;
  displayName?: string | undefined;
  status?: string | undefined;
  updatedAt?: string | undefined;
}

export interface ReconnectingAccount {
  id: string;
  fbAccountId?: string | undefined;
  displayName: string;
  status?: string | undefined;
  updatedAt?: string | undefined;
}

export type PollOutcome =
  | { matched: false }
  | {
      matched: true;
      kind: 'connected';
      accountId: string;
      accountName?: string | undefined;
    }
  | {
      matched: true;
      kind: 'already_connected';
      accountId: string;
      accountName: string;
    }
  | {
      matched: true;
      kind: 'reconnected_mismatch';
      accountId: string;
      newAccountName: string;
      expectedAccountName: string;
    };

export function isAccountUpdatedInSnapshot(
  acc: AccountSnapshot,
  initialIds: Set<string>,
  initialStates: Map<string, AccountStateRecord>
): boolean {
  if (!initialIds.has(acc.id)) {
    return true;
  }
  const prevState = initialStates.get(acc.id);
  if (!prevState) {
    return false;
  }
  if (prevState.status === 'expired' && acc.status === 'active') {
    return true;
  }
  return Boolean(acc.updatedAt && prevState.updatedAt && acc.updatedAt !== prevState.updatedAt);
}

function isTargetReconnected(
  acc: AccountSnapshot,
  reconnectingAccount: ReconnectingAccount,
  initialStates: Map<string, AccountStateRecord>
): boolean {
  const isMatchingId =
    acc.id === reconnectingAccount.id ||
    Boolean(reconnectingAccount.fbAccountId && acc.fbAccountId === reconnectingAccount.fbAccountId);
  if (!isMatchingId) {
    return false;
  }
  const prevState = initialStates.get(acc.id);
  const prevStatus = prevState?.status ?? reconnectingAccount.status ?? 'expired';
  if (prevStatus === 'expired' && acc.status === 'active') {
    return true;
  }
  const prevUpdatedAt = prevState?.updatedAt ?? reconnectingAccount.updatedAt;
  return Boolean(acc.updatedAt && prevUpdatedAt && acc.updatedAt !== prevUpdatedAt);
}

/**
 * Audit BG19 — a genuine (re)connection event on an account that
 * is NOT the reconnect target: either the account is new, or it
 * flipped expired→active (only a connect does that; background
 * refreshes lapse accounts toward expired, never toward active).
 * A bare updatedAt change is deliberately NOT an event.
 */
export function isAccountConnectionEvent(
  acc: AccountSnapshot,
  initialIds: Set<string>,
  initialStates: Map<string, AccountStateRecord>
): boolean {
  if (!initialIds.has(acc.id)) {
    return true;
  }
  const prevState = initialStates.get(acc.id);
  return prevState?.status === 'expired' && acc.status === 'active';
}

export function evaluateAccountConnectionPoll(
  accounts: AccountSnapshot[],
  initialIds: Set<string>,
  initialStates: Map<string, AccountStateRecord>,
  reconnectingAccount?: ReconnectingAccount | null
): PollOutcome {
  if (reconnectingAccount) {
    const targetAcc = accounts.find((acc) =>
      isTargetReconnected(acc, reconnectingAccount, initialStates)
    );
    if (targetAcc) {
      return {
        matched: true,
        kind: 'connected',
        accountId: targetAcc.id,
        accountName: targetAcc.displayName,
      };
    }
    const differentAcc = accounts.find(
      (acc) =>
        acc.id !== reconnectingAccount.id &&
        isAccountConnectionEvent(acc, initialIds, initialStates)
    );
    if (differentAcc) {
      return {
        matched: true,
        kind: 'reconnected_mismatch',
        accountId: differentAcc.id,
        newAccountName: differentAcc.displayName || 'another account',
        expectedAccountName: reconnectingAccount.displayName,
      };
    }
    return { matched: false };
  }

  const newAcc = accounts.find((acc) => !initialIds.has(acc.id));
  if (newAcc) {
    return {
      matched: true,
      kind: 'connected',
      accountId: newAcc.id,
      accountName: newAcc.displayName,
    };
  }

  const refreshedAcc = accounts.find((acc) =>
    isAccountUpdatedInSnapshot(acc, initialIds, initialStates)
  );
  if (refreshedAcc) {
    return {
      matched: true,
      kind: 'already_connected',
      accountId: refreshedAcc.id,
      accountName: refreshedAcc.displayName || 'Account',
    };
  }

  return { matched: false };
}

/** Page size the poll requests (the list API clamps limit to 50). */
export const CONNECT_POLL_PAGE_SIZE = 50;
/** Hard bound on polled pages: 50 × 20 = 1,000 accounts. */
export const CONNECT_POLL_MAX_PAGES = 20;

export interface PollPage {
  accounts: AccountSnapshot[];
  totalPages: number;
}

/**
 * Audit BG15 — page through the whole accounts list. Stops at
 * the reported last page, at the page bound, or on an empty page
 * (a defensive stop if the server disagrees with its own meta).
 */
export async function fetchAllAccountsForPoll(
  fetchPage: (page: number, limit: number) => Promise<PollPage>
): Promise<AccountSnapshot[]> {
  const all: AccountSnapshot[] = [];
  let page = 1;
  let totalPages = 1;
  while (page <= totalPages && page <= CONNECT_POLL_MAX_PAGES) {
    const { accounts, totalPages: reported } = await fetchPage(
      page,
      CONNECT_POLL_PAGE_SIZE
    );
    if (accounts.length === 0) break;
    all.push(...accounts);
    totalPages = Math.max(1, reported || 1);
    page += 1;
  }
  return all;
}
