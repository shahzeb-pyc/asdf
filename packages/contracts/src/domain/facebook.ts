import { z } from 'zod';

import { ValidatedTimezoneSchema } from './queue.js';

export const FacebookAccountStatusSchema = z.enum([
  'active',
  'disconnected',
  'expired',
]);
export const FacebookAccountStatusEnum = FacebookAccountStatusSchema.enum;
export type FacebookAccountStatus = z.infer<typeof FacebookAccountStatusSchema>;

export const FacebookAccountSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  fbAccountId: z.string().min(1).max(100),
  displayName: z.string().min(1).max(255),
  profilePictureUrl: z.string().url().nullable().optional().default(null),
  gender: z.string().max(50).nullable().optional().default(null),
  accountLink: z.string().url().nullable().optional().default(null),
  encryptedAccessToken: z.string().default(''),
  tokenExpiresAt: z.coerce.date().nullable().optional(),
  status: FacebookAccountStatusSchema.default('active'),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type FacebookAccount = z.infer<typeof FacebookAccountSchema>;

export const FacebookAccountLinkedPageSchema = z.object({
  id: z.string().uuid(),
  pageName: z.string().min(1),
  profilePictureUrl: z.string().nullable().optional(),
});

export type FacebookAccountLinkedPage = z.infer<
  typeof FacebookAccountLinkedPageSchema
>;

// Sanitized view model for UI presentation (zero token exposure)
export const FacebookAccountViewSchema = z.object({
  id: z.string().uuid(),
  fbAccountId: z.string().min(1).max(100),
  displayName: z.string().min(1).max(255),
  profilePictureUrl: z.string().url().nullable().optional().default(null),
  gender: z.string().max(50).nullable().optional().default(null),
  accountLink: z.string().url().nullable().optional().default(null),
  status: FacebookAccountStatusSchema,
  tokenExpiresAt: z.coerce.date().nullable().optional(),
  connectedPagesCount: z.number().int().nonnegative().default(0),
  connectedPages: z.array(FacebookAccountLinkedPageSchema).optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type FacebookAccountView = z.infer<typeof FacebookAccountViewSchema>;
export const FacebookAccountSummarySchema = FacebookAccountViewSchema;

export const ListFacebookAccountsResponseSchema = z.object({
  accounts: z.array(FacebookAccountViewSchema),
  total: z.number().int().nonnegative(),
  /** Paginated response meta; optional so pre-pagination payloads still parse. */
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  totalPages: z.number().int().nonnegative().optional(),
  /**
   * Health counts over the FULL filtered set (not the page slice), so
   * the subtitle can report workspace totals while paginated.
   * Optional so pre-pagination payloads still parse.
   */
  healthCounts: z
    .object({
      connected: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative(),
      error: z.number().int().nonnegative(),
    })
    .optional(),
});

export type ListFacebookAccountsResponse = z.infer<
  typeof ListFacebookAccountsResponseSchema
>;


export const FacebookPageStatusSchema = z.enum([
  'active',
  'paused',
  'fb_rate_limited',
  'page_checkpoint',
  'invalid_token',
  'disconnected',
]);
export const FacebookPageStatusEnum = FacebookPageStatusSchema.enum;
export type FacebookPageStatus = z.infer<typeof FacebookPageStatusSchema>;

export const FacebookPageSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  facebookAccountId: z.string().uuid(),
  fbPageId: z.string().min(1).max(100),
  pageName: z.string().min(1).max(255),
  profilePictureUrl: z.string().url().nullable().optional().default(null),
  category: z.string().max(100).nullable().optional(),
  timezone: z.string().default('UTC'),
  tasks: z.array(z.string()).default([]),
  startingFollowers: z.number().int().nonnegative().default(0),
  currentFollowers: z.number().int().nonnegative().default(0),
  followersCount: z.number().int().nonnegative().default(0),
  encryptedAccessToken: z.string().default(''),
  status: FacebookPageStatusSchema.default('active'),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type FacebookPage = z.infer<typeof FacebookPageSchema>;

/**
 * Queue counts shown on a Pages list card. `posted` is the all-time
 * `published` total, renamed at the list boundary so the UI vocabulary
 * matches the card labels (Queued / Posted / Failed). `publishing`,
 * `skipped` and `cancelled` are deliberately absent — they are
 * ignored for the card, never folded into these three.
 */
export const PageCardQueueCountsSchema = z.object({
  queued: z.number().int().nonnegative(),
  posted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export type PageCardQueueCounts = z.infer<typeof PageCardQueueCountsSchema>;

// Sanitized view model for Facebook Page (zero token exposure)
export const FacebookPageViewSchema = z.object({
  id: z.string().uuid(),
  facebookAccountId: z.string().uuid(),
  // K11: nullable, not merely optional — the detail path's LEFT JOIN
  // passes `?? null` for a missing account row (and the list mapper
  // coerces the same case), so an optional-only field threw in
  // .parse() and turned a page with no account row into a 500.
  accountDisplayName: z.string().nullable().optional(),
  accountPictureUrl: z.string().nullable().optional().default(null),
  fbPageId: z.string().min(1).max(100),
  pageName: z.string().min(1).max(255),
  // K11: a stored non-URL avatar must fall back to null, not throw
  // the whole detail/list parse (and with it the page) — .catch
  // converts any invalid value to the no-picture fallback.
  profilePictureUrl: z.string().url().nullable().optional().default(null).catch(null),
  category: z.string().nullable().optional(),
  timezone: z.string().default('UTC'),
  startingFollowers: z.number().int().nonnegative().default(0),
  currentFollowers: z.number().int().nonnegative().default(0),
  followersGained: z.number().int().default(0),
  followersCount: z.number().int().nonnegative().default(0),
  status: FacebookPageStatusSchema,
  tasks: z.array(z.string()).default([]),
  /**
   * Queued post formats no active posting time allows (from
   * destinations.metadata.unmatched_post_types). The page status
   * itself stays 'active'; the UI shows a needs-attention mark from
   * this flag only while status is active. Empty when everything
   * queued is covered, or when nothing is queued.
   */
  unmatchedPostTypes: z.array(z.string()).default([]),
  /**
   * Pages list card counts (optional so detail / discover payloads
   * that predate the list counts still parse). The list route always
   * populates it; a missing value means "no counts fetched", and the
   * card renders zeros rather than hiding the row.
   */
  queueCounts: PageCardQueueCountsSchema.optional(),
  /**
   * True when the Pages list counts query failed for this page's
   * slice (R6). The counts failure is slice-wide, not per-page, so
   * every page in the slice carries it; the card then omits the
   * numbers (dashes + an "unavailable" note) instead of rendering
   * fake zeros. Absent/false means the counts are real — including
   * genuine zeros for a page with no queue rows.
   */
  queueCountsError: z.boolean().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  rateLimitedAt: z.coerce.date().nullable().optional(),
});

export type FacebookPageView = z.infer<typeof FacebookPageViewSchema>;

export const ListFacebookPagesResponseSchema = z.object({
  pages: z.array(FacebookPageViewSchema),
  total: z.number().int().nonnegative(),
  /** Paginated response meta; optional so pre-pagination payloads still parse. */
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  totalPages: z.number().int().nonnegative().optional(),
  /**
   * Needs-attention count over the FULL filtered set (not the page
   * slice), so the subtitle's "requires reconnecting" fragment stays
   * truthful while paginated. Optional so pre-pagination payloads
   * still parse.
   */
  attentionTotal: z.number().int().nonnegative().optional(),
});

export type ListFacebookPagesResponse = z.infer<
  typeof ListFacebookPagesResponseSchema
>;

export interface FacebookGraphPageItem {
  id: string;
  name?: string;
  category?: string | null;
  tasks?: string[];
  access_token?: string;
  followers_count?: number;
  picture?: {
    data?: {
      url?: string;
    };
  };
  [key: string]: unknown;
}

// NOTE: this timeout is implemented locally, not via the web app's shared
// `fetchWithTimeout` helper (apps/web/src/lib/http/fetch-with-timeout.ts),
// because @fbuploadpro/contracts is a dependency of the web app — importing
// the web helper here would invert that dependency. The budget is kept in
// step with GRAPH_API_TIMEOUT_MS in the web helper (30s, spec 139 A4).
const FACEBOOK_GRAPH_TIMEOUT_MS = 30_000;

function facebookGraphTimeoutSignal(callerSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(FACEBOOK_GRAPH_TIMEOUT_MS);
  if (!callerSignal) {
    return timeoutSignal;
  }
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;
}

/**
 * Result of fetching all Facebook Pages via /me/accounts with
 * limit=100 and following cursor pagination (paging.next) up to
 * maxPages (default: 5 = 500 pages max). The list is NEVER
 * presented as complete when it is not:
 * - `truncated` — the cap was hit while Facebook still had another
 *   page of results (paging.next present after the last fetch).
 * - `partial` — a mid-list Graph request failed, so the pages after
 *   the failure are missing. A first-page failure still throws, as
 *   before; only later pages degrade to a partial list, and callers
 *   must surface that (R14).
 * Each Graph request is bounded by a 30s timeout, composed with the
 * caller's signal when one is supplied via the optional trailing
 * `options` argument. The trailing options argument is additive —
 * existing callers are unaffected.
 * The default cap is deliberately NOT raised: every extra Graph
 * page adds up to another 30s of user-waiting latency to every
 * caller (discover, import, OAuth callback, publish-now), and the
 * warning above is the fix for accounts past 500 pages.
 */
/**
 * Unified paginated Graph fetch with truncation reporting (BG6 +
 * R14 merged — one implementation, one result type; the previous
 * parallel helpers are gone).
 *
 * The old helper silently returned a partial list in two cases:
 * the maxPages cap (5 × 100 = 500 pages) with more pages behind
 * the cursor, and a failed later page (only the first-page
 * failure threw). Callers then reported the partial list as
 * complete — a selected page could be "missing" with no signal,
 * and a reconnect could refresh only a subset of page tokens.
 * This helper reports exactly that:
 * - `truncated` is true whenever the loop stopped early, cap or
 *   later-page error (the BG6 flag import/callback warnings use);
 * - `truncationReason` says which one ('page_limit' vs
 *   'page_error'), absent when the list is complete;
 * - `partial` is true exactly on a later-page error (the R14
 *   flag discover splits out for its distinct error warning).
 * A capped list is `truncated` with reason 'page_limit' and
 * `partial` false. NOTE: this `truncated` (either cause) is NOT
 * the discover payload's `truncated` (cap only) — the discover
 * route translates reason === 'page_limit' into the payload
 * field, because the modal's capped-list text names the 500
 * cap specifically.
 */
export interface FetchAllFacebookPagesResult {
  pages: FacebookGraphPageItem[];
  truncated: boolean;
  truncationReason?: 'page_limit' | 'page_error';
  partial: boolean;
}

export async function fetchAllFacebookPages(
  accessToken: string,
  fields: string,
  maxPages = 5,
  fetchFn: typeof fetch = globalThis.fetch,
  options?: { signal?: AbortSignal }
): Promise<FetchAllFacebookPagesResult> {
  const allPages: FacebookGraphPageItem[] = [];
  const initialUrl = new URL('https://graph.facebook.com/v26.0/me/accounts');
  initialUrl.searchParams.set('fields', fields);
  initialUrl.searchParams.set('limit', '100');

  let nextUrl: string | null = initialUrl.toString();
  let pagesFetched = 0;
  let truncationReason: FetchAllFacebookPagesResult['truncationReason'];

  while (nextUrl && pagesFetched < maxPages) {
    pagesFetched++;
    const res = await fetchFn(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: facebookGraphTimeoutSignal(options?.signal),
    });

    if (!res.ok) {
      if (pagesFetched === 1) {
        const err = new Error(`Facebook Graph API returned ${res.status}`);
        (err as any).status = res.status;
        throw err;
      }
      // Mid-list failure: keep what was fetched, but say so — a
      // silent partial list would present itself as complete (R14).
      // nextUrl is cleared so the cap check below cannot overwrite
      // this 'page_error' reason with 'page_limit' when the failure
      // lands on the last allowed page.
      truncationReason = 'page_error';
      nextUrl = null;
      break;
    }

    const json = (await res.json()) as {
      data?: FacebookGraphPageItem[];
      paging?: {
        next?: string;
      };
    };

    if (Array.isArray(json?.data)) {
      for (const item of json.data) {
        if (item && item.id) {
          allPages.push(item);
        }
      }
    }

    nextUrl = json?.paging?.next || null;
  }

  // Cap hit with pages still behind the cursor: truncated, not complete.
  // (A list that ended naturally is complete, not truncated.)
  if (nextUrl && pagesFetched >= maxPages) {
    truncationReason = 'page_limit';
  }

  return {
    pages: allPages,
    truncated: truncationReason !== undefined,
    ...(truncationReason ? { truncationReason } : {}),
    partial: truncationReason === 'page_error',
  };
}


// In-memory representation of pages discovered from Graph API /me/accounts
export const DiscoveredPageSchema = z.object({
  fbPageId: z.string().min(1).max(100),
  pageName: z.string().min(1).max(255),
  profilePictureUrl: z.string().url().nullable().optional().default(null),
  category: z.string().nullable().optional(),
  currentFollowers: z.number().int().nonnegative().default(0),
  followersCount: z.number().int().nonnegative().default(0),
  tasks: z.array(z.string()).default([]),
  isImported: z.boolean().default(false),
});

export type DiscoveredPage = z.infer<typeof DiscoveredPageSchema>;

export const DiscoverPagesResponseSchema = z.object({
  accountId: z.string().uuid(),
  accountDisplayName: z.string(),
  pages: z.array(DiscoveredPageSchema),
  total: z.number().int().nonnegative(),
  /**
   * R14/BG6: the discover list is never silently partial.
   * `truncated` here is the PAYLOAD field and means ONLY the
   * 500-page Graph cap was hit with more pages waiting — it is
   * NOT the helper's either-cause `truncated` (see
   * FetchAllFacebookPagesResult); the discover route translates
   * truncationReason === 'page_limit' into this field, because
   * the modal's capped-list text names the 500 cap specifically.
   * `partial` means a mid-list Graph request failed.
   * `droppedCount` counts Graph nodes the id+name+(category|tasks)
   * filter removed (see the discover route: the filter exists to
   * exclude non-page nodes such as groups, but a real page with
   * neither a category nor tasks would be dropped by it too, so
   * the count is surfaced instead of silently dropping).
   * Defaults keep old payloads (and old tests) parsing.
   */
  truncated: z.boolean().default(false),
  partial: z.boolean().default(false),
  droppedCount: z.number().int().nonnegative().default(0),
});

export type DiscoverPagesResponse = z.infer<typeof DiscoverPagesResponseSchema>;

// One posting time applied by the Add Page flow, step 4. The time is
// the narrowed HH:MM shape the native time input produces, and every
// time must cover at least one post type (the same rule the dedicated
// Posting Times form enforces). No new table: these land in the
// existing posting_slots rows for each imported destination.
export const ImportPostingTimeSchema = z.object({
  slotTime: z
    .string()
    .regex(
      /^([01]\d|2[0-3]):[0-5]\d$/,
      'Invalid time format. Expected HH:MM'
    ),
  allowedFormats: z
    .array(z.enum(['text', 'image', 'reel', 'video', 'story']))
    .min(1),
});

export type ImportPostingTime = z.infer<typeof ImportPostingTimeSchema>;

// Request schema for selectively importing chosen pages. The
// timezone + postingTimes pair is optional (the legacy import sends
// neither) but must arrive together: a timezone without times, or
// times without a timezone, is an incomplete schedule and is
// rejected at the boundary instead of half-applied. Duplicate times
// are rejected for the same reason — posting_slots is unique per
// destination + time_of_day, so a duplicate could never apply cleanly.
// The timezone must be a real IANA zone (ValidatedTimezoneSchema,
// shared with the dedicated timezone-change flow), and at most 24
// posting times are accepted — one per hour of the day at most.
export const ImportPagesRequestSchema = z
  .object({
    accountId: z.string().uuid(),
    // Audit N4: bounded — 500 matches the discover cap (BG6:
    // 5 pages × 100), so a full discovered list can always be
    // imported while an unbounded id list cannot be smuggled in.
    selectedPageIds: z
      .array(z.string().min(1).max(100))
      .min(1)
      .max(500, 'At most 500 pages can be imported at once.'),
    timezone: ValidatedTimezoneSchema.optional(),
    postingTimes: z
      .array(ImportPostingTimeSchema)
      .min(1)
      .max(24, 'At most 24 posting times can be added at once.')
      .optional(),
  })
  .superRefine((data, ctx) => {
    const hasTimezone = data.timezone !== undefined;
    const hasPostingTimes = data.postingTimes !== undefined;
    if (hasTimezone !== hasPostingTimes) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Timezone and posting times must be provided together.',
        path: hasTimezone ? ['postingTimes'] : ['timezone'],
      });
    }
    if (data.postingTimes) {
      const seen = new Set<string>();
      for (const postingTime of data.postingTimes) {
        if (seen.has(postingTime.slotTime)) {
          ctx.addIssue({
            code: 'custom',
            message: 'Each posting time must be different.',
            path: ['postingTimes'],
          });
          break;
        }
        seen.add(postingTime.slotTime);
      }
    }
  });

export type ImportPagesRequest = z.infer<typeof ImportPagesRequestSchema>;

export const ImportPagesResponseSchema = z.object({
  success: z.boolean(),
  importedCount: z.number().int().nonnegative(),
  pages: z.array(
    z.object({
      id: z.string().uuid(),
      fbPageId: z.string(),
      pageName: z.string(),
    })
  ),
});

export type ImportPagesResponse = z.infer<typeof ImportPagesResponseSchema>;

export const DisconnectAccountResponseSchema = z.object({
  success: z.boolean(),
  accountId: z.string().uuid(),
  // Pages removed with the account (deleted via cascade with the
  // account row — see the disconnect route).
  disconnectedPagesCount: z.number().int().nonnegative(),
  // Whether the Facebook-side authorization was actually revoked
  // (DELETE /me/permissions). Informational only: local removal is
  // complete regardless — false (dead token, already revoked, or a
  // failed attempt) never requires any action in Facebook Settings.
  facebookRevoked: z.boolean(),
});

export type DisconnectAccountResponse = z.infer<
  typeof DisconnectAccountResponseSchema
>;

export const DisconnectPageResponseSchema = z.object({
  success: z.boolean(),
  pageId: z.string().uuid(),
});

export type DisconnectPageResponse = z.infer<
  typeof DisconnectPageResponseSchema
>;
