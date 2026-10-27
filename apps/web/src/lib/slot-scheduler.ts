/**
 * Slot Scheduler Utility
 * Calculates the next vacant recurring slot time for a Facebook Page.
 * Spec: specs/005-publishing-engine/research.md (Section 5)
 */

export interface SlotSchedulerParams {
  slots: Array<{
    id: string;
    slotTime: string;
    timezone: string;
    isActive: boolean;
    allowedFormats?: string[] | null;
  }>;
  existingScheduledTimes: Date[];
  now?: Date;
  postFormat?: string | null;
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

function resolveValidTimezone(tz: string): string {
  if (!tz || typeof tz !== 'string') return 'UTC';
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function parseSlotTime(slotTime: string): { hour: number; minute: number; second: number } | null {
  if (!slotTime || typeof slotTime !== 'string') return null;
  const parts = slotTime.trim().split(':');
  if (parts.length < 2) return null;

  const hour = Number.parseInt(parts[0]!, 10);
  const minute = Number.parseInt(parts[1]!, 10);
  const second = parts.length > 2 ? Number.parseInt(parts[2]!, 10) : 0;

  if (Number.isNaN(hour) || Number.isNaN(minute) || Number.isNaN(second)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;

  return { hour, minute, second };
}

function getZonedDateParts(
  date: Date,
  timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
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
  const dtf = getFormatter(timeZone);
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const localDateAsUtc = Date.UTC(
    Number.parseInt(parts.year!, 10),
    Number.parseInt(parts.month!, 10) - 1,
    Number.parseInt(parts.day!, 10),
    Number.parseInt(parts.hour!, 10),
    Number.parseInt(parts.minute!, 10),
    Number.parseInt(parts.second!, 10)
  );
  return localDateAsUtc - date.getTime();
}

function makeZonedDate(
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
  const finalTime = targetLocalTime - offset;
  return new Date(finalTime);
}

/**
 * Calculates the next vacant recurring slot time for a Facebook Page.
 *
 * 1. Filters only active slots.
 * 2. In each slot's local timezone, checks the current day and subsequent days.
 * 3. Finds candidates strictly greater than `now`.
 * 4. Verifies candidate is not in `existingScheduledTimes`.
 * 5. Returns the earliest chronological vacant slot.
 */
export function calculateNextVacantSlot(
  params: SlotSchedulerParams
): { slotId: string; scheduledTime: Date } | null {
  const activeSlots = (params.slots || []).filter((s) => {
    if (!s.isActive) return false;
    if (params.postFormat && s.allowedFormats && s.allowedFormats.length > 0) {
      return s.allowedFormats.includes(params.postFormat);
    }
    return true;
  });
  if (activeSlots.length === 0) {
    return null;
  }

  const effectiveNow = params.now instanceof Date && !Number.isNaN(params.now.getTime())
    ? params.now
    : new Date();

  const validExistingTimes = (params.existingScheduledTimes || []).filter(
    (d) => d instanceof Date && !Number.isNaN(d.getTime())
  );

  const isOccupied = (candidateTime: Date): boolean => {
    const candidateMs = candidateTime.getTime();
    return validExistingTimes.some(
      (existing) => Math.abs(existing.getTime() - candidateMs) < 1000
    );
  };

  // Determine window of days to scan (guarantees more candidate slots than existing scheduled times)
  const windowDays = Math.max(14, Math.ceil((validExistingTimes.length + 14) / activeSlots.length));

  interface SlotCandidate {
    slotId: string;
    scheduledTime: Date;
  }

  const candidates: SlotCandidate[] = [];

  for (const slot of activeSlots) {
    const parsedTime = parseSlotTime(slot.slotTime);
    if (!parsedTime) continue;

    const tz = resolveValidTimezone(slot.timezone);
    const baseParts = getZonedDateParts(effectiveNow, tz);

    for (let dayOffset = 0; dayOffset <= windowDays; dayOffset++) {
      const baseLocalUtc = Date.UTC(baseParts.year, baseParts.month - 1, baseParts.day + dayOffset);
      const baseLocalDate = new Date(baseLocalUtc);
      const targetYear = baseLocalDate.getUTCFullYear();
      const targetMonth = baseLocalDate.getUTCMonth() + 1;
      const targetDay = baseLocalDate.getUTCDate();

      const scheduledTime = makeZonedDate(
        targetYear,
        targetMonth,
        targetDay,
        parsedTime.hour,
        parsedTime.minute,
        parsedTime.second,
        tz
      );

      if (scheduledTime.getTime() > effectiveNow.getTime()) {
        candidates.push({
          slotId: slot.id,
          scheduledTime,
        });
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  // Sort chronologically ascending
  candidates.sort((a, b) => a.scheduledTime.getTime() - b.scheduledTime.getTime());

  // Find the first vacant slot
  for (const candidate of candidates) {
    if (!isOccupied(candidate.scheduledTime)) {
      return candidate;
    }
  }

  return null;
}


// NOTE: the old recomputeSlotScheduledTime (timezone realignment of
// stored post times) was deleted with publisher-driven scheduling:
// queued posts store no times, so there is nothing to realign.
