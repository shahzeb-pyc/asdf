import { z } from 'zod';
import { CredentialsStatusSchema } from './common';

/**
 * Settings resources (BYOC / per-platform app details).
 *
 * Sources: `GET/PUT/DELETE …/settings/byoc` and
 * `GET/PUT/DELETE …/settings/platform-credentials/[platform]`, plus
 * the reveal actions `POST …/settings/byoc/reveal` and
 * `POST …/settings/platform-credentials/[platform]/reveal` — all
 * construct their JSON inline in the route handlers (no server-side
 * response schema), so these schemas are transcribed from that
 * construction, cross-checked against `tests/api/byoc-settings-api.test.ts`
 * and `tests/api/platform-credentials-api.test.ts`.
 *
 * Spec 139 N3: the GET payloads are masked-by-default — they carry a
 * secret HINT (bullets + last four) and never the secret itself. The
 * full value is returned only by the reveal actions, whose response
 * schemas are the two `Reveal*` schemas below.
 *
 * Passthrough choices: none — both payloads are flat objects whose
 * fields the settings UI renders.
 */

export const ByocSettingsResponseSchema = z.object({
  workspaceId: z.string().uuid(),
  subdomain: z.string(),
  fbAppId: z.string(),
  fbAppSecretHint: z.string().nullable(),
  hasSecret: z.boolean(),
  status: CredentialsStatusSchema,
  lastTestedAt: z.string().nullable(),
  /** Meta app display name from the Graph verification; null until first verification. */
  fbAppName: z.string().nullable(),
  connectedAt: z.string().nullable(),
});
export type ByocSettingsResponse = z.infer<typeof ByocSettingsResponseSchema>;

export const RevealByocSecretResponseSchema = z.object({
  fbAppSecret: z.string(),
});
export type RevealByocSecretResponse = z.infer<typeof RevealByocSecretResponseSchema>;

export const SaveCredentialsResponseSchema = z.object({
  success: z.boolean(),
  hasSecret: z.boolean(),
  status: CredentialsStatusSchema,
  connectedAt: z.string(),
  /**
   * Meta app display name from the Graph verification. Optional because
   * this schema is shared with the Instagram/Threads app-details save,
   * which does not verify and never returns a name.
   */
  fbAppName: z.string().nullable().optional(),
});
export type SaveCredentialsResponse = z.infer<typeof SaveCredentialsResponseSchema>;

export const DeleteByocResponseSchema = z.object({
  success: z.boolean(),
  disconnected: z.boolean(),
});
export type DeleteByocResponse = z.infer<typeof DeleteByocResponseSchema>;

export const PlatformCredentialsResponseSchema = z.object({
  workspaceId: z.string().uuid(),
  subdomain: z.string(),
  platform: z.string(),
  appId: z.string(),
  secretHint: z.string().nullable(),
  hasSecret: z.boolean(),
  status: CredentialsStatusSchema,
  lastTestedAt: z.string().nullable(),
  connectedAt: z.string().nullable(),
});
export type PlatformCredentialsResponse = z.infer<
  typeof PlatformCredentialsResponseSchema
>;

export const RevealPlatformSecretResponseSchema = z.object({
  appSecret: z.string(),
});
export type RevealPlatformSecretResponse = z.infer<
  typeof RevealPlatformSecretResponseSchema
>;

export const DeletePlatformCredentialsResponseSchema = z.object({
  success: z.boolean(),
});
export type DeletePlatformCredentialsResponse = z.infer<
  typeof DeletePlatformCredentialsResponseSchema
>;
