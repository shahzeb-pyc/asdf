/**
 * PostHog host normalization — shared by the browser SDK init
 * (lib/posthog.ts) and the server SDK (lib/server-analytics.ts).
 *
 * THE BUG THIS FIXES: POSTHOG_HOST was used verbatim. A bare region
 * value such as "US" — which is what the preview deployments carried —
 * became the request host `US`, so the browser fired requests to
 * `/US/array/...` and every analytics call 404'd. Analytics looked
 * configured while silently sending nothing.
 *
 * Rules (pure, no I/O, safe to unit-test):
 * - Empty / missing → the US default host.
 * - A bare region code ("US", "EU", case-insensitive, optional
 *   whitespace) → that region's real ingest host.
 * - A bare hostname ("us.i.posthog.com") → https:// + hostname.
 * - A full http(s) URL → used as-is (trailing slashes stripped).
 * - Anything else (unparseable, wrong scheme, no hostname) → the US
 *   default host AND a loud console warning. Analytics must never
 *   emit requests to a malformed host, and a misconfiguration must
 *   never look healthy — but it must also never break a page, so the
 *   fallback is the default host, not a throw.
 */

export const POSTHOG_DEFAULT_HOST = 'https://us.i.posthog.com';

const REGION_HOSTS: Record<string, string> = {
  US: 'https://us.i.posthog.com',
  EU: 'https://eu.i.posthog.com',
};

export function normalizePostHogHost(input: string | undefined | null): string {
  const raw = (input ?? '').trim();
  if (!raw) return POSTHOG_DEFAULT_HOST;

  const region = REGION_HOSTS[raw.toUpperCase()];
  if (region) return region;

  // A scheme other than http(s) ("ftp://…", "ws://…") is malformed
  // input, not a hostname to prefix — prefixing it would produce a
  // nonsense host like https://ftp://… that fails requests opaquely.
  if (raw.includes('://') && !/^https?:\/\//i.test(raw)) {
    console.warn(
      `[posthog] Ignoring malformed POSTHOG_HOST value ${JSON.stringify(raw)}; ` +
        `using ${POSTHOG_DEFAULT_HOST}. Set POSTHOG_HOST to "US", "EU", or a full ingest URL.`
    );
    return POSTHOG_DEFAULT_HOST;
  }

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.hostname.length > 0
    ) {
      return url.toString().replace(/\/+$/, '');
    }
  } catch {
    // Fall through to the warned default below.
  }

  console.warn(
    `[posthog] Ignoring malformed POSTHOG_HOST value ${JSON.stringify(raw)}; ` +
      `using ${POSTHOG_DEFAULT_HOST}. Set POSTHOG_HOST to "US", "EU", or a full ingest URL.`
  );
  return POSTHOG_DEFAULT_HOST;
}
