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
  /** Exact length in seconds, as the source states it; null = unknown. */
  video_duration_seconds: number | null;
  format: PromptFormat;
  aspect_ratio: PromptAspectRatio;
  copied_count: number;
  status: PromptStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** One row of prompt_library_media. A prompt has many media items;
 * exactly one is the main (partial unique index in the migration). */
export type PromptMediaDbRow = {
  id: string;
  prompt_id: string;
  position: number;
  media_type: PromptPreviewMediaType;
  storage_key: string;
  poster_key: string | null;
  duration_seconds: number | null;
  is_main: boolean;
  created_at: string;
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

function mediaUrls(
  row: PromptMediaDbRow,
  publicUrl: string,
): { url: string; posterUrl: string | null } {
  const base = publicUrl.replace(/\/+$/, '');
  return {
    url: `${base}/${row.storage_key}`,
    posterUrl: row.poster_key ? `${base}/${row.poster_key}` : null,
  };
}

export function toPromptMedia(
  row: PromptMediaDbRow,
  publicUrl: string,
): import('@fbuploadpro/contracts').PromptMedia {
  const { url, posterUrl } = mediaUrls(row, publicUrl);
  return {
    id: row.id,
    position: row.position,
    mediaType: row.media_type,
    storageKey: row.storage_key,
    posterKey: row.poster_key,
    url,
    posterUrl,
    durationSeconds: row.duration_seconds,
    isMain: row.is_main,
  };
}

/** The main media item: the is_main row, else the first by position
 * (defensive — the DB guarantees exactly one main). */
export function mainPromptMedia(
  mediaRows: readonly PromptMediaDbRow[],
): PromptMediaDbRow | null {
  if (mediaRows.length === 0) return null;
  return (
    mediaRows.find((row) => row.is_main) ??
    [...mediaRows].sort((a, b) => a.position - b.position)[0]
  );
}

/** Gallery order for the detail section: main first, then position. */
export function sortPromptMediaForDetail(
  mediaRows: readonly PromptMediaDbRow[],
): PromptMediaDbRow[] {
  return [...mediaRows].sort(
    (a, b) =>
      Number(b.is_main) - Number(a.is_main) || a.position - b.position,
  );
}

function promptListFields(
  row: PromptDbRow,
  main: PromptMediaDbRow | null,
  publicUrl: string,
  isFavourite: boolean,
): PromptListItem {
  // Fail loud, never a fake preview URL: the DB guarantees one main
  // per prompt, so a missing main is corrupt data, not an empty card.
  if (!main) {
    throw new Error(`Prompt ${row.slug} has no main media`);
  }
  const preview = mediaUrls(main, publicUrl);
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    shortDescription: row.short_description,
    tool: row.tool,
    category: row.category,
    language: row.language,
    length: row.video_length_bucket,
    // ?? null: a row from before the exact-length migration (or a
    // test double built before it) has no such column — that means
    // "exact length unknown", which is exactly what null means, so
    // the UI falls back to the bucket label instead of failing.
    exactDurationSeconds: row.video_duration_seconds ?? null,
    format: row.format,
    aspectRatio: row.aspect_ratio,
    // List items carry ONLY the main media: its type + URLs.
    previewMediaType: main.media_type,
    previewUrl: preview.url,
    previewPosterUrl: preview.posterUrl,
    copiedCount: row.copied_count,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isFavourite,
  };
}

export function toPromptListItem(
  row: PromptDbRow,
  mediaRows: readonly PromptMediaDbRow[],
  publicUrl: string,
  isFavourite: boolean,
): PromptListItem {
  return promptListFields(
    row,
    mainPromptMedia(mediaRows),
    publicUrl,
    isFavourite,
  );
}

export function toPromptDetail(
  row: PromptDbRow,
  steps: readonly PromptStepDbRow[],
  mediaRows: readonly PromptMediaDbRow[],
  publicUrl: string,
  isFavourite: boolean,
): PromptDetail {
  const listItem = toPromptListItem(row, mediaRows, publicUrl, isFavourite);
  return {
    ...listItem,
    masterPrompt: row.master_prompt,
    media: sortPromptMediaForDetail(mediaRows).map((mediaRow) =>
      toPromptMedia(mediaRow, publicUrl),
    ),
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
 * at a time (e.g. format alone, without its aspect ratio). Media
 * rules (exactly one main, video poster, prompts/ prefix) are
 * enforced by the contracts media schema, not here. */
export function validateMergedPrompt(input: {
  format?: PromptFormat;
  aspectRatio?: PromptAspectRatio;
}): string | null {
  if (
    input.format !== undefined &&
    input.aspectRatio !== undefined &&
    !promptFormatMatchesAspectRatio(input.format, input.aspectRatio)
  ) {
    return 'Aspect ratio must match the format (vertical 9:16, horizontal 16:9)';
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
  video_duration_seconds: number | null;
  format: PromptFormat;
  aspect_ratio: PromptAspectRatio;
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
    video_duration_seconds: input.exactDurationSeconds ?? null,
    format: input.format,
    aspect_ratio: input.aspectRatio,
    status: input.status,
    created_by: createdBy,
  };
}

/** Media insert rows for a prompt (contracts input → snake_case). */
export function toPromptMediaInsertRows(
  media: readonly import('@fbuploadpro/contracts').PromptMediaItemInput[],
  promptId: string,
) {
  return media.map((item) => ({
    prompt_id: promptId,
    position: item.position,
    media_type: item.mediaType,
    storage_key: item.storageKey,
    poster_key: item.posterKey ?? null,
    duration_seconds: item.durationSeconds ?? null,
    is_main: item.isMain,
  }));
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
  if (input.exactDurationSeconds !== undefined)
    row.video_duration_seconds = input.exactDurationSeconds;
  if (input.format !== undefined) row.format = input.format;
  if (input.aspectRatio !== undefined) row.aspect_ratio = input.aspectRatio;
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
