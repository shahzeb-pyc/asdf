'use client';

import React, { Suspense, useEffect, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { capturePageview, identifyUser, initPostHog } from '@/lib/posthog';

interface PostHogProviderProps {
  /** Server-provided PostHog project API key (from POSTHOG_KEY env). */
  apiKey: string | undefined;
  /** Server-provided PostHog host (from POSTHOG_HOST env). */
  host: string | undefined;
  /**
   * Signed-in user id, from the server session — the stable identify
   * key. Undefined when logged out. Never an email or name.
   */
  userId: string | undefined;
  /**
   * Tenant subdomain, from the server session — the stable workspace
   * identifier attached to identify. Undefined when logged out.
   */
  tenantId: string | undefined;
  children: ReactNode;
}

/**
 * Captures a $pageview on every App Router navigation, including SPA
 * transitions (pathname or query change). The initial load is covered
 * too: this effect runs on mount. posthog-js's own capture_pageview
 * stays off, so the initial load is never double-counted. Rendered
 * inside Suspense because useSearchParams requires a suspense
 * boundary in App Router.
 */
function PageviewTracker(): null {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const query = searchParams.toString();
    capturePageview(query ? `${pathname}?${query}` : pathname);
  }, [pathname, searchParams]);

  return null;
}

/**
 * Initializes client-side PostHog once on mount (key/host from server
 * env via props — never from NEXT_PUBLIC_ vars), identifies the
 * signed-in user when a session exists, and tracks pageviews.
 * Analytics failure never breaks the page: every helper here is a
 * no-op until init succeeds, and logs instead of throwing.
 */
export function PostHogProvider({
  apiKey,
  host,
  userId,
  tenantId,
  children,
}: Readonly<PostHogProviderProps>) {
  useEffect(() => {
    initPostHog(apiKey, host);
  }, [apiKey, host]);

  useEffect(() => {
    if (userId) identifyUser(userId, tenantId);
  }, [userId, tenantId]);

  return (
    <>
      <Suspense fallback={null}>
        <PageviewTracker />
      </Suspense>
      {children}
    </>
  );
}
