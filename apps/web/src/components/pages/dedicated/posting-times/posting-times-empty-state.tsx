'use client';

/**
 * Posting-times empty state (spec 134 §3.3): the typed first-use
 * EmptyState (UI Rule 23) — what posting times do, plus the view's one
 * primary action. Copy preserved from the legacy surface (spec §5.1).
 */
import * as React from 'react';
import { ClockIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';

export interface PostingTimesEmptyStateProps {
  onOpenAddModal: () => void;
}

export function PostingTimesEmptyState({ onOpenAddModal }: Readonly<PostingTimesEmptyStateProps>) {
  return (
    <div data-testid="calendar-empty-state">
      <EmptyState
        type="first-use"
        icon={<ClockIcon aria-hidden className="size-8 text-brand-gold" />}
        title="No daily posting times set yet"
        description="Set up your daily posting times and choose which post types go out in each. Posts added to your queue go out automatically at these times."
        action={
          <Button type="button" data-testid="empty-add-slot-button" onClick={onOpenAddModal}>
            Add First Posting Time
          </Button>
        }
      />
    </div>
  );
}
