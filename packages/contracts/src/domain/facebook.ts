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
  accountDisplayName: z.string().optional(),
  accountPictureUrl: z.string().nullable().optional().default(null),
  fbPageId: z.string().min(1).max(100),
  pageName: z.string().min(1).max(255),
  profilePictureUrl: z.string().url().nullable().optional().default(null),
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
 * Shared helper for fetching all Facebook Pages via /me/accounts with limit=100
 * and following cursor pagination (paging.next) up to maxPages (default: 5 = 500 pages max).
 * Each Graph request is bounded by a 30s timeout, composed with the caller's
 * signal when one is supplied via the optional trailing `options` argument.
 * The trailing options argument is additive — existing callers are unaffected.
 */
/**
 * Audit BG6 — paginated Graph fetch with truncation reporting.
 *
 * The old helper silently returned a partial list in two cases:
 * the maxPages cap (5 × 100 = 500 pages) with more pages behind
 * the cursor, and a failed later page (only the first-page
 * failure threw). Callers then reported the partial list as
 * complete — a selected page could be "missing" with no signal,
 * and a reconnect could refresh only a subset of page tokens.
 * The meta variant reports exactly that: `truncated` is true
 * whenever the loop stopped while a next cursor still existed,
 * with the reason (cap hit vs later-page error). The plain
 * helper is kept for callers that already treat absence as a
 * loud failure (e.g. the worker BG5 fallback, where a page
 * missing from any list — truncated or not — means "do not
 * retry").
 */
export interface FetchAllFacebookPagesResult {
  pages: FacebookGraphPageItem[];
  truncated: boolean;
  truncationReason?: 'page_limit' | 'page_error';
}

export async function fetchAllFacebookPagesWithMeta(
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
  let truncated = false;
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
      truncated = true;
      truncationReason = 'page_error';
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
  if (nextUrl && pagesFetched >= maxPages) {
    truncated = true;
    truncationReason = 'page_limit';
  }

  return {
    pages: allPages,
    truncated,
    ...(truncationReason ? { truncationReason } : {}),
  };
}

export async function fetchAllFacebookPages(
  accessToken: string,
  fields: string,
  maxPages = 5,
  fetchFn: typeof fetch = globalThis.fetch,
  options?: { signal?: AbortSignal }
): Promise<FacebookGraphPageItem[]> {
  const result = await fetchAllFacebookPagesWithMeta(
    accessToken,
    fields,
    maxPages,
    fetchFn,
    options
  );
  return result.pages;
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
  // Audit BG6: true when Graph pagination was truncated (cap or
  // later-page error) — the list is partial, never complete.
  // Optional with a default so older clients keep parsing.
  truncated: z.boolean().optional().default(false),
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
  disconnectedPagesCount: z.number().int().nonnegative(),
  // Audit BG10: whether the Facebook-side authorization was
  // actually revoked (DELETE /me/permissions). False means the
  // local disconnect still happened, but the app authorization
  // may still be live in the user's Facebook settings — the UI
  // must say so, never imply it was removed.
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
