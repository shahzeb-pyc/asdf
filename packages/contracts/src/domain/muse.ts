import { z } from 'zod';

/**
 * Muse agent keys — Media Library only.
 *
 * A key is never stored in plaintext and never revealed after
 * creation. Only its SHA-256 hash is stored; revocation deletes
 * the row, so a revoked key simply stops matching. Scopes are
 * locked: a key can only ever carry media read + write.
 */
export const MuseKeyScopesSchema = z.tuple([
  z.literal('media:read'),
  z.literal('media:write'),
]);
export type MuseKeyScopes = z.infer<typeof MuseKeyScopesSchema>;

export const MUSE_KEY_SCOPES: readonly ['media:read', 'media:write'] = [
  'media:read',
  'media:write',
] as const;

/** Display prefix for a key: `fbu_…` + last 4 characters. */
export function museKeyPrefix(key: string): string {
  return `fbu_…${key.slice(-4)}`;
}

export function isMuseKeyFormat(key: string): boolean {
  return /^fbu_[0-9a-f]{32}$/.test(key);
}

export const AgentKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
});
export type AgentKeyCreate = z.infer<typeof AgentKeyCreateSchema>;

export const AgentKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  keyPrefix: z.string(),
  scopes: MuseKeyScopesSchema,
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type AgentKey = z.infer<typeof AgentKeySchema>;

/** Creation response — the ONLY response that ever carries the key. */
export const AgentKeyCreateResponseSchema = AgentKeySchema.extend({
  key: z.string(),
});
export type AgentKeyCreateResponse = z.infer<
  typeof AgentKeyCreateResponseSchema
>;

export const AgentKeyListResponseSchema = z.object({
  keys: z.array(AgentKeySchema),
});
export type AgentKeyListResponse = z.infer<typeof AgentKeyListResponseSchema>;

export const AgentActivityRowSchema = z.object({
  id: z.string().uuid(),
  mediaId: z.string().uuid(),
  mediaType: z.enum(['video', 'image']),
  folderId: z.string().uuid().nullable(),
  name: z.string(),
  createdAt: z.string(),
});
export type AgentActivityRow = z.infer<typeof AgentActivityRowSchema>;

export const MuseActivityResponseSchema = z.object({
  today: z.object({
    videos: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  days: z.array(
    z.object({
      label: z.string(),
      date: z.string(),
      rows: z.array(AgentActivityRowSchema),
    })
  ),
});
export type MuseActivityResponse = z.infer<typeof MuseActivityResponseSchema>;

/**
 * The exact prompt the Connect Muse dialogue offers to copy.
 * The guide link is the public app-host .md file; the order is
 * contractual: connector key first, then the entire guide, then
 * login via secure store. The key itself never goes in the prompt.
 */
export const MUSE_CONNECT_PROMPT =
  'Connect to my FBUploadPro account, in this order: 1. First, ask me for my FBUploadPro Media Library key using your FBUploadPro connector. Do not ask me to paste the key in chat. 2. Then read the entire Muse guide at https://app.fbuploadpro.com/muse_guide.md — read it all, not just a summary. 3. Then ask me for my FBUploadPro login via secure store, so you can use FBUploadPro in my browser. After that: upload media directly to my Media Library using my key. For everything else, use FBUploadPro in my browser. Guide me through every feature, step by step, using the guide. Act on my instructions without asking again, until I revoke the key.';
