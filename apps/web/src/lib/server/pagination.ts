/**
 * Shared list-pagination parsing and math for the tenant list routes
 * (Facebook Pages, Facebook Accounts).
 *
 * Page size is 30 per page (Shahzeb's call): large enough that a
 * typical workspace fits on one or two pages, small enough that a
 * 200-page workspace never downloads everything at once.
 *
 * - `parsePaginationParams` reads ?page= / ?limit= off a request URL:
 *   page defaults to 1, limit defaults to 30 and clamps to 1..50, and
 *   anything unparseable falls back to the defaults instead of 400ing
 *   (a bad ?page= in a shared link must not break the list).
 * - `paginateMeta` turns a filtered total into the response meta:
 *   page clamped to the last page (never an empty grid with no
 *   explanation), totalPages, and the 1-based "Showing X–Y" window.
 * - `paginateItems` slices an already-filtered, already-sorted array
 *   with the same meta — used by the Supabase query paths, where
 *   PostgREST cannot order by the attention/expiry rank the shells
 *   require (see the route comments), so the slice happens after the
 *   existing map + sort instead of via a SQL range.
 */

export const DEFAULT_PAGE_SIZE = 30;
export const MAX_PAGE_SIZE = 50;

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginationMeta extends PaginationParams {
  total: number;
  totalPages: number;
  /** 1-based first item on the page; 0 when total is 0. */
  start: number;
  /** 1-based last item on the page; 0 when total is 0. */
  end: number;
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

export function parsePaginationParams(
  searchParams: URLSearchParams
): PaginationParams {
  const page = parsePositiveInt(searchParams.get('page'), 1);
  const limit = Math.min(
    parsePositiveInt(searchParams.get('limit'), DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  );
  return { page, limit };
}

export function paginateMeta(
  total: number,
  requestedPage: number,
  limit: number
): PaginationMeta {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const page = totalPages === 0 ? 1 : Math.min(requestedPage, totalPages);
  const start = total === 0 ? 0 : (page - 1) * limit + 1;
  const end = total === 0 ? 0 : Math.min(page * limit, total);
  return { page, limit, total, totalPages, start, end };
}

export function paginateItems<T>(
  items: T[],
  requestedPage: number,
  limit: number
): { items: T[]; meta: PaginationMeta } {
  const meta = paginateMeta(items.length, requestedPage, limit);
  const offset = (meta.page - 1) * limit;
  return { items: items.slice(offset, offset + limit), meta };
}
