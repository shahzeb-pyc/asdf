/**
 * Product analytics event taxonomy — the ONE place event names and
 * their properties are defined. Both the browser SDK (lib/posthog.ts)
 * and the server SDK (lib/server-analytics.ts) send only events from
 * this map, so a typo'd event name or a stray property cannot ship.
 *
 * PRIVACY RULE (binding): properties carry ids, platforms, counts,
 * and types only — never emails, names, captions, titles, file
 * names, page names, or any other user content. The user is
 * identified by their stable user id (identify), and the workspace
 * by its tenant subdomain (tenant_id property on identify) — nothing
 * else personal ever leaves the app for analytics.
 *
 * DELIBERATE OMISSIONS:
 * - No autocapture, no session recording, no pageleave: explicit
 *   events only, so the product's analytics stay explainable and
 *   the payload stays small. Revisit only with a concrete reason.
 * - No per-item publish-now/retry endpoints: `post_published_now`
 *   fires from the Publish Now section route only. The per-item
 *   Queue publish-now/retry endpoints are deliberately excluded
 *   (they would double-count the same publish); add them only if
 *   per-item attribution is ever asked for.
 * - No idempotency replays: `post_queued` fires only on a fresh
 *   queue insert. A replayed request returns the stored result
 *   without re-emitting, so retries never inflate the count.
 * - No ingestion proxy: events go straight to the configured
 *   PostHog host. A first-party rewrite proxy (ad-blocker
 *   resilience) is a noted follow-up, not half-built here.
 */

export interface AnalyticsEventProperties {
  /** A social account finished connecting. `reconnected` = the account row already existed. */
  account_connected: {
    platform: 'facebook' | 'instagram';
    reconnected: boolean;
  };
  /** Pages finished importing via Add Page. `count` = pages actually added. */
  page_added: {
    platform: 'facebook';
    count: number;
  };
  /** One post was queued from the composer. `post_type` = the derived queue kind. */
  post_queued: {
    platform: string;
    post_type: string;
  };
  /** Publish Now finished. Only fires when at least one page published. */
  post_published_now: {
    platform: 'facebook';
    page_count: number;
    published_count: number;
  };
  /** One media item finished uploading (confirm step). */
  media_uploaded: {
    media_type: string;
  };
  /** An Auto Repost mirror was created. */
  mirror_created: {
    source_platform: 'tiktok';
    target_platform: 'facebook';
  };
}

export type AnalyticsEventName = keyof AnalyticsEventProperties;

export type AnalyticsEventProps<Name extends AnalyticsEventName> =
  AnalyticsEventProperties[Name];
