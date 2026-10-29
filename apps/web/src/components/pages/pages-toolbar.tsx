'use client';

/**
 * Pages scale toolbar (spec 131 PR-131-2, spec §8.4 decomposition) —
 * extracted from the former pages route and rebuilt on the shared/ui
 * primitives: the search field is the `Input` primitive (44px touch
 * height, 16px phone font per the mobile gate) with the same ghost
 * treatment, Escape-to-clear behaviour, and clear affordance; the
 * status filters stay plain typographic tabs with the gold selection
 * underline (Binance identity rationed to selection); the account
 * filter is the shared `Select` primitive. Testids, roles, and
 * labels are preserved verbatim for parity.
 */
import * as React from 'react';
import { SearchIcon, XIcon } from 'lucide-react';

import { Input } from '@/components/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shared/ui/select';
import { cn } from '@/lib/utils';

import type { PageStatusFilter } from './pages-helpers';

export interface PagesScaleToolbarProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  statusFilter: PageStatusFilter;
  onStatusFilterChange: (value: PageStatusFilter) => void;
  accountFilter: string;
  onAccountFilterChange: (value: string) => void;
  accountOptions: string[];
  attentionCount?: number | undefined;
}

const PAGE_FILTER_TABS: Array<{
  value: PageStatusFilter;
  label: string;
  testId: string;
}> = [
  { value: 'all', label: 'All', testId: 'pages-filter-all' },
  { value: 'active', label: 'Active', testId: 'pages-filter-active' },
  {
    value: 'needs_attention',
    label: 'Needs Attention',
    testId: 'pages-filter-needs-attention',
  },
  { value: 'paused', label: 'Paused', testId: 'pages-filter-paused' },
];

export function PagesScaleToolbar({
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  accountFilter,
  onAccountFilterChange,
  accountOptions,
  attentionCount = 0,
}: Readonly<PagesScaleToolbarProps>) {
  return (
    <div
      data-testid="pages-scale-toolbar"
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
          data-testid="pages-search-input"
          placeholder="Filter by name or category..."
          aria-label="Filter pages by name or category"
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

      {/* Pure Typographic Flat Filter Tabs & Account Selector */}
      <div className="flex flex-wrap items-center gap-6">
        <div
          role="tablist"
          aria-label="Filter pages by status"
          className="flex items-center gap-4"
        >
          {PAGE_FILTER_TABS.map((tab) => {
            const isActive = statusFilter === tab.value;
            const isAttention = tab.value === 'needs_attention';
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
                {isAttention && attentionCount > 0 && (
                  <span className="text-metadata font-semibold text-brand-rose">
                    ({attentionCount})
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Account Selector */}
        <Select value={accountFilter} onValueChange={onAccountFilterChange}>
          <SelectTrigger
            data-testid="pages-account-filter"
            aria-label="Filter pages by Facebook account"
            className="min-h-11"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All accounts</SelectItem>
            {accountOptions.map((accountName) => (
              <SelectItem key={accountName} value={accountName}>
                {accountName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
