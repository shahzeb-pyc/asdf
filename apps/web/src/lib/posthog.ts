/**
 * Client-side PostHog singleton: error tracking (existing) + product
 * analytics (pageviews, identify, explicit events).
 *
 * The API key is passed in from the server layout as a prop — never read
 * from process.env here, since only NEXT_PUBLIC_ vars are exposed to the
 * browser and we intentionally use plain POSTHOG_KEY/POSTHOG_HOST.
 *
 * Loading (spec 137 §3.6.1 / PR-A4): `posthog-js` is loaded with a
 * dynamic import inside initPostHog, so it is NOT in the root critical
 * path — the chunk loads after first paint, when the provider's effect
 * runs. Loading mechanics only: the key/host wiring is spec 118's, and
 * the `reportError` seam (lib/report-error.ts) is untouched — this
 * module never was its transport (the seam's transport is installed
 * via setReportErrorTransport, independently of this loader).
 *
 * ANALYTICS SEMANTICS:
 * - Pageviews are captured EXPLICITLY by the provider's tracker on
 *   every App Router navigation (capture_pageview stays false, so
 *   posthog-js never double-counts the initial load).
 * - identify() carries the stable user id + tenant subdomain only —
 *   never an email, name, or other PII (see lib/analytics-events.ts).
 * - Events come only from the taxonomy in lib/analytics-events.ts.
 * - Autocapture and session recording stay OFF: explicit events only.
 *
 * FAILURE SEMANTICS (fail loud, never break a page): a failed chunk
 * load logs an error and leaves analytics off for the session. Every
 * capture helper is a no-op until init succeeds, and never throws —
 * analytics failure must never break app pages. A malformed host is
 * normalized (lib/posthog-host.ts) with a loud warning, never sent
 * verbatim — the old "US" host bug (requests to /US/… 404ing) cannot
 * recur through this module.
 */

import type {
  AnalyticsEventName,
  AnalyticsEventProps,
} from './analytics-events';
import { normalizePostHogHost } from './posthog-host';

export { POSTHOG_DEFAULT_HOST } from './posthog-host';

type PostHogInstance = {
  init: (apiKey: string, options: Record<string, unknown>) => void;
  identify: (distinctId: string, properties?: Record<string, unknown>) => void;
  capture: (event: string, properties?: Record<string, unknown>) => void;
};

let loadPromise: Promise<PostHogInstance | null> | null = null;
let loadStarted = false;

function whenReady(run: (posthog: PostHogInstance) => void): void {
  if (!loadPromise) return;
  void loadPromise
    .then((posthog) => {
      if (!posthog) return;
      try {
        run(posthog);
      } catch (error: unknown) {
        console.error('[posthog] analytics call failed', error);
      }
    })
    .catch((error: unknown) => {
      console.error('[posthog] analytics call failed', error);
    });
}

/**
 * Initialize PostHog in the browser. Safe to call multiple times;
 * subsequent calls are no-ops. No-op entirely when no API key is provided.
 * The dynamic import is fire-and-forget: a failed chunk load leaves
 * analytics off for the session rather than breaking the page —
 * the failure is logged, never silently swallowed.
 */
export function initPostHog(
  apiKey: string | undefined | null,
  host?: string | undefined | null
): void {
  if (loadStarted) return;
  if (!apiKey) return;
  if (typeof window === 'undefined') return;
  loadStarted = true;

  loadPromise = import('posthog-js')
    .then(({ default: posthog }) => {
      const instance = posthog as unknown as PostHogInstance;
      instance.init(apiKey, {
        api_host: normalizePostHogHost(host),
        // Explicit analytics only — no autocapture, no session recording.
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
      });
      return instance;
    })
    .catch((error: unknown) => {
      loadStarted = false;
      console.error('[posthog] failed to load posthog-js', error);
      return null;
    });
}

/**
 * Identify the signed-in user. `tenantId` is the tenant subdomain —
 * the stable workspace identifier, not a name. No-ops when no user id
 * is given or PostHog never initialized. Safe to call before init
 * resolves: the identify waits for the load promise.
 */
export function identifyUser(
  userId: string | undefined | null,
  tenantId?: string | undefined | null
): void {
  if (!userId) return;
  whenReady((posthog) => {
    posthog.identify(
      userId,
      tenantId ? { tenant_id: tenantId } : undefined
    );
  });
}

/**
 * Capture a $pageview for a navigation. `path` is a pathname with an
 * optional query string; it is expanded to a full URL against the
 * current origin so PostHog records $current_url correctly.
 */
export function capturePageview(path: string): void {
  whenReady((posthog) => {
    const url =
      typeof window !== 'undefined' && path.startsWith('/')
        ? `${window.location.origin}${path}`
        : path;
    posthog.capture('$pageview', { $current_url: url });
  });
}

/**
 * Capture one taxonomy event. Only events from lib/analytics-events.ts
 * type-check here, so a typo'd name or an off-taxonomy property is a
 * compile error, not a silent new event in PostHog.
 */
export function trackEvent<Name extends AnalyticsEventName>(
  event: Name,
  properties: AnalyticsEventProps<Name>
): void {
  whenReady((posthog) => {
    posthog.capture(event, properties as Record<string, unknown>);
  });
}
