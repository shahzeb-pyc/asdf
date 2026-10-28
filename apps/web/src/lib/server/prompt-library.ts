import { type NextRequest, NextResponse } from 'next/server';
import {
  canAccessTenant,
  getSessionSecret,
  verifySessionToken,
  type PromptDetail,
  type PromptListItem,
  type PromptListQuery,
  type PromptCreateInput,
  type PromptUpdateInput,
  type PromptTool,
  type PromptCategory,
  type PromptLanguage,
  type PromptLength,
  type PromptFormat,
  type PromptAspectRatio,
  type PromptPreviewMediaType,
  type PromptStatus,
  promptFormatMatchesAspectRatio,
  isPromptLibraryStorageKey,
} from '@fbuploadpro/contracts';
import { getSupabaseAdminClient } from '@/lib/auth/clients';
import { logServerError } from '@/lib/server-analytics';

/**
 * Prompt Library server layer — admin-only writes, shared catalogue.
 *
 * Prompts are NEVER uploaded by users (Shahzeb, 2026-10-28): every
 * new prompt is added by US via the backend admin API only. There
 * is no user submission endpoint. Writes require session.role ===
 * 'admin' and return 403 otherwise — checked in requireAdmin(),
 * not by the frontend.
 *
 * The catalogue itself is GLOBAL, not per-workspace: the tenant
 * subdomain in the route is an access gate (canAccessTenant), not
 * a scope. Favourites are per-user (session.userId). Preview media
 * lives in R2 under prompts/{prompt_id}/; the database stores only
 * storage keys, and public URLs are derived from R2_PUBLIC_URL.
 * copied_count is never written by a client — only the
 * increment_prompt_copy RPC may change it.
 */

export type PromptDbRow = {
  id: string;
  slug: string;
  title: string;
  short_description: string;
  master_prompt: string;
  tool: PromptTool;
  category: PromptCategory;
  language: PromptLanguage;
  video_length_bucket: PromptLength;
  format: PromptFormat;
  aspect_ratio: PromptAspectRatio;
  preview_media_type: PromptPreviewMediaType;
  preview_storage_key: string;
  preview_poster_key: string | null;
  duration_seconds: number | null;
  copied_count: number;
  status: PromptStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type PromptStepDbRow = {
  id: string;
  position: number;
  title: string | null;
  body: string;
};

export function slugifyPromptTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');
  return slug || 'prompt';
}

/** Admin gate — the ONLY write gate for the library. */
export function isPromptAdmin(role: string | undefined): boolean {
  return role === 'admin';
}

export function requirePromptAdmin(role: string | undefined): NextResponse | null {
  if (isPromptAdmin(role)) return null;
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

export async function authenticatePromptRequest(
  request: NextRequest,
  subdomain: string,
): Promise<
  | { session: Awaited<ReturnType<typeof verifySessionToken>> }
  | { error: NextResponse }
> {
  const sessionCookie = request.cookies.get('fbup_session')?.value;
  if (!sessionCookie) {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  let session;
  try {
    session = await verifySessionToken(sessionCookie, getSessionSecret());
  } catch {
    return {
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  if (!canAccessTenant(session, subdomain).allowed) {
    return {
      error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    };
  }
  return { session };
}

export function getPromptPublicUrl(): string | null {
  const url = process.env.R2_PUBLIC_URL;
  return url && url.length > 0 ? url : null;
}

function previewUrls(
  row: PromptDbRow,
  publicUrl: string,
): { previewUrl: string; previewPosterUrl: string | null } {
  const previewUrl = `${publicUrl.replace(/\/+$/, '')}/${row.preview_storage_key}`;
  const previewPosterUrl = row.preview_poster_key
    ? `${publicUrl.replace(/\/+$/, '')}/${row.preview_poster_key}`
    : null;
  return { previewUrl, previewPosterUrl };
}

export function toPromptListItem(
  row: PromptDbRow,
  publicUrl: string,
  isFavourite: boolean,
): PromptListItem {
  const { previewUrl, previewPosterUrl } = previewUrls(row, publicUrl);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    shortDescription: row.short_description,
    tool: row.tool,
    category: row.category,
    language: row.language,
    length: row.video_length_bucket,
    format: row.format,
    aspectRatio: row.aspect_ratio,
    previewMediaType: row.preview_media_type,
    previewStorageKey: row.preview_storage_key,
    previewPosterKey: row.preview_poster_key,
    previewUrl,
    previewPosterUrl,
    durationSeconds: row.duration_seconds,
    copiedCount: row.copied_count,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isFavourite,
  };
}

export function toPromptDetail(
  row: PromptDbRow,
  steps: readonly PromptStepDbRow[],
  publicUrl: string,
  isFavourite: boolean,
): PromptDetail {
  const listItem = toPromptListItem(row, publicUrl, isFavourite);
  return {
    ...listItem,
    masterPrompt: row.master_prompt,
    steps: [...steps]
      .sort((a, b) => a.position - b.position)
      .map((step) => ({
        id: step.id,
        position: step.position,
        title: step.title,
        body: step.body,
      })),
  };
}

/** Escapes a search term for safe interpolation into a PostgREST ilike pattern. */
export function escapeIlikePattern(input: string): string {
  return input
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

/** Validates a merged prompt (existing row + patch) against the
 * cross-field invariants, so a PATCH cannot break them one field
 * at a time (e.g. format alone, without its aspect ratio). */
export function validateMergedPrompt(input: {
  format?: PromptFormat;
  aspectRatio?: PromptAspectRatio;
  previewMediaType?: PromptPreviewMediaType;
  previewPosterKey?: string | null;
  previewStorageKey?: string;
}): string | null {
  if (
    input.format !== undefined &&
    input.aspectRatio !== undefined &&
    !promptFormatMatchesAspectRatio(input.format, input.aspectRatio)
  ) {
    return 'Aspect ratio must match the format (vertical 9:16, horizontal 16:9)';
  }
  if (
    input.previewMediaType === 'video' &&
    (input.previewPosterKey === undefined || input.previewPosterKey === null)
  ) {
    return 'A video preview requires a poster key';
  }
  if (
    input.previewStorageKey !== undefined &&
    !isPromptLibraryStorageKey(input.previewStorageKey)
  ) {
    return 'Storage key must live under the prompts/ prefix in R2';
  }
  if (
    input.previewPosterKey !== undefined &&
    input.previewPosterKey !== null &&
    !isPromptLibraryStorageKey(input.previewPosterKey)
  ) {
    return 'Poster key must live under the prompts/ prefix in R2';
  }
  return null;
}

/** DB insert shape (snake_case columns), distinct from the
 * camelCase contracts input — do not derive it from that input
 * with Omit, or the camelCase fields leak into the row type. */
export type PromptCreateRow = {
  slug: string;
  title: string;
  short_description: string;
  master_prompt: string;
  tool: PromptTool;
  category: PromptCategory;
  language: PromptLanguage;
  video_length_bucket: PromptLength;
  format: PromptFormat;
  aspect_ratio: PromptAspectRatio;
  preview_media_type: PromptPreviewMediaType;
  preview_storage_key: string;
  preview_poster_key: string | null;
  duration_seconds: number | null;
  status: PromptStatus;
};

export function toPromptCreateRow(
  input: PromptCreateInput,
  slug: string,
  createdBy: string,
): PromptCreateRow & { created_by: string } {
  return {
    slug,
    title: input.title,
    short_description: input.shortDescription,
    master_prompt: input.masterPrompt,
    tool: input.tool,
    category: input.category,
    language: input.language,
    video_length_bucket: input.length,
    format: input.format,
    aspect_ratio: input.aspectRatio,
    preview_media_type: input.previewMediaType,
    preview_storage_key: input.previewStorageKey,
    preview_poster_key: input.previewPosterKey ?? null,
    duration_seconds: input.durationSeconds ?? null,
    status: input.status,
    created_by: createdBy,
  };
}

export type PromptUpdateRow = Partial<
  Omit<PromptCreateRow, 'slug' | 'created_by'>
> & { slug?: string };

export function toPromptUpdateRow(
  input: PromptUpdateInput,
): PromptUpdateRow {
  const row: PromptUpdateRow = {};
  if (input.title !== undefined) row.title = input.title;
  if (input.shortDescription !== undefined)
    row.short_description = input.shortDescription;
  if (input.masterPrompt !== undefined) row.master_prompt = input.masterPrompt;
  if (input.tool !== undefined) row.tool = input.tool;
  if (input.category !== undefined) row.category = input.category;
  if (input.language !== undefined) row.language = input.language;
  if (input.length !== undefined) row.video_length_bucket = input.length;
  if (input.format !== undefined) row.format = input.format;
  if (input.aspectRatio !== undefined) row.aspect_ratio = input.aspectRatio;
  if (input.previewMediaType !== undefined)
    row.preview_media_type = input.previewMediaType;
  if (input.previewStorageKey !== undefined)
    row.preview_storage_key = input.previewStorageKey;
  if (input.previewPosterKey !== undefined)
    row.preview_poster_key = input.previewPosterKey ?? null;
  if (input.durationSeconds !== undefined)
    row.duration_seconds = input.durationSeconds ?? null;
  if (input.status !== undefined) row.status = input.status;
  if (input.slug !== undefined) row.slug = input.slug;
  return row;
}

export function getPromptAdminClient() {
  const client = getSupabaseAdminClient();
  if (!client) {
    logServerError('[prompt-library] Supabase admin client unavailable', null, {
      source: 'prompt-library',
    });
  }
  return client;
}

export type PromptListQueryInput = PromptListQuery;

export function logPromptError(message: string, error: unknown): void {
  logServerError(message, error, { source: 'prompt-library' });
}
