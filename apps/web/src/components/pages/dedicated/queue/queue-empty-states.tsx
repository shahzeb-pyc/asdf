'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { PostingTimeQuickAdd } from '../composer/posting-time-quick-add';
import type { PageSlotSummary } from '../tab-dashboard';

export interface QueueEmptyStatesProps {
  pageId: string;
  subdomain: string;
  slots: PageSlotSummary[];
  onSlotsChanged: (slots: PageSlotSummary[]) => void;
  onBulkAdd: () => void;
  checklistDismissed: boolean;
  onDismissChecklist: () => void;
  /** Which typed empty state to render (spec 134 §3.1, UI Rule 23). */
  variant?: 'first-use' | 'no-results';
  /** Active filter label, echoed by the no-results state. */
  filterLabel?: string;
  onClearFilters?: () => void;
}

const checklistLinkClass =
  'text-left text-body font-medium text-link outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold';

/**
 * Queue empty states, typed by cause (spec 134 §3.1 / UI Rule 23):
 * - first-use: the dismissible getting-started checklist
 *   (spec 105 §11.1, preserved — dismissal is the panel's typed device
 *   preference) above "Nothing here yet." with Bulk add.
 *   With no posting slots loaded yet the checklist's first step is the
 *   setup path: it explains slots and offers Add posting time inline.
 * - no-results: echoes the active filter with one Clear filters action.
 */
export function QueueEmptyStates({
  pageId,
  subdomain,
  slots,
  onSlotsChanged,
  onBulkAdd,
  checklistDismissed,
  onDismissChecklist,
  variant = 'first-use',
  filterLabel,
  onClearFilters,
}: Readonly<QueueEmptyStatesProps>) {
  const [showQuickAdd, setShowQuickAdd] = React.useState(false);

  if (variant === 'no-results') {
    return (
      <div data-testid="queue-empty-state">
        <EmptyState
          type="no-results"
          title="Nothing here."
          description="No posts match this filter."
          {...(filterLabel ? { activeFilters: [filterLabel] } : {})}
          action={
            <Button variant="secondary" onClick={onClearFilters}>
              Clear filters
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div data-testid="queue-empty-state" className="flex flex-col gap-6">
      {!checklistDismissed && (
        <div aria-label="Getting started checklist" className="border-b border-line py-4">
          <div className="mb-2 flex items-center justify-between gap-4">
            <h3 className="m-0 text-body font-semibold text-ink">Get your queue running</h3>
            <Button variant="link" size="sm" onClick={onDismissChecklist}>
              Dismiss
            </Button>
          </div>
          {slots.length === 0 && (
            <p className="m-0 mb-2 text-body text-ink-sub">
              This page has no posting times yet — add one so queued posts know when to go out.
            </p>
          )}
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            <li className="flex items-center gap-2">
              <span className="text-body text-ink-sub">1.</span>
              <button
                type="button"
                onClick={() => setShowQuickAdd((prev) => !prev)}
                className={checklistLinkClass}
                aria-expanded={showQuickAdd}
              >
                Set posting times
              </button>
              {slots.length > 0 && (
                <span className="text-metadata text-ink-sub">({slots.length} set)</span>
              )}
            </li>
            {showQuickAdd && (
              <li className="pl-6">
                <PostingTimeQuickAdd
                  pageId={pageId}
                  subdomain={subdomain}
                  onAdded={(slot) => {
                    onSlotsChanged([...slots, slot]);
                    setShowQuickAdd(false);
                  }}
                />
              </li>
            )}
            <li className="flex items-center gap-2">
              <span className="text-body text-ink-sub">2.</span>
              <Link href={`/tenant/${subdomain}/media`} className={checklistLinkClass}>
                Add media
              </Link>
            </li>
          </ol>
        </div>
      )}

      <EmptyState
        type="first-use"
        title="Nothing here yet."
        description="Bulk-add media to fill your queue."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="secondary" onClick={onBulkAdd}>
              Bulk add
            </Button>
          </div>
        }
      />
    </div>
  );
}
