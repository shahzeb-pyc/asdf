'use client';

/**
 * Dedicated Page dashboard tab (spec 131 PR-131-3) — clean-room rebuild
 * on shared/ui primitives + tokens. Presentational only, exactly as
 * before: the frame owns the data (React Query cache) and passes the
 * queue/slot summaries in; this tab holds no fetch and no data mirror.
 * Legacy file was read for behavioural facts and copy only.
 *
 * Status presentation is colour + icon + text throughout (OD-3 /
 * UX Rule 27); every scheduled time carries its timezone label where
 * the legacy tab showed one (posting-time pills, UI Rule 6).
 */

import * as React from 'react';
import { CalendarClockIcon, ClockIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { StatusDot } from '@/components/shared/ui/status-dot';
import { Tag } from '@/components/shared/ui/tag';
import type { FacebookPageItem } from '../page-card';
import { getPageStatusLabel } from '../page-card';
import type { PostFormat } from '@fbuploadpro/contracts';
import { formatSlotDisplay } from './posting-times/posting-time-utils';

export interface PageQueueItemSummary {
  id: string;
  mediaId?: string | null;
  mediaType?: 'video' | 'image';
  postFormat?: PostFormat;
  linkUrl?: string | null;
  caption?: string | null;
  firstComment?: string | null;
  /** Legacy stored time, if any (published rows, other platforms). */
  scheduledTime: string | null;
  /**
   * Derived estimate for queued posts: queue position + current
   * active posting times. Null when no active time allows the post's
   * format — it waits (with the unmatched warning) until one does.
   * Estimates move when times change; that is intended.
   */
  estimatedTime?: string | null;
  status: 'queued' | 'publishing' | 'published' | 'failed' | 'skipped' | 'cancelled';
  thumbnailUrl?: string | null;
}

export interface PageSlotSummary {
  id: string;
  slotTime: string;
  timezone: string;
  isActive: boolean;
  allowedFormats?: string[] | null;
}

export interface PageTabDashboardProps {
  page: FacebookPageItem;
  queueItems: PageQueueItemSummary[];
  slots: PageSlotSummary[];
  onPublishNow: (itemId: string) => Promise<void>;
  onSwitchTab: (tab: 'queue' | 'calendar' | 'insights') => void;
}

function formatItemBadge(item: PageQueueItemSummary): string {
  const fmt = item.postFormat || (item.mediaType === 'video' ? 'video' : 'image');
  return fmt === 'image' ? 'PHOTO' : fmt.toUpperCase();
}

const cardClass = 'rounded-md border border-line bg-panel p-6 shadow-card';
const metricLabelClass = 'text-body text-ink-sub';
const metricValueClass = 'text-xxl font-bold text-ink';

export function PageTabDashboard({
  page,
  queueItems,
  slots,
  onPublishNow,
  onSwitchTab,
}: Readonly<PageTabDashboardProps>) {
  const [publishingId, setPublishingId] = React.useState<string | null>(null);

  const activeQueuedItems = queueItems.filter((i) => i.status === 'queued');
  // Next publication = the first queued post that actually has an
  // estimated time (an unmatched post at the head of the queue waits
  // and must not mask the post behind it that does have a time).
  const nextItem = activeQueuedItems.find((i) => i.estimatedTime) ?? null;
  const upcomingSlice = activeQueuedItems.slice(0, 3);
  const activeSlots = slots.filter((s) => s.isActive);

  const handlePublishClick = async (itemId: string) => {
    setPublishingId(itemId);
    try {
      await onPublishNow(itemId);
    } finally {
      setPublishingId(null);
    }
  };

  const isPaused = page.status === 'paused';
  const isDisconnected = page.status === 'disconnected';
  // Status family 2A/4A: Publish Now is only publishable on an
  // active page. On any other status the button is disabled with a
  // plain status reason (title + aria-label), never hidden and
  // never a fake success — the server gate enforces the same rule.
  const isPublishable = page.status === 'active';
  const publishBlockedReason = isPublishable
    ? null
    : `Publish now unavailable — page is ${getPageStatusLabel(page.status)}`;
  const delta = page.followersGained ?? 0;

  return (
    <div data-testid="page-tab-dashboard" className="flex flex-col gap-6">
      {/* 4 overview metric cards */}
      <div
        data-testid="dashboard-metrics-grid"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <div data-testid="metric-followers" className={cardClass}>
          <span className={metricLabelClass}>Total Followers</span>
          <div className="mt-1 flex items-baseline gap-2">
            <span className={metricValueClass}>
              {page.currentFollowers?.toLocaleString() ?? 0}
            </span>
            {delta !== 0 && (
              <span
                className={
                  delta > 0
                    ? 'text-body font-semibold text-signal-operational'
                    : 'text-body font-semibold text-signal-critical'
                }
              >
                {delta > 0 ? `+${delta}` : delta}
              </span>
            )}
          </div>
        </div>

        <div data-testid="metric-queued-count" className={cardClass}>
          <span className={metricLabelClass}>Queued Content</span>
          <div className="mt-1">
            <span className={metricValueClass}>{activeQueuedItems.length}</span>
            <span className="ml-1.5 text-body text-ink-dim">posts in queue</span>
          </div>
        </div>

        <div data-testid="metric-next-post" className={cardClass}>
          <span className={metricLabelClass}>Next Publication</span>
          <div className="mt-1">
            <span className={nextItem ? 'text-lg font-semibold text-ink' : 'text-body font-semibold text-ink'}>
              {nextItem?.estimatedTime
                ? new Date(nextItem.estimatedTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : activeQueuedItems.length > 0
                  ? 'Waiting for a posting time'
                  : 'No posts in queue'}
            </span>
            {nextItem?.estimatedTime && (
              <span className="block text-xs text-ink-dim">
                {new Date(nextItem.estimatedTime).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              </span>
            )}
          </div>
        </div>

        <div data-testid="metric-automation-status" className={cardClass}>
          <span className={metricLabelClass}>Auto-publishing</span>
          <div className="mt-1">
            <StatusDot
              status={
                isDisconnected ? 'critical' : isPaused ? 'queued' : 'operational'
              }
              label={
                isDisconnected ? 'Disconnected' : isPaused ? 'Paused' : 'Running'
              }
              className="text-lg font-semibold"
            />
          </div>
        </div>
      </div>

      {/* Upcoming queue vs active slots */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div data-testid="dashboard-upcoming-queue" className={`${cardClass} flex flex-col p-6`}>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="m-0 text-lg font-bold text-ink">Upcoming Queue</h2>
            {activeQueuedItems.length > 0 && (
              <Button
                type="button"
                variant="link"
                data-testid="view-full-queue-btn"
                onClick={() => onSwitchTab('queue')}
                className="h-11 px-1"
              >
                View full queue →
              </Button>
            )}
          </div>

          {upcomingSlice.length === 0 ? (
            <EmptyState
              type="first-use"
              data-testid="dashboard-queue-empty"
              title="Nothing scheduled yet."
              icon={<CalendarClockIcon aria-hidden />}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {upcomingSlice.map((item) => (
                <div
                  key={item.id}
                  data-testid="dashboard-queue-item-card"
                  className="flex items-center justify-between gap-4 rounded-sm border border-line bg-subtle p-4"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <Tag data-testid={`dashboard-item-format-${item.id}`}>
                        {formatItemBadge(item)}
                      </Tag>
                      <p className="m-0 min-w-0 flex-1 truncate text-body font-medium text-ink">
                        {item.caption || 'Untitled post'}
                      </p>
                    </div>
                    <span className="text-xs text-ink-dim">
                      {item.estimatedTime
                        ? `Expected ${new Date(item.estimatedTime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`
                        : 'Waiting for a matching posting time'}
                    </span>
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`publish-now-btn-${item.id}`}
                    disabled={publishingId === item.id || !isPublishable}
                    title={publishBlockedReason ?? undefined}
                    aria-label={publishBlockedReason ?? undefined}
                    onClick={() => void handlePublishClick(item.id)}
                    className="shrink-0"
                  >
                    {publishingId === item.id ? 'Publishing...' : 'Publish Now'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div data-testid="dashboard-active-slots" className={`${cardClass} flex flex-col p-6`}>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="m-0 text-lg font-bold text-ink">Daily Posting Times</h2>
            <Button
              type="button"
              variant="link"
              data-testid="view-full-schedule-btn"
              onClick={() => onSwitchTab('calendar')}
              className="h-11 px-1"
            >
              Manage times →
            </Button>
          </div>

          {activeSlots.length === 0 ? (
            <EmptyState
              type="first-use"
              title="No active daily posting times defined yet."
              action={
                <Button
                  type="button"
                  variant="secondary"
                  data-testid="dashboard-setup-schedule-btn"
                  onClick={() => onSwitchTab('calendar')}
                >
                  Set Posting Times
                </Button>
              }
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              {activeSlots.map((slot) => {
                const formatted = formatSlotDisplay(slot.slotTime);
                return (
                  <div
                    key={slot.id}
                    data-testid="dashboard-slot-pill"
                    className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-subtle px-4 py-1 text-body font-medium text-ink"
                  >
                    <ClockIcon className="size-3" aria-hidden />
                    <span>
                      {formatted.time12} {formatted.ampm}
                    </span>
                    <span className="text-xs text-ink-dim">{slot.timezone}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
