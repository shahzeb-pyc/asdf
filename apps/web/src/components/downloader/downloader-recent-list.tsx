'use client';

import * as React from 'react';
import type { MediaFolder } from '@fbuploadpro/contracts';
import { Button, Card, EmptyState } from '@/components/shared/ui';
import { DownloaderSavedItemRow } from './media-downloader-saved-item-row';
import type {
  DownloaderFailedEntry,
  DownloaderSavedEntry,
} from './downloader-data';

/**
 * Recent Downloads list (spec 140 PR-140-2, T14) — header counts,
 * failed links with Retry, saved rows, and the typed EmptyState for
 * the no-activity case (§3 items 9/10/12, copy verbatim).
 */
export function DownloaderRecentList({
  savedEntries,
  failedEntries,
  folders,
  retryingId,
  onRetry,
  onOpenInFolder,
}: Readonly<{
  savedEntries: DownloaderSavedEntry[];
  failedEntries: DownloaderFailedEntry[];
  folders: MediaFolder[];
  retryingId: string | null;
  onRetry: (entry: DownloaderFailedEntry) => void;
  onOpenInFolder: (folderId: string | null) => void;
}>) {
  const hasRecentActivity = savedEntries.length > 0 || failedEntries.length > 0;

  return (
    <section
      data-testid="downloader-recent-list"
      className="flex flex-col gap-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-ink">Recent Downloads</h2>
        {hasRecentActivity && (
          <span className="text-metadata tabular-nums text-ink-sub">
            {savedEntries.length} saved
            {failedEntries.length > 0
              ? ` · ${failedEntries.length} failed`
              : ''}
          </span>
        )}
      </div>

      {!hasRecentActivity ? (
        <Card className="gap-0 py-0">
          <EmptyState
            type="first-use"
            data-testid="downloader-empty-state"
            title="Nothing downloaded yet"
            description="Paste a link above and it will appear here, ready for your library."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {/* Failed Links (with Retry button) */}
          {failedEntries.map((entry) => {
            const isRetrying = retryingId === entry.id;
            return (
              <article
                key={entry.id}
                data-testid="downloader-failed-item"
                className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-signal-critical bg-panel p-4"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-body font-semibold text-ink">
                    {entry.url}
                  </span>
                  <span className="text-body text-signal-critical">
                    {entry.errorMessage}
                  </span>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="downloader-retry-btn"
                  disabled={isRetrying}
                  loading={isRetrying}
                  onClick={() => onRetry(entry)}
                >
                  {isRetrying ? 'Retrying...' : 'Retry'}
                </Button>
              </article>
            );
          })}

          {/* Saved Media Items */}
          {savedEntries.map((entry) => (
            <DownloaderSavedItemRow
              key={entry.item.id}
              entry={entry}
              folders={folders}
              onOpenInFolder={onOpenInFolder}
            />
          ))}
        </div>
      )}
    </section>
  );
}
