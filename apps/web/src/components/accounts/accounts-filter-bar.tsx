'use client';

/**
 * Accounts filter bar (spec 131 PR-131-1, spec §8.4 decomposition) —
 * extracted from the former accounts route and rebuilt on the
 * shared/ui primitives: the search field is the `Input` primitive
 * (44px touch height, 16px phone font per the mobile gate) with the
 * same ghost treatment, Escape-to-clear behaviour, and clear
 * affordance; the status filters stay plain typographic tabs with the
 * gold selection underline (Binance identity rationed to selection).
 * Testids, roles, and labels are preserved verbatim for parity.
 */
import * as React from 'react';
import { SearchIcon, XIcon } from 'lucide-react';

import { Input } from '@/components/shared/ui/input';
import { cn } from '@/lib/utils';

import type { AccountStatusFilter } from './accounts-helpers';

export interface AccountsFilterBarProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  statusFilter: AccountStatusFilter;
  onStatusFilterChange: (value: AccountStatusFilter) => void;
  attentionCount?: number | undefined;
  errorAttentionCount?: number | undefined;
}

// Audit UX2: the expiring-soon filter existed in the API but had
// no tab, and error accounts had no filter at all.
const FILTER_TABS: Array<{ value: AccountStatusFilter; label: string; testId: string }> = [
  { value: 'all', label: 'All', testId: 'accounts-filter-all' },
  { value: 'active', label: 'Active', testId: 'accounts-filter-active' },
  { value: 'expiring_soon', label: 'Expiring soon', testId: 'accounts-filter-expiring-soon' },
  { value: 'expired', label: 'Expired', testId: 'accounts-filter-expired' },
  { value: 'error', label: 'Error', testId: 'accounts-filter-error' },
];

export function AccountsFilterBar({
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  attentionCount = 0,
  errorAttentionCount = 0,
}: Readonly<AccountsFilterBarProps>) {
  return (
    <div
      data-testid="accounts-filter-bar"
      className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-4"
    >
      {/* Ghost Search Input with Inset Icon & Clear Affordance */}
      <div className="relative flex min-w-55 flex-1 items-center sm:max-w-80">
        <SearchIcon
          className="pointer-events-none absolute left-2.5 size-3.5 text-ink-dim"
          aria-hidden
        />
        <Input
          type="search"
          data-testid="accounts-search-input"
          placeholder="Search accounts..."
          aria-label="Search accounts"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              onSearchChange('');
            }
          }}
          className="border-line bg-transparent pr-11 pl-8 shadow-none"
        />
        {searchQuery && (
          <button
            type="button"
            aria-label="Clear search query"
            onClick={() => onSearchChange('')}
            className="absolute right-0 inline-flex size-11 items-center justify-center rounded-sm text-ink-dim outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-link"
          >
            <XIcon className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {/* Pure Typographic Flat Filter Tabs */}
      <div role="tablist" aria-label="Filter accounts by status" className="flex items-center gap-4">
        {FILTER_TABS.map((tab) => {
          const isActive = statusFilter === tab.value;
          const badgeCount =
            tab.value === 'expired'
              ? attentionCount
              : tab.value === 'error'
                ? errorAttentionCount
                : 0;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              data-testid={tab.testId}
              aria-selected={isActive}
              onClick={() => onStatusFilterChange(tab.value)}
              className={cn(
                '-mb-px inline-flex min-h-11 items-center gap-1 border-b-2 px-0 py-1 text-body outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link',
                isActive
                  ? 'border-link font-semibold text-ink'
                  : 'border-transparent font-medium text-ink-sub hover:text-ink'
              )}
            >
              <span>{tab.label}</span>
              {badgeCount > 0 && (
                <span className="text-metadata font-semibold text-signal-critical">
                  ({badgeCount})
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
