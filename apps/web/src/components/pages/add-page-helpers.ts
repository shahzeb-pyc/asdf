/**
 * Add Page flow — pure helpers (spec 131 PR-131-2, spec §8.4
 * decomposition). Extracted verbatim from the former 1,233-line
 * add-page modal: the href builders, the account/page selection
 * computations, and the header/button copy computations. Names and
 * behaviour are preserved exactly — the parity suites
 * (tests/ui/pages.test.tsx) import them (re-exported from
 * `add-page-modal.tsx`), and the flow components consume the same
 * functions.
 */
import { getAccountHealth } from '@/components/accounts/account-health';
import type { FacebookAccountItem } from '@/components/accounts/account-card';

export interface DiscoveredPageItem {
  fbPageId: string;
  pageName: string;
  profilePictureUrl?: string | null | undefined;
  category?: string | null | undefined;
  currentFollowers?: number | undefined;
  followersCount?: number | undefined;
  tasks?: string[] | undefined;
  isImported: boolean;
}

export type AddPageStep =
  | 'select-account'
  | 'select-pages'
  | 'select-timezone'
  | 'select-posting-times';

/**
 * One posting time in the Add Page flow (steps 3–4). The shape mirrors
 * the server's ImportPostingTime: an HH:MM time plus the post types
 * that may go out at it. The same time + formats are applied to
 * every newly selected page — there is no per-page variant.
 */
export interface AddPagePostingTime {
  slotTime: string;
  allowedFormats: string[];
}

/** Post-type ids in the dedicated Posting Times order. */
export const ADD_PAGE_POST_FORMAT_IDS = [
  'reel',
  'image',
  'video',
  'story',
  'text',
] as const;

const ADD_PAGE_DEFAULT_TIMES = [
  '09:00',
  '12:00',
  '17:30',
  '20:00',
] as const;

/** A fresh posting time with every post type selected, as approved. */
export function createAddPagePostingTime(
  slotTime = '09:00'
): AddPagePostingTime {
  return {
    slotTime,
    allowedFormats: [...ADD_PAGE_POST_FORMAT_IDS],
  };
}

/**
 * The default time for a newly added row: the first default time not
 * already used, otherwise one hour after the latest used time. A
 * fresh row must never start as a duplicate — duplicates are
 * rejected by the import boundary and would leave Add disabled.
 */
export function nextAddPagePostingTime(
  existing: AddPagePostingTime[]
): AddPagePostingTime {
  const used = new Set(existing.map((time) => time.slotTime));
  for (const candidate of ADD_PAGE_DEFAULT_TIMES) {
    if (!used.has(candidate)) {
      return createAddPagePostingTime(candidate);
    }
  }
  const latest = [...used].sort().at(-1) ?? '09:00';
  const [hourText, minuteText] = latest.split(':');
  if (!hourText || !minuteText) {
    return createAddPagePostingTime('09:00');
  }
  const nextHour = (Number.parseInt(hourText, 10) + 1) % 24;
  const candidate = `${String(nextHour).padStart(2, '0')}:${minuteText}`;
  return createAddPagePostingTime(used.has(candidate) ? '09:00' : candidate);
}

export function isValidAddPagePostingTime(
  postingTime: AddPagePostingTime
): boolean {
  return (
    /^([01]\d|2[0-3]):[0-5]\d$/.test(postingTime.slotTime) &&
    postingTime.allowedFormats.length > 0
  );
}

/**
 * The Step 4 Add gate: a timezone must be picked, at least one
 * posting time must exist, every time must be valid, and no two
 * times may share the same clock time.
 */
export function isAddPageScheduleValid(
  timezone: string | null,
  postingTimes: AddPagePostingTime[]
): boolean {
  if (!timezone || postingTimes.length === 0) {
    return false;
  }
  if (!postingTimes.every(isValidAddPagePostingTime)) {
    return false;
  }
  const times = postingTimes.map((time) => time.slotTime);
  return new Set(times).size === times.length;
}

export function buildAccountsHref(subdomain: string): string {
  return `/tenant/${subdomain}/accounts`;
}

export function buildSettingsFacebookHref(subdomain: string): string {
  return `/tenant/${subdomain}/settings?tab=byoc`;
}

export function getActiveAccounts(
  accounts: FacebookAccountItem[]
): FacebookAccountItem[] {
  return accounts.filter((acc) => getAccountHealth(acc) === 'connected');
}

export function getExpiredAccounts(
  accounts: FacebookAccountItem[]
): FacebookAccountItem[] {
  return accounts.filter((acc) => getAccountHealth(acc) === 'expired');
}

export function getSelectablePageIds(pages: DiscoveredPageItem[]): string[] {
  return pages.filter((p) => !p.isImported).map((p) => p.fbPageId);
}

export function toggleSelectAllPages(
  pages: DiscoveredPageItem[],
  currentSelectedIds: string[]
): string[] {
  const selectableIds = getSelectablePageIds(pages);
  if (selectableIds.length === 0) {
    return [];
  }
  const currentSet = new Set(currentSelectedIds);
  const allSelected = selectableIds.every((id) => currentSet.has(id));
  return allSelected ? [] : selectableIds;
}

export function computeConfirmButtonText(
  isSubmitting: boolean,
  selectedCount: number
): string {
  if (isSubmitting) return 'Adding Pages...';
  if (selectedCount === 0) return 'Add Selected Pages';
  const unit = selectedCount === 1 ? 'Page' : 'Pages';
  return `Import ${selectedCount} ${unit}`;
}

export function computeHeaderSubtitle(
  step: AddPageStep,
  accountName?: string | null,
  pagesCount = 0
): string {
  if (step === 'select-account') {
    return 'Choose which connected Facebook account you want to import pages from.';
  }
  const name = accountName || 'Connected Account';
  if (step === 'select-pages') {
    const unit = pagesCount === 1 ? 'page available' : 'pages available';
    return `${name} · ${pagesCount} ${unit}`;
  }
  // Steps 3–4: pagesCount is the number of pages selected, and the
  // timezone + times shown here apply to all of them.
  const unit = pagesCount === 1 ? 'page selected' : 'pages selected';
  return `${name} · ${pagesCount} ${unit}`;
}

export function filterDiscoveredPages(
  pages: DiscoveredPageItem[],
  query: string
): DiscoveredPageItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return pages;
  return pages.filter(
    (p) =>
      p.pageName.toLowerCase().includes(q) ||
      Boolean(p.category?.toLowerCase().includes(q))
  );
}
