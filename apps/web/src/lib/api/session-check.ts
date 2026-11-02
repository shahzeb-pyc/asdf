/**
 * Global session check (session-global-check spec §2.2): the ONE
 * database-backed session check, run by the app shell (see
 * `lib/data/provider.tsx`) on mount, every 5 minutes, and on
 * window focus (throttled to once a minute).
 *
 * The check calls the session-status endpoint (`GET
 * /api/auth/session`) with raw `fetch`, deliberately NOT the typed
 * API client: the client maps 401s to the session-expired error
 * kind, and this check must interpret the status itself — 401
 * means proven dead (bounce), anything else failing means
 * "unknown" (neutral, retry on schedule), never a bounce.
 */

/** How often the shell revalidates the session in the background. */
export const SESSION_CHECK_INTERVAL_MS = 300_000;

/** Minimum gap between focus-triggered revalidations. */
export const SESSION_CHECK_FOCUS_THROTTLE_MS = 60_000;

/** The session-status endpoint path (global, no subdomain). */
export const SESSION_STATUS_PATH = '/api/auth/session';

/**
 * `'active'` — session proven alive.
 * `'dead'` — session proven dead (endpoint answered 401).
 * `'error'` — the check itself failed (503, 5xx, network error,
 * or an unparseable outcome): neutral, never a bounce.
 */
export type SessionCheckResult = 'active' | 'dead' | 'error';

/**
 * Run one global session check. Only the HTTP status is interpreted;
 * the body is never parsed, so a malformed body cannot change the
 * outcome. Never throws: every failure mode maps to `'error'`.
 */
export async function checkSessionStatus(
  fetchFn: typeof fetch = globalThis.fetch
): Promise<SessionCheckResult> {
  let response: Response;
  try {
    response = await fetchFn(SESSION_STATUS_PATH, {
      method: 'GET',
      credentials: 'same-origin',
    });
  } catch {
    // Deliberately silent: a failed check is routine (offline,
    // flaky network) and the next scheduled check retries. It must
    // never surface as an error, and never bounce.
    return 'error';
  }
  if (response.status === 200) return 'active';
  if (response.status === 401) return 'dead';
  return 'error';
}
