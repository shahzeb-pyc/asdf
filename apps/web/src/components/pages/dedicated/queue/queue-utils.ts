/**
 * Queue section display helpers (pure functions): post-type labels,
 * status labels, and timezone-aware time formatting for derived
 * estimates and published times. No data fetching lives here.
 */

export type QueueRowStatus =
  | 'queued'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'skipped'
  | 'cancelled';

/** Plain-language type label from the wire postFormat. */
export function formatQueuePostType(postFormat: string): string {
  switch (postFormat) {
    case 'text':
      return 'Text';
    case 'image':
      return 'Image';
    case 'reel':
      return 'Reel';
    case 'video':
      return 'Video';
    case 'story':
      return 'Story';
    default:
      return 'Post';
  }
}

/** Plain-language status label from the wire queue status. */
export function formatQueueStatus(status: string): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'publishing':
      return 'Publishing';
    case 'published':
      return 'Published';
    case 'failed':
      return 'Failed';
    case 'cancelled':
    case 'skipped':
      return 'Cancelled';
    default:
      return 'Queued';
  }
}

const timeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimeFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = timeFormatterCache.get(timezone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone,
    });
  } catch (_e) {
    // Unknown zone: fall back to UTC rather than crashing the row.
    formatter = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC',
    });
  }
  timeFormatterCache.set(timezone, formatter);
  return formatter;
}

/** "Tue 28 Oct, 9:00 am" in the page timezone; null-safe. */
export function formatQueueTime(iso: string | null, timezone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return getTimeFormatter(timezone).format(date);
}
