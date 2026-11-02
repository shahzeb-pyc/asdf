/**
 * Global 401 / session-expired handling (spec 137 §3.1, as narrowed
 * by the session-global-check spec §2.3).
 *
 * A 401 still maps to a `session-expired` ApiError, but it only
 * navigates from two sources: the global session check (the shell's
 * periodic revalidation proving the session dead) and foreground
 * mutations (see `lib/api/client.ts` — queries/polls/refetches
 * never navigate, so a single failed background call can no longer
 * yank the whole page to login). Whichever source fires, exactly
 * one reaction happens per session expiry — no matter how many
 * requests race to 401 at once: the registered handler runs
 * (PR-A1b's provider registers one that clears the query cache),
 * then the browser is sent to
 * `/login?next=<current path>&reason=session-expired`.
 *
 * The login route itself is excluded, and a re-entrancy latch keeps
 * the handler single-shot until `resetSessionExpiredGuard()` is called
 * (the data-layer provider does that on mount / after a fresh sign-in).
 */

import { reportError } from '../report-error';

export interface SessionExpiredInfo {
  /** The in-app path the user was on when the session expired. */
  path: string;
}

export type SessionExpiredHandler = (info: SessionExpiredInfo) => void | Promise<void>;

export interface SessionExpiredHandlerDeps {
  /** Clear cached server data before leaving the page (React Query cache). */
  clearCache?: () => void;
  /** Perform the navigation. Defaults to `window.location.assign`. */
  navigate?: (url: string) => void;
  /** Resolve the current in-app path. Defaults to the browser location. */
  getPath?: () => string;
}

let registeredHandler: SessionExpiredHandler | null = null;
let handled = false;

/** True for the login route (and its query/fragment variants). */
export function isLoginPath(path: string): boolean {
  return path === '/login' || path.startsWith('/login?') || path.startsWith('/login#') || path.startsWith('/login/');
}

/** The login URL a session expiry redirects to, honouring `next`. */
export function buildSessionExpiredUrl(currentPath: string): string {
  return `/login?next=${encodeURIComponent(currentPath)}&reason=session-expired`;
}

/** Current in-app path (pathname + search); `/` when not in a browser. */
export function getCurrentPath(): string {
  if (typeof window === 'undefined') return '/';
  return `${window.location.pathname}${window.location.search}`;
}

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

/**
 * Build the standard handler: clear the cache hook, then redirect to
 * login exactly via `navigate`. Login-route paths are never redirected
 * (that would loop the login page onto itself).
 */
export function createSessionExpiredHandler(
  deps: SessionExpiredHandlerDeps = {}
): SessionExpiredHandler {
  const navigate = deps.navigate ?? defaultNavigate;
  return (info) => {
    deps.clearCache?.();
    if (isLoginPath(info.path)) return;
    navigate(buildSessionExpiredUrl(info.path));
  };
}

/**
 * Register the single global handler. PR-A1b's data-layer provider
 * calls this once on mount with a handler built by
 * `createSessionExpiredHandler` (its `clearCache` clears the query
 * cache). Returns an unregister function.
 */
export function registerSessionExpiredHandler(handler: SessionExpiredHandler): () => void {
  registeredHandler = handler;
  return () => {
    if (registeredHandler === handler) registeredHandler = null;
  };
}

/** Re-arm the exactly-once latch (fresh sign-in / provider remount). */
export function resetSessionExpiredGuard(): void {
  handled = false;
}

/**
 * React to a 401. Returns true when this call performed the reaction,
 * false when it was suppressed (already handled, or on the login
 * route). Never throws — a failing handler is reported, not propagated
 * into the request path that is already failing with a 401.
 */
export async function handleSessionExpired(path?: string): Promise<boolean> {
  const currentPath = path ?? getCurrentPath();
  if (isLoginPath(currentPath)) return false;
  if (handled) return false;
  handled = true;
  const handler = registeredHandler ?? createSessionExpiredHandler();
  try {
    await handler({ path: currentPath });
  } catch (error) {
    reportError(error, { source: 'session-expired-handler', path: currentPath });
  }
  return true;
}
