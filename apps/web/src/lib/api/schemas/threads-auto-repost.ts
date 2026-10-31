/**
 * Threads Auto Repost resources.
 *
 * Sources: `GET/POST …/threads/auto-repost` and
 * `GET/PATCH/DELETE …/threads/auto-repost/[mirrorId]` — all parsed
 * server-side through the contracts tiktok-mirror schemas. The web
 * client re-exports those contracts schemas directly (single source
 * of truth) instead of maintaining a second mirror copy. The mirror
 * shapes are shared with Facebook Auto Repost; the routes filter to
 * target_platform='threads', so a Threads list never shows a
 * Facebook mirror.
 */
import { z } from 'zod';

export {
  CreateMirrorRequestSchema,
  CreateMirrorResponseSchema,
  DeleteMirrorResponseSchema,
  ListMirrorsResponseSchema,
  MirrorDetailResponseSchema,
  MirrorPostRowSchema,
  MirrorPostStatusSchema,
  MirrorRowSchema,
  MirrorStatusSchema,
  MirrorViewSchema,
  UpdateMirrorRequestSchema,
  type CreateMirrorRequest,
  type CreateMirrorResponse,
  type DeleteMirrorResponse,
  type ListMirrorsResponse,
  type MirrorDetailResponse,
  type MirrorPostRow,
  type MirrorPostStatus,
  type MirrorRow,
  type MirrorStatus,
  type MirrorView,
  type UpdateMirrorRequest,
} from '@fbuploadpro/contracts';

/** PATCH …/threads/auto-repost/[mirrorId] response (ack + new status). */
export const UpdateMirrorResponseSchema = z.object({
  ok: z.boolean(),
  status: z.enum(['active', 'paused']),
});
export type UpdateMirrorResponse = z.infer<typeof UpdateMirrorResponseSchema>;
