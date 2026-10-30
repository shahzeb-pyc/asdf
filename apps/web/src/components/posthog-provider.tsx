'use client';

import React, { Suspense, useEffect, type ReactNode } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { capturePageview, initPostHog } from '@/lib/posthog';

interface PostHogProviderProps {
  /** Server-provided PostHog project API key (from POSTHOG_KEY env). */
  apiKey: string | undefined;
  /** Server-provided PostHog host (from POSTHOG_HOST env). */
  host: string | undefined;
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
 * env via props — never from NEXT_PUBLIC_ vars) and tracks pageviews.
 * Identify lives separately in PostHogIdentify, mounted by the tenant
 * shell (which already holds the session) — keeping this root layout
 * synchronous, which the legacy static-markup layout suite requires.
 * Analytics failure never breaks the page: every helper here is a
 * no-op until init succeeds, and logs instead of throwing.
 */
export function PostHogProvider({
  apiKey,
  host,
  children,
}: Readonly<PostHogProviderProps>) {
  useEffect(() => {
    initPostHog(apiKey, host);
  }, [apiKey, host]);

  return (
    <>
      <Suspense fallback={null}>
        <PageviewTracker />
      </Suspense>
      {children}
    </>
  );
}
