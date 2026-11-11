/**
 * "Last updated" for a stored follower total, in the given IANA
 * timezone (never the browser timezone's bare output).
 *
 * Null when the timestamp is absent or unparseable, or the timezone
 * is not a supported IANA zone — so callers show a dash (or omit
 * the line) instead of a faked time. Shared by the Pages dashboard
 * (spec 162), the ADU hub/detail cards, and the mirror views.
 */
export function formatFollowersUpdatedAt(
  iso: string | null | undefined,
  timezone: string
): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  if (
    typeof Intl.supportedValuesOf !== 'function' ||
    !Intl.supportedValuesOf('timeZone').includes(timezone)
  ) {
    return null;
  }
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(date);
}
