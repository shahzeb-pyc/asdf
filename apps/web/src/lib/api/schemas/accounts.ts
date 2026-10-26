import { z } from 'zod';
import { PlatformSchema } from './common';

/**
 * Accounts resources.
 *
 * Sources: `GET /api/tenant/[subdomain]/accounts` (response parsed
 * server-side through the contracts `ListFacebookAccountsResponseSchema`),
 * `DELETE …/accounts/[accountId]`, `GET …/accounts/social`,
 * `POST …/accounts/magic-link`, plus the API test fixtures in
 * `tests/api/facebook-pages.test.ts` / `multi-account-oauth.test.ts`.
 *
 * Passthrough choices: none. Every nested object here
 * (`connectedPages`, `destinations`) is rendered by the UI, so all of
 * them are strict.
 */

export const FacebookAccountStatusSchema = z.enum(['active', 'disconnected', 'expired']);
export type FacebookAccountStatus = z.infer<typeof FacebookAccountStatusSchema>;

export const FacebookAccountLinkedPageSchema = z.object({
  id: z.string().uuid(),
  pageName: z.string().min(1),
  profilePictureUrl: z.string().nullable().optional(),
});
export type FacebookAccountLinkedPage = z.infer<typeof FacebookAccountLinkedPageSchema>;

export const FacebookAccountViewSchema = z.object({
  id: z.string().uuid(),
  fbAccountId: z.string().min(1),
  displayName: z.string().min(1),
  profilePictureUrl: z.string().nullable().optional(),
  gender: z.string().nullable().optional(),
  accountLink: z.string().nullable().optional(),
  status: FacebookAccountStatusSchema,
  tokenExpiresAt: z.string().nullable().optional(),
  connectedPagesCount: z.number().int().nonnegative(),
  connectedPages: z.array(FacebookAccountLinkedPageSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FacebookAccountView = z.infer<typeof FacebookAccountViewSchema>;

export const ListFacebookAccountsResponseSchema = z.object({
  accounts: z.array(FacebookAccountViewSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  totalPages: z.number().int().nonnegative().optional(),
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

export const DisconnectAccountResponseSchema = z.object({
  success: z.boolean(),
  accountId: z.string().uuid(),
  disconnectedPagesCount: z.number().int().nonnegative(),
});
export type DisconnectAccountResponse = z.infer<typeof DisconnectAccountResponseSchema>;

/** Unified cross-platform account list (spec 123's social accounts). */

export const SocialDestinationViewSchema = z.object({
  id: z.string(),
  externalDestinationId: z.string(),
  name: z.string(),
  handle: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  timezone: z.string(),
  status: z.string(),
  /** Provider-reported account type (destinations.metadata `account_type`); null = unknown, never guessed. */
  accountType: z.string().nullable(),
});
export type SocialDestinationView = z.infer<typeof SocialDestinationViewSchema>;

export const SocialAccountViewSchema = z.object({
  id: z.string(),
  platform: PlatformSchema,
  externalAccountId: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  status: z.string(),
  tokenExpiresAt: z.string().nullable(),
  destinations: z.array(SocialDestinationViewSchema),
});
export type SocialAccountView = z.infer<typeof SocialAccountViewSchema>;

export const ListSocialAccountsResponseSchema = z.object({
  accounts: z.array(SocialAccountViewSchema),
});
export type ListSocialAccountsResponse = z.infer<typeof ListSocialAccountsResponseSchema>;

export const MagicLinkResponseSchema = z.object({
  success: z.boolean(),
  magicUrl: z.string(),
  expiresAt: z.string(),
  expiresInSeconds: z.number(),
});
export type MagicLinkResponse = z.infer<typeof MagicLinkResponseSchema>;
