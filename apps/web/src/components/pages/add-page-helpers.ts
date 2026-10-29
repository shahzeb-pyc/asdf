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
import { ALL_POST_FORMATS } from './dedicated/posting-times/posting-time-utils';

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

/**
 * Post-type ids, derived from the dedicated Posting Times canonical
 * list — never a second hand-maintained copy of it.
 */
export const ADD_PAGE_POST_FORMAT_IDS: readonly string[] =
  ALL_POST_FORMATS.map((format) => format.id);

/** At most one posting time per hour of the day, server and client. */
export const MAX_ADD_PAGE_POSTING_TIMES = 24;

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
 * Post-type ids re-sorted into the canonical
 * Reels/Photos/Videos/Stories/Text order, so deselecting then
 * reselecting a type never scrambles the stored order. Unknown ids
 * (none are produced by the UI) keep their relative order at the end.
 */
export function sortAddPageFormats(formats: string[]): string[] {
  const order = new Map(
    ALL_POST_FORMATS.map((format, index) => [format.id, index])
  );
  const orderOf = (id: string) => order.get(id) ?? ALL_POST_FORMATS.length;
  const seen = new Set<string>();
  const unique = formats.filter((format) => {
    if (seen.has(format)) return false;
    seen.add(format);
    return true;
  });
  return unique.sort((a, b) => orderOf(a) - orderOf(b));
}

/**
 * The next genuinely free time for a new row, or null when none of
 * the candidate slots is free. Candidates, in order: the four
 * defaults, then hourly steps forward from the latest used time
 * (wrapping past midnight, same minutes), then half-hour steps, then
 * every remaining :00/:30 slot of the day. A fresh row must never
 * start as a duplicate — duplicates are rejected by the import
 * boundary and would leave Add disabled.
 */
/** HH:MM, 24-hour clock — shared by validation and free-time search. */
const ADD_PAGE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function findFreeAddPagePostingTime(
  existing: AddPagePostingTime[]
): AddPagePostingTime | null {
  // Only well-formed times count: a cleared or malformed row must
  // never steer the candidate arithmetic into an invalid time.
  const used = new Set(
    existing
      .map((time) => time.slotTime)
      .filter((slotTime) => ADD_PAGE_TIME_PATTERN.test(slotTime))
  );
  const candidates: string[] = [...ADD_PAGE_DEFAULT_TIMES];
  const latest = [...used].sort().at(-1) ?? '09:00';
  const [latestHourText, latestMinuteText] = latest.split(':');
  const latestHour = Number.parseInt(latestHourText ?? '9', 10);
  const latestMinute = latestMinuteText ?? '00';
  const pad = (n: number) => String(n).padStart(2, '0');
  for (let step = 1; step <= 24; step += 1) {
    candidates.push(`${pad((latestHour + step) % 24)}:${latestMinute}`);
  }
  for (let step = 1; step <= 24; step += 1) {
    const minute = latestMinute === '30' ? '00' : '30';
    candidates.push(`${pad((latestHour + step) % 24)}:${minute}`);
  }
  for (let hour = 0; hour < 24; hour += 1) {
    candidates.push(`${pad(hour)}:00`, `${pad(hour)}:30`);
  }
  for (const candidate of candidates) {
    if (!used.has(candidate)) {
      return createAddPagePostingTime(candidate);
    }
  }
  return null;
}

/**
 * The default time for a newly added row: the first free candidate
 * from findFreeAddPagePostingTime. Callers that gate the button
 * should use canAddAnotherPostingTime instead; this fallback only
 * exists for callers that must produce a row unconditionally, and
 * the Add gate will still block a duplicate row from being sent.
 */
export function nextAddPagePostingTime(
  existing: AddPagePostingTime[]
): AddPagePostingTime {
  return findFreeAddPagePostingTime(existing) ?? createAddPagePostingTime();
}

/** Whether another row can be added: under the cap and a free slot. */
export function canAddAnotherPostingTime(
  existing: AddPagePostingTime[]
): boolean {
  return (
    existing.length < MAX_ADD_PAGE_POSTING_TIMES &&
    findFreeAddPagePostingTime(existing) !== null
  );
}

export function isValidAddPagePostingTime(
  postingTime: AddPagePostingTime
): boolean {
  return (
    ADD_PAGE_TIME_PATTERN.test(postingTime.slotTime) &&
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
  if (
    !timezone ||
    postingTimes.length === 0 ||
    postingTimes.length > MAX_ADD_PAGE_POSTING_TIMES
  ) {
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
  // Step 2 counts pages available; steps 3–4 count pages selected,
  // and the timezone + times shown here apply to all of them.
  const singular = step === 'select-pages' ? 'page available' : 'page selected';
  const plural = step === 'select-pages' ? 'pages available' : 'pages selected';
  const unit = pagesCount === 1 ? singular : plural;
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
