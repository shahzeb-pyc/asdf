/**
 * Calendar View helpers (pure functions): month-grid construction in
 * the PAGE timezone, day-key bucketing, and per-status placement.
 *
 * Timezone discipline: every day key is a `yyyy-mm-dd` date in the
 * page timezone, never a browser-local date. Grid weeks are built by
 * stepping whole days from a 06:00 UTC anchor and formatting each
 * step in the page timezone. 06:00 UTC maps to a local time between
 * 18:00 (previous day) and 20:00 across every real zone — at least
 * 4 hours from midnight — so a 24h step always advances the local
 * date by exactly one day, even across DST transitions in zones
 * like Pacific/Norfolk where a noon-UTC anchor sits on midnight
 * and skips or duplicates a day. The grid is labelled by its
 * (year, month) numbers, not by formatting a Date, so the label
 * can never drift from the cells.
 *
 * Placement (owner's rules, 2026-10-29):
 * - queued → the derived estimate day (same estimate computation
 *   the Queue panel uses); a queued post with no estimate (no
 *   posting time matches its format) has no day and is reported
 *   separately, never silently dropped from the counts.
 * - published → the published day (publishedAt, falling back to
 *   updatedAt when a published row carries no publishedAt).
 * - every other status (failed, publishing, skipped, cancelled) →
 *   the last-update day (updatedAt).
 */

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Weekday headers, Sunday first (same order as the old calendar). */
export const CALENDAR_WEEKDAYS: ReadonlyArray<string> = WEEKDAY_SHORT;

const dayKeyFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dayTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();
const weekdayFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDayKeyFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = dayKeyFormatterCache.get(timezone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timezone,
    });
  } catch (_e) {
    // Unknown zone: fall back to UTC rather than crashing the view.
    formatter = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: 'UTC',
    });
  }
  dayKeyFormatterCache.set(timezone, formatter);
  return formatter;
}

function getDayTimeFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = dayTimeFormatterCache.get(timezone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone,
    });
  } catch (_e) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC',
    });
  }
  dayTimeFormatterCache.set(timezone, formatter);
  return formatter;
}

function getWeekdayFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = weekdayFormatterCache.get(timezone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      timeZone: timezone,
    });
  } catch (_e) {
    formatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      timeZone: 'UTC',
    });
  }
  weekdayFormatterCache.set(timezone, formatter);
  return formatter;
}

/** `yyyy-mm-dd` for an instant in the given timezone; null-safe. */
export function formatDayKey(date: Date, timezone: string): string | null {
  if (Number.isNaN(date.getTime())) return null;
  return getDayKeyFormatter(timezone).format(date);
}

/** `yyyy-mm-dd` for an ISO string in the given timezone; null-safe. */
export function formatDayKeyFromIso(iso: string | null, timezone: string): string | null {
  if (!iso) return null;
  return formatDayKey(new Date(iso), timezone);
}

/** "9:00 am" for an instant in the given timezone; null-safe. */
export function formatDayTime(date: Date, timezone: string): string | null {
  if (Number.isNaN(date.getTime())) return null;
  return getDayTimeFormatter(timezone).format(date);
}

/** "9:00 am" for an ISO string in the given timezone; null-safe. */
export function formatDayTimeFromIso(iso: string | null, timezone: string): string | null {
  if (!iso) return null;
  return formatDayTime(new Date(iso), timezone);
}

/** Today's day key in the given timezone. */
export function todayKey(timezone: string): string {
  return formatDayKey(new Date(), timezone) ?? '1970-01-01';
}

/** Day-of-month number for a `yyyy-mm-dd` key. */
export function dayNumberOfKey(dayKey: string): number {
  return Number(dayKey.slice(8, 10));
}

/** "October 2026" for a (year, month) pair (month is 0-based). */
export function formatMonthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month, 1)));
}

/** Previous month for a (year, month) pair (month is 0-based). */
export function prevMonth(year: number, month: number): { year: number; month: number } {
  return month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 };
}

/** Next month for a (year, month) pair (month is 0-based). */
export function nextMonth(year: number, month: number): { year: number; month: number } {
  return month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 };
}

/** (year, month) for today's date in the given timezone. */
export function currentYearMonth(timezone: string): { year: number; month: number } {
  const key = todayKey(timezone);
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) - 1 };
}

function weekdayIndexInTimezone(date: Date, timezone: string): number {
  const short = getWeekdayFormatter(timezone).format(date);
  const index = WEEKDAY_SHORT.indexOf(short);
  return index >= 0 ? index : 0;
}

/**
 * Month grid as weeks of `yyyy-mm-dd` keys in the given timezone,
 * Sunday first, full weeks only: leading days from the previous
 * month and trailing days from the next month are included (dimmed
 * by the panel), exactly like the old calendar's grid.
 */
export function getMonthGridKeys(
  year: number,
  month: number,
  timezone: string
): string[][] {
  // Last day of the month as pure calendar math — never derived
  // from an instant, so no timezone can shift it into the next month.
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const monthEndKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
  const monthStartKey = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  // First of the month at 06:00 UTC, then step back to its Sunday.
  const first = new Date(Date.UTC(year, month, 1, 6));
  const back = weekdayIndexInTimezone(first, timezone);
  const cursor = new Date(first.getTime() - back * 24 * 60 * 60 * 1000);
  const weeks: string[][] = [];
  for (;;) {
    const week: string[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(formatDayKey(cursor, timezone) ?? monthStartKey);
      cursor.setTime(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
    weeks.push(week);
    const lastKey = week[6] ?? monthStartKey;
    if (lastKey >= monthEndKey) break;
  }
  return weeks;
}

export type CalendarItemLike = {
  id: string;
  status: string;
  publishedAt: string | null;
  updatedAt: string;
};

/**
 * The day key an item belongs on, or null when it has no placeable
 * day: only queued posts without a derived estimate land here.
 * Published posts use publishedAt (updatedAt fallback); every other
 * status uses updatedAt.
 */
export function getItemDayKey(
  item: CalendarItemLike,
  estimate: Date | null,
  timezone: string
): string | null {
  if (item.status === 'queued') {
    return estimate ? formatDayKey(estimate, timezone) : null;
  }
  if (item.status === 'published') {
    return formatDayKeyFromIso(item.publishedAt ?? item.updatedAt, timezone);
  }
  return formatDayKeyFromIso(item.updatedAt, timezone);
}

/** The instant an entry sorts by within its day (null when unplaced). */
export function getItemSortInstant(
  item: CalendarItemLike,
  estimate: Date | null
): Date | null {
  if (item.status === 'queued') return estimate;
  if (item.status === 'published') {
    const iso = item.publishedAt ?? item.updatedAt;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(item.updatedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}
