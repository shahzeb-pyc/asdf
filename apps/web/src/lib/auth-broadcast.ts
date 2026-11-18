/**
 * @file auth-broadcast.ts
 * @description Cross-tab authentication event broadcaster.
 *
 * Synchronizes login, logout, user-switch, and session changes across
 * browser tabs. Transport (spec 137 §3.9 / T17): `BroadcastChannel`
 * ('fbup_auth') is the primary channel. The storage event is the
 * FALLBACK ONLY — when BroadcastChannel is unavailable or fails, the
 * full event payload is written to the `fbup_auth_event` storage key
 * so other tabs still receive it via their `storage` listener.
 *
 * Two legacy keys remain as persisted cross-tab STATE (not the event
 * signal): `fbup_active_user` (the identity other tabs compare against
 * on mount and on identity events) and `fbup_logout_event` (the logout
 * timestamp the workspace lifecycle guard's storage listener watches).
 * Those writes are unchanged from the original mechanism.
 */

import { getBrandTenantRoot, resolveBrandFromHost } from '@fbuploadpro/contracts';
import { sanitizeAuthRedirectUrl } from './auth-redirect';

export const AUTH_BROADCAST_CHANNEL = 'fbup_auth';
export const AUTH_EVENT_STORAGE_KEY = 'fbup_auth_event';
export const AUTH_LOGOUT_STORAGE_KEY = 'fbup_logout_event';
export const ACTIVE_USER_STORAGE_KEY = 'fbup_active_user';

export type AuthBroadcastType = 'LOGIN' | 'LOGOUT' | 'USER_SWITCH' | 'SESSION_CHANGE';

export interface AuthBroadcastPayload {
  type: AuthBroadcastType;
  userId?: string | undefined;
  email?: string | undefined;
  timestamp: number;
}

export type AuthBroadcastEvent =
  | { type: 'LOGOUT' }
  | { type: 'LOGIN'; userId?: string | undefined; email?: string | undefined }
  | { type: 'USER_SWITCH'; userId?: string | undefined; email?: string | undefined }
  | { type: 'SESSION_CHANGE'; userId?: string | undefined; email?: string | undefined };

function buildPayload(event: AuthBroadcastEvent): AuthBroadcastPayload {
  return {
    type: event.type,
    timestamp: Date.now(),
    ...(('userId' in event && event.userId) ? { userId: event.userId } : {}),
    ...(('email' in event && event.email) ? { email: event.email } : {}),
  };
}

/** Primary transport. Returns true when the payload was posted. */
function postViaBroadcastChannel(payload: AuthBroadcastPayload): boolean {
  try {
    if (typeof BroadcastChannel === 'undefined') return false;
    const channel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
    channel.postMessage(payload);
    channel.close();
    return true;
  } catch {
    return false;
  }
}

/** Persist the cross-tab identity state keys (see the header note). */
function persistAuthState(event: AuthBroadcastEvent, payload: AuthBroadcastPayload): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (event.type === 'LOGOUT') {
      localStorage.setItem(AUTH_LOGOUT_STORAGE_KEY, String(payload.timestamp));
      localStorage.removeItem(ACTIVE_USER_STORAGE_KEY);
    } else if ('userId' in event && event.userId) {
      localStorage.setItem(ACTIVE_USER_STORAGE_KEY, event.userId);
    }
  } catch (error) {
    console.warn('[auth-broadcast] could not persist cross-tab auth state', error);
  }
}

/** Fallback transport: signal other tabs through the storage event. */
function signalViaStorageEvent(payload: AuthBroadcastPayload): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(AUTH_EVENT_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('[auth-broadcast] storage-event fallback failed', error);
  }
}

export function broadcastAuthEvent(event: AuthBroadcastEvent): void {
  if (typeof window === 'undefined' && typeof BroadcastChannel === 'undefined' && typeof localStorage === 'undefined') {
    return;
  }

  const payload = buildPayload(event);
  const delivered = postViaBroadcastChannel(payload);
  persistAuthState(event, payload);
  if (!delivered) {
    signalViaStorageEvent(payload);
  }
}

function parseStoredAuthEvent(raw: string | null): AuthBroadcastPayload | null {
  if (!raw) return null;
  let parsed: Partial<AuthBroadcastPayload> | null = null;
  let parseOk = false;
  try {
    parsed = JSON.parse(raw) as Partial<AuthBroadcastPayload>;
    parseOk = true;
  } catch {
    parseOk = false;
  }
  if (
    parseOk &&
    parsed &&
    typeof parsed === 'object' &&
    typeof parsed.type === 'string' &&
    typeof parsed.timestamp === 'number'
  ) {
    return parsed as AuthBroadcastPayload;
  }
  return null;
}

export type AuthEventListener = (payload: AuthBroadcastPayload) => void;

/**
 * Subscribe to cross-tab auth events. BroadcastChannel is the primary
 * subscription; the storage-event listener is registered ONLY when
 * BroadcastChannel is unavailable (the fallback transport). Returns
 * an unsubscribe function.
 */
export function subscribeAuthEvents(listener: AuthEventListener): () => void {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const data = event.data as AuthBroadcastPayload;
        if (data && typeof data === 'object' && typeof data.type === 'string') {
          listener(data);
        }
      };
      return () => {
        try {
          channel.close();
        } catch (error) {
          console.warn('[auth-broadcast] channel close failed', error);
        }
      };
    }
  } catch (error) {
    // BroadcastChannel construction failed — fall through to the
    // storage-event fallback below.
    console.warn('[auth-broadcast] BroadcastChannel unavailable, using storage fallback', error);
  }

  if (typeof window === 'undefined') {
    return () => undefined;
  }

  const handleStorage = (event: StorageEvent) => {
    if (event.key === AUTH_EVENT_STORAGE_KEY) {
      const payload = parseStoredAuthEvent(event.newValue);
      if (payload) listener(payload);
      return;
    }
    if (event.key === AUTH_LOGOUT_STORAGE_KEY && event.newValue) {
      listener({ type: 'LOGOUT', timestamp: Number(event.newValue) || Date.now() });
    }
  };
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener('storage', handleStorage);
  };
}

/**
 * Dispatches a cross-tab LOGIN broadcast and navigates the window to the sanitized post-auth destination.
 */
export function completeAuthRedirect(
  redirectUrl: string,
  user?: { id?: string | undefined; email?: string | undefined; subdomain?: string | undefined } | undefined
): void {
  broadcastAuthEvent({
    type: 'LOGIN',
    ...(user?.id ? { userId: user.id } : {}),
    ...(user?.email ? { email: user.email } : {}),
  });

  if (typeof window !== 'undefined') {
    // Spec 204: sanitize against the REQUEST's brand root, as the
    // server already does (loginTenantUser passes the brand tenant
    // root into sanitizeAuthRedirectUrl). The old call let the helper
    // default to NEXT_PUBLIC_ROOT_DOMAIN (fbuploadpro.com), so a
    // white-label tenant URL failed the check and fell back to the
    // fbuploadpro tenant host — a NextRise login landed on
    // fbuploadpro. The brand is resolved from the host the user is
    // actually on, generically; no brand is hardcoded here.
    const requestHost = window.location.host;
    const brandRoot = getBrandTenantRoot(
      resolveBrandFromHost(requestHost),
      process.env.NEXT_PUBLIC_ROOT_DOMAIN || 'localhost:3000'
    );
    window.location.href = sanitizeAuthRedirectUrl(
      redirectUrl,
      user?.subdomain,
      brandRoot,
      requestHost
    );
  }
}
