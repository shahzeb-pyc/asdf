'use client';

/**
 * Shared account + sign-out footer for the seller and admin shells
 * (carried over verbatim from SellerSidebar). The user footer stays
 * the workspace switcher — this footer is only for the global
 * sections, which have no workspace to switch between.
 *
 * Sign-out must not trap the user: even if the API call fails, the
 * browser still leaves for the logged-out login page, but the
 * failure is reported loudly rather than swallowed — a logout that
 * silently fails leaves a live session behind.
 *
 * Sign-out must also clear properly and fully (session-global-check
 * spec §7): this footer runs the same full sequence as the user
 * shell's switcher and the command palette — clear client cookies,
 * broadcast logout to other tabs, POST the server clear, clear the
 * query cache — and falls back to the same-host GET clear endpoint
 * (not straight to `/login`) when the POST fails, so a degraded
 * sign-out still ends logged out. A `storage` listener for the
 * logout signal redirects other tabs here; a storage listener is
 * used deliberately because storage events do NOT fire in the tab
 * that wrote the key, so this tab can never redirect itself
 * before its own POST completes (a BroadcastChannel subscription
 * would fire here too and could abort the POST).
 */

import React, { useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Button } from '@/components/shared/ui/button';
import { api } from '@/lib/api';
import { reportError } from '@/lib/report-error';
import {
  broadcastLogout,
  clearClientSessionCookies,
  redirectToLogout,
} from '@/components/workspace/workspace-switcher-utils';

const LogoutResponseSchema = z.object({
  redirectUrl: z.string().optional(),
});

export interface AccountFooterProps {
  user: { name: string; email: string };
  /** Error-report source tag (seller-sign-out / admin-sign-out). */
  signOutErrorSource: string;
}

export function AccountFooter({ user, signOutErrorSource }: Readonly<AccountFooterProps>) {
  const queryClient = useQueryClient();

  // Other tabs' logout broadcasts land here via the storage signal
  // (the lifecycle guard covers user-shell tabs; seller/admin tabs
  // have no guard, so this footer is their listener).
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleStorage = (event: StorageEvent): void => {
      if (event.key === 'fbup_logout_event') {
        window.location.href = '/login?logout=success';
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const handleSignOut = useCallback(async () => {
    clearClientSessionCookies();
    broadcastLogout();
    let target: string | null = null;
    try {
      const data = await api.post('/api/auth/logout', undefined, {
        schema: LogoutResponseSchema,
        // Logout has its own redirect below; a 401 here (session
        // already dead) must not fire the session-expired bounce
        // and race it.
        bounceOnUnauthorized: false,
      });
      if (data.redirectUrl) target = data.redirectUrl;
    } catch (error) {
      reportError(error, { source: signOutErrorSource });
    }
    queryClient.clear();
    if (target) {
      window.location.href = target;
    } else {
      redirectToLogout();
    }
  }, [queryClient, signOutErrorSource]);

  return (
    <div className="flex min-w-0 flex-col gap-1 px-2 py-2">
      <span className="truncate text-body font-medium text-ink">{user.name}</span>
      <span className="truncate text-metadata text-ink-dim">{user.email}</span>
      <Button variant="ghost" size="sm" className="mt-1 justify-start" onClick={handleSignOut}>
        Sign out
      </Button>
    </div>
  );
}
