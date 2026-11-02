/**
 * Session validity + session-cookie helpers (spec 137 §3.2.5 split).
 *
 * Split from the former 1,314-line auth monolith
 * by spec 137 PR-A1b (audit #6 / spec §3.2.5). Function bodies are
 * verbatim; only imports/exports were re-wired to the new modules.
 */

import type { NextResponse } from 'next/server';
import type { SessionPayload } from '@fbuploadpro/contracts';
import { getCookieDomain } from './clients';
import { findUserByEmailDetailed } from './users';
import { logServerError } from '@/lib/server-analytics';

/**
 * Claim-only session validity (session-global-check spec §2.1).
 *
 * This deliberately performs NO database lookup: API routes verify
 * the JWT only (signature + expiry + status claim), and database
 * backed session state — suspension after login, user deletion,
 * password change — is enforced by the single global session check
 * (`validateSessionDetailed`, via `GET /api/auth/session`), not on
 * every API call. A token whose status claim is not `'active'`
 * (today the only other value is `'suspended'`) is dead.
 *
 * Callers that previously relied on this function for the database
 * check must use `validateSessionDetailed` instead; keeping the old
 * DB-backed meaning here would preserve the exact per-call failure
 * mode being removed (a transient lookup error surfacing as 401).
 */
export async function validateSessionActive(session: SessionPayload): Promise<boolean> {
  return session.status === 'active';
}

/**
 * Database-backed session verdict, used ONLY by the global session
 * check. Unlike the old `validateSessionActive`, a lookup failure
 * is distinguishable from a dead session: `'error'` must surface
 * as a server error (503), never as a 401.
 */
export type SessionVerdict = 'active' | 'dead' | 'error';

export async function validateSessionDetailed(session: SessionPayload): Promise<SessionVerdict> {
  if (session.status !== 'active') return 'dead';
  const result = await findUserByEmailDetailed(session.email);
  if (result.kind === 'error') return 'error';
  if (result.kind === 'absent') return 'dead';
  const user = result.user;
  if (user.status !== 'active') return 'dead';
  if (user.passwordUpdatedAt && session.iat <= user.passwordUpdatedAt) return 'dead';
  return 'active';
}

/**
 * Best-effort session-cookie clearing (sign-out, spec §7.1).
 *
 * Emits one `Set-Cookie` clear per cookie variant the login could
 * have set, because a clear only deletes a cookie whose Domain and
 * Path match: host-only (no Domain), shared-domain
 * (`Domain=.` + root), and exact-host (`Domain=<request host>`).
 * All variants are `Path=/`, `Max-Age=0`, past `Expires`,
 * `HttpOnly`, `SameSite=Lax`, `Secure` in production.
 *
 * This NEVER throws: it does not call the throwing domain
 * resolver, and every computation is guarded. A logout that throws
 * on domain resolution would answer 500 with nothing cleared —
 * the exact hole this replaces. The shared-domain variant is
 * skipped for localhost / 127.0.0.1 / `*.vercel.app` roots, where
 * cookies are host-only by construction (and a shared-domain clear
 * would be rejected by the browser anyway).
 *
 * Same-name clears use raw `Set-Cookie` appends: the response
 * cookie map would overwrite same-name sets.
 */
export function clearSessionCookiesBestEffort(
  response: NextResponse,
  requestHost?: string | null
): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const baseAttributes = `Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${isProduction ? '; Secure' : ''}`;
  const appendClear = (domainAttribute: string): void => {
    try {
      response.headers.append(
        'Set-Cookie',
        `fbup_session=; ${baseAttributes}${domainAttribute}`
      );
    } catch (error: unknown) {
      // Clearing is best-effort — a header failure on one variant
      // must not stop the remaining variants — but it is surfaced
      // in server logs, never swallowed (silent-failure ban).
      logServerError('[auth/session] Session cookie clear failed', error, {
        source: 'auth-session-clear',
      });
    }
  };

  // Host-only variant (no Domain): always emitted.
  appendClear('');

  let cleanHost = '';
  try {
    cleanHost = (requestHost ?? '').trim().toLowerCase().split(':')[0] || '';
  } catch {
    cleanHost = '';
  }
  const isLocalOrPreviewHost =
    cleanHost === '' ||
    cleanHost.includes('localhost') ||
    cleanHost.includes('127.0.0.1') ||
    cleanHost.endsWith('.vercel.app');

  // Shared-domain variant: only when the request host is actually
  // under the shared domain (tenant subdomain or apex host). A
  // localhost/preview request cannot hold a shared-domain cookie
  // for the production root, and the browser would reject such a
  // clear anyway — emitting it would be noise, not coverage. With
  // no host information at all, emit best-effort.
  try {
    const cookieDomain = process.env.COOKIE_DOMAIN?.trim();
    const rawRoot = process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'localhost:3000';
    const cleanRoot = rawRoot
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0]
      ?.split(':')[0] || 'localhost';
    const rootIsUsable =
      !cleanRoot.includes('localhost') &&
      !cleanRoot.includes('127.0.0.1') &&
      !cleanRoot.endsWith('.vercel.app');
    if (rootIsUsable) {
      const shared = cookieDomain
        ? cookieDomain.startsWith('.')
          ? cookieDomain
          : `.${cookieDomain.replace(/^\./, '')}`
        : `.${cleanRoot}`;
      const sharedBare = shared.replace(/^\./, '');
      const hostUnderShared =
        cleanHost === '' || cleanHost === sharedBare || cleanHost.endsWith(`.${sharedBare}`);
      if (hostUnderShared) {
        appendClear(`; Domain=${shared}`);
      }
    }
  } catch (error: unknown) {
    // Shared variant skipped; host-only + exact-host still apply.
    // Surfaced, not swallowed (silent-failure ban).
    logServerError('[auth/session] Shared-domain cookie clear skipped', error, {
      source: 'auth-session-clear',
    });
  }

  // Exact-host variant (covers a cookie set with Domain=<host>).
  if (!isLocalOrPreviewHost && cleanHost !== '') {
    appendClear(`; Domain=${cleanHost}`);
  }
}

export function purgeHostOnlySessionCookie(response: NextResponse): void {
  const isProduction = process.env.NODE_ENV === 'production';
  response.headers.append(
    'Set-Cookie',
    `fbup_session=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${isProduction ? '; Secure' : ''}`
  );
}

export function setSessionCookie(
  response: NextResponse,
  token: string,
  requestHost?: string | null
): void {
  const isProduction = process.env.NODE_ENV === 'production';
  const domain = getCookieDomain(requestHost);

  response.cookies.set('fbup_session', token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    domain,
    maxAge: 86400 * 30, // 30 days
  });

  if (domain) {
    purgeHostOnlySessionCookie(response);
  }
}
