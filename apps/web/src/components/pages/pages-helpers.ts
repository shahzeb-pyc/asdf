/**
 * Pages list — pure helpers (spec 131 PR-131-2, spec §8.4 decomposition).
 *
 * Extracted verbatim from the former 844-line pages route: the
 * attention-first sorting, the search/status/account filtering, and
 * the situational subtitle computation. Names and behaviour are
 * preserved exactly — the parity suites (tests/ui/pages.test.tsx)
 * import them from here, and the Pages shell consumes the same
 * functions, so ordering, filtering, and subtitle copy can never
 * drift between the route and its tests.
 */
import * as React from 'react';

import {
  isPageNeedsAttention,
  type FacebookPageItem,
} from '@/components/pages/page-card';

export type PageStatusFilter = 'all' | 'active' | 'needs_attention' | 'paused';

function getStatusSortRank(status: FacebookPageItem['status']): number {
  if (isPageNeedsAttention(status)) return 0;
  if (status === 'paused') return 1;
  if (status === 'active') return 2;
  return 3;
}

export function sortPagesAttentionFirst(
  items: FacebookPageItem[]
): FacebookPageItem[] {
  return [...items].sort((a, b) => {
    const rankDiff = getStatusSortRank(a.status) - getStatusSortRank(b.status);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    const aTime = Date.parse(a.createdAt) || 0;
    const bTime = Date.parse(b.createdAt) || 0;
    return bTime - aTime;
  });
}

export function filterPagesList(
  items: FacebookPageItem[],
  searchQuery: string,
  statusFilter: PageStatusFilter = 'all',
  accountFilter = 'all'
): FacebookPageItem[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  return items.filter((page) => {
    const matchesSearch =
      normalizedQuery.length === 0 ||
      page.pageName.toLowerCase().includes(normalizedQuery) ||
      (page.category ?? '').toLowerCase().includes(normalizedQuery);

    let matchesStatus = true;
    if (statusFilter === 'active') {
      matchesStatus = page.status === 'active';
    } else if (statusFilter === 'needs_attention') {
      matchesStatus = isPageNeedsAttention(page.status);
    } else if (statusFilter === 'paused') {
      matchesStatus = page.status === 'paused';
    }

    const matchesAccount =
      !accountFilter ||
      accountFilter === 'all' ||
      page.accountDisplayName === accountFilter ||
      page.facebookAccountId === accountFilter;

    return matchesSearch && matchesStatus && matchesAccount;
  });
}

export function computeSituationalSubtitle(
  totalCount: number,
  filteredCount: number,
  attentionCount: number,
  isFiltered: boolean
): React.ReactNode {
  if (totalCount === 0) {
    return 'Connect your first Facebook Page to start managing content and tracking follower growth.';
  }
  if (isFiltered) {
    return `Showing ${filteredCount} of ${totalCount} ${
      totalCount === 1 ? 'page' : 'pages'
    }`;
  }
  if (attentionCount > 0) {
    return React.createElement(
      'span',
      null,
      `${totalCount} connected ${totalCount === 1 ? 'page' : 'pages'} · `,
      React.createElement(
        'span',
        { className: 'font-medium text-signal-critical' },
        `${attentionCount} ${attentionCount === 1 ? 'requires' : 'require'} reconnecting`
      )
    );
  }
  return `${totalCount} connected ${totalCount === 1 ? 'page' : 'pages'}`;
}
