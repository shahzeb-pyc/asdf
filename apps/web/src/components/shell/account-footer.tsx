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
 */

import React, { useCallback } from 'react';
import { z } from 'zod';
import { Button } from '@/components/shared/ui/button';
import { api } from '@/lib/api';
import { reportError } from '@/lib/report-error';

const LogoutResponseSchema = z.object({
  redirectUrl: z.string().optional(),
});

export interface AccountFooterProps {
  user: { name: string; email: string };
  /** Error-report source tag (seller-sign-out / admin-sign-out). */
  signOutErrorSource: string;
}

export function AccountFooter({ user, signOutErrorSource }: Readonly<AccountFooterProps>) {
  const handleSignOut = useCallback(async () => {
    let target = '/login?logout=success';
    try {
      const data = await api.post('/api/auth/logout', undefined, {
        schema: LogoutResponseSchema,
      });
      if (data.redirectUrl) target = data.redirectUrl;
    } catch (error) {
      reportError(error, { source: signOutErrorSource });
    }
    window.location.href = target;
  }, [signOutErrorSource]);

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
