import { z } from 'zod';

/**
 * Instagram accounts — wire vocabulary the UI renders.
 *
 * Instagram accounts live in the unified `social_accounts` table
 * (`platform = 'instagram'`); this file is only the presentation
 * contract for that read, mirroring the Facebook account view shape
 * minus everything Facebook-specific (no linked pages, no gender, no
 * account link). Zero token fields: the UI never sees a token.
 *
 * The unified stored status vocabulary is `active` / `expired` /
 * `revoked` / `error`; the wire vocabulary folds `revoked` and
 * `error` into `disconnected`, exactly as the Facebook wire map does,
 * so the UI renders three states only.
 */
export const InstagramAccountStatusSchema = z.enum([
  'active',
  'disconnected',
  'expired',
]);
export type InstagramAccountStatus = z.infer<
  typeof InstagramAccountStatusSchema
>;

/** Sanitized view model for one Instagram account. */
export const InstagramAccountViewSchema = z.object({
  id: z.string().uuid(),
  externalAccountId: z.string().min(1).max(100),
  displayName: z.string().min(1).max(255),
  profilePictureUrl: z.string().url().nullable().optional().default(null),
  status: InstagramAccountStatusSchema,
  tokenExpiresAt: z.coerce.date().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  /**
   * The account's publishing destinations (the `destinations` rows for this
   * account — for Instagram the destination IS the account itself, so this
   * is normally 1). Presentation-only: this is the real analogue of
   * Facebook's linked-pages count on the card strip, not a fabricated
   * pages count.
   */
  destinationCount: z.number().int().nonnegative().optional().default(0),
  /** Provider-reported Instagram username, from the destination row. */
  destinationHandle: z.string().nullable().optional().default(null),
  /** Destination display name, from the destination row. */
  destinationName: z.string().nullable().optional().default(null),
});
export type InstagramAccountView = z.infer<typeof InstagramAccountViewSchema>;

export const ListInstagramAccountsResponseSchema = z.object({
  accounts: z.array(InstagramAccountViewSchema),
  total: z.number().int().nonnegative(),
  /** Paginated response meta; optional so pre-pagination payloads still parse. */
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  totalPages: z.number().int().nonnegative().optional(),
  /** Health counts over the FULL filtered set (not the page slice). */
  healthCounts: z
    .object({
      connected: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative(),
      error: z.number().int().nonnegative(),
    })
    .optional(),
});
export type ListInstagramAccountsResponse = z.infer<
  typeof ListInstagramAccountsResponseSchema
>;

/** Disconnect acknowledgement: the account id plus how many of its destination rows went with it. */
export const DisconnectInstagramAccountResponseSchema = z.object({
  success: z.boolean(),
  accountId: z.string().uuid(),
  disconnectedDestinationsCount: z.number().int().nonnegative(),
});
export type DisconnectInstagramAccountResponse = z.infer<
  typeof DisconnectInstagramAccountResponseSchema
>;
