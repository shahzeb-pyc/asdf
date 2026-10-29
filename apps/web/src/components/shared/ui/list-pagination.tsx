'use client';

/**
 * ListPagination — the ONE pagination control for the tenant lists
 * (Facebook Pages, Facebook Accounts). Numbered pages with ellipsis,
 * Prev / Next, and a muted "Showing X–Y of Z" line, built on the
 * shared Button variants and tokens only.
 *
 * - Renders nothing when there is one page or zero items: a single
 *   page needs no controls.
 * - Prev is disabled on page 1, Next on the last page; the current
 *   number carries aria-current="page" and every button an aria-label.
 * - Page state lives in the caller (and in the URL ?page= there); this
 *   component only reports the requested page via onPageChange.
 * - No status marks of any kind live here, so the no-dots rule cannot
 *   be broken by this component.
 */

import * as React from 'react';
import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { buttonVariants } from './button';

export type PageNumberItem = number | 'ellipsis';

/**
 * The numbered window: every page when there are 7 or fewer, otherwise
 * the first page, the last page, the current page with one neighbour on
 * each side, and an ellipsis wherever pages are skipped
 * (1 … 4 5 6 … 20).
 */
export function getPageNumbers(
  page: number,
  totalPages: number
): PageNumberItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const window = new Set<number>([1, totalPages, page - 1, page, page + 1]);
  const sorted = [...window]
    .filter((n) => n >= 1 && n <= totalPages)
    .sort((a, b) => a - b);
  const items: PageNumberItem[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
      items.push('ellipsis');
    }
    items.push(sorted[i]);
  }
  return items;
}

export interface ListPaginationProps {
  page: number;
  totalPages: number;
  total: number;
  limit: number;
  onPageChange: (page: number) => void;
}

export function ListPagination({
  page,
  totalPages,
  total,
  limit,
  onPageChange,
}: Readonly<ListPaginationProps>) {
  if (totalPages <= 1) {
    return null;
  }
  const start = (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  const numbers = getPageNumbers(page, totalPages);

  return (
    <div
      data-testid="list-pagination"
      className="mt-6 flex flex-col items-center gap-3"
    >
      <nav aria-label="Pagination">
        <ul className="flex flex-row flex-wrap items-center justify-center gap-1">
          <li>
            <button
              type="button"
              data-testid="pagination-prev"
              aria-label="Go to previous page"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'default' }),
                'gap-1 px-2.5'
              )}
            >
              <ChevronLeftIcon aria-hidden />
              <span className="hidden sm:block">Previous</span>
            </button>
          </li>
          {numbers.map((item, index) =>
            item === 'ellipsis' ? (
              <li key={`ellipsis-${index}`} aria-hidden>
                <span
                  data-testid="pagination-ellipsis"
                  className="flex size-9 items-center justify-center"
                >
                  <MoreHorizontalIcon className="size-4" aria-hidden />
                  <span className="sr-only">More pages</span>
                </span>
              </li>
            ) : (
              <li key={item}>
                <button
                  type="button"
                  data-testid={`pagination-page-${item}`}
                  aria-label={`Go to page ${item}`}
                  aria-current={item === page ? 'page' : undefined}
                  onClick={() => onPageChange(item)}
                  className={cn(
                    buttonVariants({
                      variant: item === page ? 'outline' : 'ghost',
                      size: 'icon',
                    }),
                    item === page && 'font-semibold text-link'
                  )}
                >
                  {item}
                </button>
              </li>
            )
          )}
          <li>
            <button
              type="button"
              data-testid="pagination-next"
              aria-label="Go to next page"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'default' }),
                'gap-1 px-2.5'
              )}
            >
              <span className="hidden sm:block">Next</span>
              <ChevronRightIcon aria-hidden />
            </button>
          </li>
        </ul>
      </nav>
      <p
        data-testid="pagination-showing"
        className="text-metadata text-ink-sub"
      >
        Showing {start}–{end} of {total}
      </p>
    </div>
  );
}
