/**
 * Publisher-driven posting-times scheduling (shared by the web app's
 * queue estimates and the worker's slot-claim tick).
 *
 * The model, decided by the product owner: queued posts store NO
 * posting time. The posting times ARE the schedule. When an active
 * posting time comes (in the page's timezone), the publisher takes
 * the first queued post that fits that time's allowed formats.
 * Changing times never rewrites anything on queued posts, because
 * nothing about the schedule lives on them.
 *
 * Rules encoded here, in one place:
 * - Queue order is preserved: the first queued fitting post goes first.
 * - Skip-ahead: a post that does not fit a time is skipped for that
 *   time; later fitting posts go first. It stays queued for a time
 *   that does fit it.
 * - One post per posting time per day per page (the claim row in the
 *   database enforces this; the due-slot finder below only ever
 *   reports a slot once per day).
 * - A missed time is LOST: a slot whose occurrence today is older
 *   than the claim window is not due, and is never caught up.
 * - Only active slots fire. A slot with no allowed formats matches
 *   nothing; a null/undefined format list (legacy rows) matches
 *   everything, matching the wire normalisation that backfills it.
 */

export interface PostingSlotInput {
  id: string;
  /** 'HH:MM' or 'HH:MM:SS', 24-hour. */
  timeOfDay: string;
  isActive: boolean;
  allowedFormats: readonly string[] | null | undefined;
}

export interface QueuedPostInput {
  id: string;
  /** Slot-format vocabulary: 'text' | 'image' | 'reel' | 'video' | 'story'. */
  format: string;
}

/** Queue-item (kind, platform_format) → slot-format vocabulary. */
export function itemSlotFormat(
  kind: string | null | undefined,
  platformFormat: string | null | undefined
): string {
  if (platformFormat === 'reel' || platformFormat === 'text' || platformFormat === 'story') {
    return platformFormat;
  }
  if (kind === 'image' || kind === 'video') return kind;
  if (typeof kind === 'string' && kind.length > 0) return kind;
  return 'text';
}

export function slotMatchesFormat(
  format: string,
  allowedFormats: readonly string[] | null | undefined
): boolean {
  if (allowedFormats === null || allowedFormats === undefined) return true;
  if (allowedFormats.length === 0) return false;
  return allowedFormats.includes(format);
}

export function parseTimeOfDay(
  timeOfDay: string
): { hour: number; minute: number; second: number } | null {
  if (!timeOfDay || typeof timeOfDay !== 'string') return null;
  const parts = timeOfDay.trim().split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const hour = Number.parseInt(parts[0]!, 10);
  const minute = Number.parseInt(parts[1]!, 10);
  const second = parts.length > 2 ? Number.parseInt(parts[2]!, 10) : 0;
  if (Number.isNaN(hour) || Number.isNaN(minute) || Number.isNaN(second)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }
  return { hour, minute, second };
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function resolveValidTimezone(tz: string | null | undefined): string {
  if (!tz || typeof tz !== 'string') return 'UTC';
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
}

export function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts & {
  hour: number;
  minute: number;
  second: number;
} {
  const dtf = getFormatter(timeZone);
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number.parseInt(parts.year!, 10),
    month: Number.parseInt(parts.month!, 10),
    day: Number.parseInt(parts.day!, 10),
    hour: Number.parseInt(parts.hour!, 10),
    minute: Number.parseInt(parts.minute!, 10),
    second: Number.parseInt(parts.second!, 10),
  };
}

function getTimezoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getZonedDateParts(date, timeZone);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return localAsUtc - date.getTime();
}

/** The instant at which a wall-clock time falls on a zoned calendar date. */
export function makeZonedDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  const targetLocalTime = Date.UTC(year, month - 1, day, hour, minute, second);
  const guess = targetLocalTime - getTimezoneOffsetMs(new Date(targetLocalTime), timeZone);
  const offset = getTimezoneOffsetMs(new Date(guess), timeZone);
  return new Date(targetLocalTime - offset);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 'YYYY-MM-DD' of an instant in the given timezone. */
export function zonedDateString(date: Date, timeZone: string): string {
  const parts = getZonedDateParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function compareTimeOfDay(
  a: { hour: number; minute: number; second: number },
  b: { hour: number; minute: number; second: number }
): number {
  if (a.hour !== b.hour) return a.hour - b.hour;
  if (a.minute !== b.minute) return a.minute - b.minute;
  return a.second - b.second;
}

interface ActiveSlot {
  slot: PostingSlotInput;
  parsed: { hour: number; minute: number; second: number };
}

function activeSlotsSorted(slots: readonly PostingSlotInput[]): ActiveSlot[] {
  const out: ActiveSlot[] = [];
  for (const slot of slots) {
    if (!slot.isActive) continue;
    const parsed = parseTimeOfDay(slot.timeOfDay);
    if (!parsed) continue;
    out.push({ slot, parsed });
  }
  out.sort((a, b) => compareTimeOfDay(a.parsed, b.parsed));
  return out;
}

/**
 * Derived estimates: for each queued post (in queue order), the next
 * posting-time occurrence it would go out at, walking active slots in
 * time order day by day with skip-ahead. A post whose format no active
 * slot allows maps to null (it waits, with the unmatched warning).
 * Estimates move when times change — that is intended, not a bug:
 * nothing is stored, so the estimate is always computed from the
 * current times.
 */
export function assignQueueEstimates(params: {
  slots: readonly PostingSlotInput[];
  timezone: string;
  /** Queue order: first element is first in queue. */
  posts: readonly QueuedPostInput[];
  now?: Date;
}): Map<string, Date | null> {
  const tz = resolveValidTimezone(params.timezone);
  const effectiveNow =
    params.now instanceof Date && !Number.isNaN(params.now.getTime())
      ? params.now
      : new Date();
  const slots = activeSlotsSorted(params.slots);
  const result = new Map<string, Date | null>();
  for (const post of params.posts) result.set(post.id, null);
  if (slots.length === 0 || params.posts.length === 0) return result;

  const remaining = [...params.posts];
  const today = getZonedDateParts(effectiveNow, tz);
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  // One slot per day at minimum, so posts.length + 1 days always
  // suffice; the +1 covers "today's remaining times are all past".
  const maxDays = params.posts.length + 1;

  for (let dayOffset = 0; dayOffset <= maxDays && remaining.length > 0; dayOffset++) {
    const day = new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000);
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const date = day.getUTCDate();
    for (const { slot, parsed } of slots) {
      if (remaining.length === 0) break;
      const occurrence = makeZonedDate(year, month, date, parsed.hour, parsed.minute, parsed.second, tz);
      if (occurrence.getTime() <= effectiveNow.getTime()) continue;
      const idx = remaining.findIndex((post) => slotMatchesFormat(post.format, slot.allowedFormats));
      if (idx === -1) continue;
      const [post] = remaining.splice(idx, 1);
      result.set(post!.id, occurrence);
    }
  }
  return result;
}

/**
 * Slots whose occurrence TODAY (in the page timezone) falls inside the
 * claim window (now - windowMinutes, now]. A slot outside the window
 * is not due: if its occurrence already passed beyond the window, the
 * time is lost — no catch-up. The database claim row (one per
 * destination + slot + claim date) guarantees a due slot fires once.
 */
export function findDueSlots(params: {
  slots: readonly PostingSlotInput[];
  timezone: string;
  now?: Date;
  windowMinutes?: number;
}): Array<{ slot: PostingSlotInput; claimDate: string; occurrence: Date }> {
  const tz = resolveValidTimezone(params.timezone);
  const effectiveNow =
    params.now instanceof Date && !Number.isNaN(params.now.getTime())
      ? params.now
      : new Date();
  const windowMs = (params.windowMinutes ?? 5) * 60 * 1000;
  const claimDate = zonedDateString(effectiveNow, tz);
  const today = getZonedDateParts(effectiveNow, tz);
  const out: Array<{ slot: PostingSlotInput; claimDate: string; occurrence: Date }> = [];
  for (const { slot, parsed } of activeSlotsSorted(params.slots)) {
    const occurrence = makeZonedDate(
      today.year,
      today.month,
      today.day,
      parsed.hour,
      parsed.minute,
      parsed.second,
      tz
    );
    const ageMs = effectiveNow.getTime() - occurrence.getTime();
    if (ageMs >= 0 && ageMs <= windowMs) {
      out.push({ slot, claimDate, occurrence });
    }
  }
  return out;
}

/** Formats present in queued posts that no active slot allows, in first-seen order. */
export function computeUnmatchedFormats(params: {
  posts: readonly QueuedPostInput[];
  slots: readonly PostingSlotInput[];
}): string[] {
  const active = activeSlotsSorted(params.slots);
  const unmatched: string[] = [];
  for (const post of params.posts) {
    if (unmatched.includes(post.format)) continue;
    const covered = active.some((s) => slotMatchesFormat(post.format, s.slot.allowedFormats));
    if (!covered) unmatched.push(post.format);
  }
  return unmatched;
}
