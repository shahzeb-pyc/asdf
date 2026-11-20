import {
  BULK_DELETE_MAX_PREVIEW,
  decryptToken,
  evaluateGraphApiError,
  getTokenEncryptionKey,
  type BulkDeleteContentItem,
  type BulkDeleteContentType,
  type BulkDeletePreviewType,
  type BulkDeleteSort,
  type Database,
} from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Facebook Bulk Delete — server service (spec 213).
 *
 * Live published posts only, through the Graph API v26.0. The account
 * token is resolved server-side from `social_accounts` and lives only
 * in this call's memory; the client never supplies a token. Nothing
 * is written to the database. Deletes are single-attempt, sequential,
 * one Graph DELETE per id.
 *
 * Old shapes kept from the old implementation
 * (`~/workspace/old-fbuploadpro`, page-tools-service.ts): the list
 * endpoints and fields, the `video_reels` → `videos` fallback, the
 * title fallbacks, permalink normalisation, and the `(#200)` masking
 * to "Failed to delete". Deliberate divergences: Graph v26.0 (old was
 * v19.0), explicit fetch timeouts, and over-cap requests are rejected
 * instead of silently sliced.
 */

const GRAPH_BASE_URL = 'https://graph.facebook.com/v26.0';
const LIST_TIMEOUT_MS = 30_000;
const DELETE_TIMEOUT_MS = 15_000;
const PREVIEW_PAGE_SIZE = 100;

export class BulkDeleteError extends Error {
  readonly code: 'ACCOUNT_NOT_FOUND' | 'TOKEN_UNAVAILABLE' | 'TOKEN_DEAD' | 'GRAPH_ERROR';

  constructor(
    code: BulkDeleteError['code'],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BulkDeleteError';
    this.code = code;
  }
}

type GraphFetch = typeof fetch;

interface GraphErrorBody {
  error?: {
    code?: number;
    error_subcode?: number;
    message?: string;
  };
}

interface GraphPageResponse<T> {
  data: T[];
  paging?: { cursors?: { after?: string } };
}

interface GraphPost {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
  full_picture?: string;
}

interface GraphPhoto {
  id: string;
  name?: string;
  created_time?: string;
  permalink_url?: string;
  images?: Array<{ source?: string }>;
}

interface GraphVideo {
  id: string;
  title?: string;
  description?: string;
  created_time?: string;
  permalink_url?: string;
  thumbnails?: { data?: Array<{ uri?: string }> };
}

function parseGraphErrorBody(body: unknown): {
  code?: number;
  subcode?: number;
  message?: string;
} {
  if (typeof body !== 'object' || body === null) return {};
  const error = (body as GraphErrorBody).error;
  if (typeof error !== 'object' || error === null) return {};
  return {
    ...(typeof error.code === 'number' ? { code: error.code } : {}),
    ...(typeof error.error_subcode === 'number' ? { subcode: error.error_subcode } : {}),
    ...(typeof error.message === 'string' ? { message: error.message } : {}),
  };
}

async function graphGetJson<T>(
  fetchFn: GraphFetch,
  path: string,
  params: Record<string, string | number>,
  timeoutMs: number,
): Promise<T> {
  const url = new URL(`${GRAPH_BASE_URL}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  let response: Response;
  try {
    response = await fetchFn(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new BulkDeleteError('GRAPH_ERROR', 'Facebook did not answer. Try again.', {
      cause: err,
    });
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const { code, subcode, message } = parseGraphErrorBody(body);
    const evaluation =
      code !== undefined ? evaluateGraphApiError(code, subcode, message) : null;
    if (code === 190 || code === 102) {
      throw new BulkDeleteError(
        'TOKEN_DEAD',
        evaluation?.message ?? 'The Facebook account needs reconnecting.',
      );
    }
    throw new BulkDeleteError(
      'GRAPH_ERROR',
      message ?? 'Facebook refused the request.',
      { cause: code !== undefined ? { code, subcode } : undefined },
    );
  }
  return body as T;
}

async function graphDeleteId(
  fetchFn: GraphFetch,
  id: string,
  accessToken: string,
): Promise<void> {
  const url = new URL(`${GRAPH_BASE_URL}/${encodeURIComponent(id)}`);
  url.searchParams.set('access_token', accessToken);
  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: 'DELETE',
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new BulkDeleteError('GRAPH_ERROR', 'Facebook did not answer. Try again.', {
      cause: err,
    });
  }
  if (response.ok) return;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const { code, subcode, message } = parseGraphErrorBody(body);
  const evaluation =
    code !== undefined ? evaluateGraphApiError(code, subcode, message) : null;
  if (code === 190 || code === 102) {
    throw new BulkDeleteError(
      'TOKEN_DEAD',
      evaluation?.message ?? 'The Facebook account needs reconnecting.',
    );
  }
  // Attach the parsed Graph code to the error so the caller can map
  // already-deleted ids (803) and permission failures (200).
  const error = new BulkDeleteError('GRAPH_ERROR', message ?? 'Delete failed.');
  if (code !== undefined) {
    (error as BulkDeleteError & { graphCode?: number }).graphCode = code;
  }
  throw error;
}

function graphCodeOf(error: unknown): number | undefined {
  if (error instanceof BulkDeleteError) {
    return (error as BulkDeleteError & { graphCode?: number }).graphCode;
  }
  return undefined;
}

function normalizeFacebookPermalink(url?: string | null): string | null {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return `https://www.facebook.com${url}`;
  return `https://www.facebook.com/${url}`;
}

function mapPosts(items: GraphPost[]): BulkDeleteContentItem[] {
  return items.map((item) => ({
    id: item.id,
    type: 'posts' as const,
    title: (item.message || '').trim() || 'Untitled post',
    createdTime: item.created_time || null,
    permalinkUrl: normalizeFacebookPermalink(item.permalink_url),
    previewImageUrl: item.full_picture || null,
  }));
}

function mapPhotos(items: GraphPhoto[]): BulkDeleteContentItem[] {
  return items.map((item) => ({
    id: item.id,
    type: 'photos' as const,
    title: (item.name || '').trim() || 'Untitled photo',
    createdTime: item.created_time || null,
    permalinkUrl: normalizeFacebookPermalink(item.permalink_url),
    previewImageUrl: item.images?.[0]?.source || null,
  }));
}

function mapVideos(items: GraphVideo[]): BulkDeleteContentItem[] {
  return items.map((item) => ({
    id: item.id,
    type: 'reels' as const,
    title: (item.title || item.description || '').trim() || 'Untitled reel',
    createdTime: item.created_time || null,
    permalinkUrl: normalizeFacebookPermalink(item.permalink_url),
    previewImageUrl: item.thumbnails?.data?.[0]?.uri || null,
  }));
}

/** Date bounds: From is day-start, To is day-end (old DayPicker semantics). */
function dateBounds(dateFrom?: string, dateTo?: string): { since?: number; until?: number } {
  const bounds: { since?: number; until?: number } = {};
  if (dateFrom) {
    const from = Date.parse(`${dateFrom}T00:00:00.000Z`);
    if (!Number.isNaN(from)) bounds.since = Math.floor(from / 1000);
  }
  if (dateTo) {
    const to = Date.parse(`${dateTo}T23:59:59.999Z`);
    if (!Number.isNaN(to)) bounds.until = Math.floor(to / 1000);
  }
  return bounds;
}

function matchesDateBounds(item: BulkDeleteContentItem, dateFrom?: string, dateTo?: string): boolean {
  if (!item.createdTime) return true;
  const createdAt = Date.parse(item.createdTime);
  if (Number.isNaN(createdAt)) return true;
  const { since, until } = dateBounds(dateFrom, dateTo);
  if (since !== undefined && createdAt < since * 1000) return false;
  if (until !== undefined && createdAt > until * 1000 + 999) return false;
  return true;
}

function sortItems(items: BulkDeleteContentItem[], sort: BulkDeleteSort): BulkDeleteContentItem[] {
  return [...items].sort((a, b) => {
    const av = a.createdTime ? Date.parse(a.createdTime) : 0;
    const bv = b.createdTime ? Date.parse(b.createdTime) : 0;
    return sort === 'oldest_first' ? av - bv : bv - av;
  });
}

/**
 * Resolve the account token server-side. One row, workspace-scoped;
 * the token is decrypted in memory and never leaves this call.
 */
export async function resolveAccountToken(
  supabase: SupabaseClient<Database>,
  workspaceId: string,
  accountId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('social_accounts')
    .select('encrypted_access_token')
    .eq('id', accountId)
    .eq('workspace_id', workspaceId)
    .eq('platform', 'facebook')
    .maybeSingle();
  if (error) {
    throw new BulkDeleteError('ACCOUNT_NOT_FOUND', 'Could not read the Facebook account.', {
      cause: error,
    });
  }
  // Single-column select resolves `data` to `never` in this supabase-js
  // version's types (same as the ADU route) — cast the row, as it does.
  const encrypted = (data as { encrypted_access_token?: unknown } | null)
    ?.encrypted_access_token;
  if (typeof encrypted !== 'string' || !encrypted) {
    throw new BulkDeleteError(
      'ACCOUNT_NOT_FOUND',
      'Facebook account not found for this workspace.',
    );
  }
  try {
    return await decryptToken(encrypted, getTokenEncryptionKey());
  } catch (err) {
    throw new BulkDeleteError('TOKEN_UNAVAILABLE', 'The Facebook account token could not be read.', {
      cause: err,
    });
  }
}

async function fetchReelsPage(
  fetchFn: GraphFetch,
  accessToken: string,
  pageId: string,
  limit: number,
  after: string | undefined,
  bounds: { since?: number; until?: number },
): Promise<GraphPageResponse<GraphVideo>> {
  const params: Record<string, string | number> = {
    access_token: accessToken,
    fields: 'id,title,description,created_time,permalink_url,thumbnails',
    limit,
    ...(after ? { after } : {}),
    ...bounds,
  };
  try {
    return await graphGetJson<GraphPageResponse<GraphVideo>>(
      fetchFn,
      `${pageId}/video_reels`,
      params,
      LIST_TIMEOUT_MS,
    );
  } catch {
    // Old behaviour: a page without the reels edge falls back to videos.
    return graphGetJson<GraphPageResponse<GraphVideo>>(
      fetchFn,
      `${pageId}/videos`,
      params,
      LIST_TIMEOUT_MS,
    );
  }
}

export async function listPageContent(
  fetchFn: GraphFetch,
  accessToken: string,
  params: {
    pageId: string;
    type: BulkDeleteContentType;
    limit: number;
    after?: string;
    dateFrom?: string;
    dateTo?: string;
  },
): Promise<{ items: BulkDeleteContentItem[]; paging: { after: string | null } }> {
  const bounds = dateBounds(params.dateFrom, params.dateTo);
  const common: Record<string, string | number> = {
    access_token: accessToken,
    limit: params.limit,
    ...(params.after ? { after: params.after } : {}),
    ...bounds,
  };
  if (params.type === 'posts') {
    const response = await graphGetJson<GraphPageResponse<GraphPost>>(
      fetchFn,
      `${params.pageId}/posts`,
      { ...common, fields: 'id,message,created_time,permalink_url,full_picture' },
      LIST_TIMEOUT_MS,
    );
    return {
      items: mapPosts(response.data ?? []),
      paging: { after: response.paging?.cursors?.after ?? null },
    };
  }
  if (params.type === 'photos') {
    const response = await graphGetJson<GraphPageResponse<GraphPhoto>>(
      fetchFn,
      `${params.pageId}/photos`,
      { ...common, fields: 'id,name,created_time,permalink_url,images' },
      LIST_TIMEOUT_MS,
    );
    return {
      items: mapPhotos(response.data ?? []),
      paging: { after: response.paging?.cursors?.after ?? null },
    };
  }
  const response = await fetchReelsPage(
    fetchFn,
    accessToken,
    params.pageId,
    params.limit,
    params.after,
    bounds,
  );
  return {
    items: mapVideos(response.data ?? []),
    paging: { after: response.paging?.cursors?.after ?? null },
  };
}

export async function resolveDeleteCandidates(
  fetchFn: GraphFetch,
  accessToken: string,
  params: {
    pageId: string;
    type: BulkDeletePreviewType;
    sort: BulkDeleteSort;
    dateFrom?: string;
    dateTo?: string;
  },
): Promise<{ total: number; candidates: BulkDeleteContentItem[] }> {
  const types: BulkDeleteContentType[] =
    params.type === 'all' ? ['posts', 'photos', 'reels'] : [params.type];
  const collected: BulkDeleteContentItem[] = [];
  // Sequential fan-out: one type at a time, rate-limit friendly.
  for (const type of types) {
    let after: string | undefined;
    while (collected.length < BULK_DELETE_MAX_PREVIEW) {
      const page = await listPageContent(fetchFn, accessToken, {
        pageId: params.pageId,
        type,
        limit: PREVIEW_PAGE_SIZE,
        ...(after ? { after } : {}),
        ...(params.dateFrom ? { dateFrom: params.dateFrom } : {}),
        ...(params.dateTo ? { dateTo: params.dateTo } : {}),
      });
      const items = page.items ?? [];
      if (items.length === 0) break;
      collected.push(...items);
      after = page.paging.after ?? undefined;
      if (!after) break;
    }
    if (collected.length >= BULK_DELETE_MAX_PREVIEW) break;
  }
  const filtered = collected.filter((item) =>
    matchesDateBounds(item, params.dateFrom, params.dateTo),
  );
  const sorted = sortItems(filtered, params.sort);
  return { total: sorted.length, candidates: sorted.slice(0, BULK_DELETE_MAX_PREVIEW) };
}

export interface BulkDeleteItemResult {
  id: string;
  success: boolean;
  alreadyDeleted?: boolean;
  error?: string;
}

/**
 * Delete ids sequentially, one Graph DELETE per id, one attempt each.
 * Already-gone ids (Graph 803 / "does not exist") report success so a
 * retry after a lost response cannot turn them into new failures.
 * Permission failures (200) are masked to "Failed to delete".
 * A dead token fails the whole batch loudly instead of per-item.
 */
export async function bulkDeleteContent(
  fetchFn: GraphFetch,
  accessToken: string,
  contentIds: string[],
): Promise<{ total: number; succeeded: number; failed: number; results: BulkDeleteItemResult[] }> {
  const results: BulkDeleteItemResult[] = [];
  for (const id of contentIds) {
    try {
      await graphDeleteId(fetchFn, id, accessToken);
      results.push({ id, success: true });
    } catch (error) {
      if (error instanceof BulkDeleteError && error.code === 'TOKEN_DEAD') throw error;
      const code = graphCodeOf(error);
      const message = error instanceof Error ? error.message : 'Delete failed.';
      if (code === 803 || /does not exist/i.test(message)) {
        results.push({ id, success: true, alreadyDeleted: true });
      } else if (code === 200) {
        results.push({ id, success: false, error: 'Failed to delete' });
      } else {
        results.push({ id, success: false, error: message || 'Failed to delete' });
      }
    }
  }
  const succeeded = results.filter((item) => item.success).length;
  return { total: results.length, succeeded, failed: results.length - succeeded, results };
}
