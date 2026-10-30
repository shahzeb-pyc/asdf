import { z } from 'zod';

/**
 * Threads accounts list contracts.
 *
 * Threads accounts are the unified `social_accounts` rows with
 * platform='threads' — the same table Facebook's list reads, filtered to
 * Threads only. This schema is the Threads view model only: it never
 * carries tokens, and it carries no pages (Threads has no pages), no
 * follower counts, and no queue counts.
 */

export const ThreadsAccountStatusSchema = z.enum([
  'active',
  'disconnected',
  'expired',
]);
export const ThreadsAccountStatusEnum = ThreadsAccountStatusSchema.enum;
export type ThreadsAccountStatus = z.infer<typeof ThreadsAccountStatusSchema>;

// Sanitized view model for UI presentation (zero token exposure).
export const ThreadsAccountViewSchema = z.object({
  id: z.string().uuid(),
  threadsAccountId: z.string().min(1).max(100),
  displayName: z.string().min(1).max(255),
  profilePictureUrl: z.string().url().nullable().optional().default(null),
  status: ThreadsAccountStatusSchema,
  tokenExpiresAt: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type ThreadsAccountView = z.infer<typeof ThreadsAccountViewSchema>;

export const ListThreadsAccountsResponseSchema = z.object({
  accounts: z.array(ThreadsAccountViewSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  totalPages: z.number().int().nonnegative().optional(),
  /**
   * Health counts over the FULL search-filtered set (not the page
   * slice), so the subtitle can report workspace totals while
   * paginated. The three buckets partition the filtered set exactly:
   * connected = active with a live-or-absent token; expired = stored
   * expired or a past token; error = everything else (disconnected
   * with a live-or-absent token).
   */
  healthCounts: z
    .object({
      connected: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative(),
      error: z.number().int().nonnegative(),
    })
    .optional(),
});

export type ListThreadsAccountsResponse = z.infer<
  typeof ListThreadsAccountsResponseSchema
>;

export const DisconnectThreadsAccountResponseSchema = z.object({
  success: z.boolean(),
  accountId: z.string().uuid(),
  disconnectedDestinationsCount: z.number().int().nonnegative(),
});

export type DisconnectThreadsAccountResponse = z.infer<
  typeof DisconnectThreadsAccountResponseSchema
>;
