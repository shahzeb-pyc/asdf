'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { DownloadJob } from '@fbuploadpro/contracts';
import { Button } from '@/components/shared/ui/button';
import { Progress } from '@/components/shared/ui/progress';
import { buildTenantHref } from '@/lib/tenant-href';
import {
  isDownloadJobActive,
  useCancelDownloadJob,
  useDownloadJobs,
  useRetryDownloadJob,
} from '@/components/media/download-jobs-data';
import { invalidateMediaList } from '@/components/media/media-data';
import { useQueryClient } from '@tanstack/react-query';

/**
 * App-wide download tray (spec 149, Google-Drive style). Mounted once
 * in the tenant layout, so it survives navigation between sections.
 *
 * - Slides in bottom-right on desktop, full-width bottom sheet on
 *   phones. Nothing in the main section, nothing in the header.
 * - While downloads run there is NO full-close, only minimize to a
 *   pill; the pill re-expands. Tapping outside never closes it — it
 *   is not a modal, there is no overlay.
 * - After everything resolves: success shows briefly then slides away
 *   on its own; failures stay with plain reason + Retry until
 *   dismissed. A second batch appends to the same tray.
 * - State comes only from the jobs endpoint: refresh restores it, and
 *   closing the site changes nothing (the worker keeps going).
 */

const SUCCESS_FLASH_MS = 4000;

const ERROR_MESSAGES: Record<string, string> = {
  UNSAFE_URL: 'This link is not a public link.',
  UNSUPPORTED_MEDIA: 'No video or image was found at this link.',
  FILE_TOO_LARGE: 'This file is over 500 MB.',
  DOWNLOAD_FAILED: 'Download failed. Try again.',
};

function displayNameForJob(job: DownloadJob): string {
  try {
    const url = new URL(job.sourceUrl);
    const label = `${url.hostname}${url.pathname}`;
    return label.length > 42 ? `${label.slice(0, 41)}…` : label;
  } catch {
    return job.sourceUrl.length > 42 ? `${job.sourceUrl.slice(0, 41)}…` : job.sourceUrl;
  }
}

function reasonForJob(job: DownloadJob): string {
  if (job.errorMessage) return job.errorMessage;
  if (job.errorCode && ERROR_MESSAGES[job.errorCode]) {
    return ERROR_MESSAGES[job.errorCode] as string;
  }
  return 'Download failed. Try again.';
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function trayTitle(
  successFlash: boolean,
  activeJobs: DownloadJob[],
  failedJobs: DownloadJob[]
): string {
  if (successFlash) return '✓ Downloaded';
  if (activeJobs.length > 0) {
    const noun = activeJobs.length === 1 ? 'file' : 'files';
    return `⬇ Downloading ${activeJobs.length} ${noun}`;
  }
  const noun = failedJobs.length === 1 ? 'download' : 'downloads';
  return `${failedJobs.length} ${noun} failed`;
}

interface TrayStateAdjustmentArgs {
  activeCount: number;
  failedCount: number;
  dismissed: boolean;
  successFlash: boolean;
  prevActiveCount: number;
  setDismissed: (value: boolean) => void;
  setMinimized: (value: boolean) => void;
  setSuccessFlash: (value: boolean) => void;
  setPrevActiveCount: (value: number) => void;
}

// Work finished cleanly: nothing active or failed, after having had
// active work, and the user did not dismiss the tray meanwhile.
function finishedCleanly(args: TrayStateAdjustmentArgs): boolean {
  return (
    args.activeCount === 0 &&
    args.failedCount === 0 &&
    args.prevActiveCount > 0 &&
    !args.dismissed
  );
}

// Render-phase adjustments (the documented React pattern for
// deriving state from new data — not effects), factored out of the
// component so its own complexity stays readable: new activity
// re-opens the tray expanded; work finishing cleanly flashes
// success; the flash and the tray never linger past new work.
function applyTrayStateAdjustments(args: TrayStateAdjustmentArgs): void {
  const hasOpenJobs = args.activeCount > 0 || args.failedCount > 0;
  if (hasOpenJobs && args.dismissed) {
    args.setDismissed(false);
    args.setMinimized(false);
    args.setSuccessFlash(false);
  }
  if (hasOpenJobs && args.successFlash) {
    args.setSuccessFlash(false);
  }
  if (args.prevActiveCount !== args.activeCount) {
    if (finishedCleanly(args)) {
      args.setSuccessFlash(true);
    }
    args.setPrevActiveCount(args.activeCount);
  }
}

function shouldShowTray(
  dismissed: boolean,
  activeCount: number,
  failedCount: number,
  successFlash: boolean
): boolean {
  return !dismissed && (activeCount > 0 || failedCount > 0 || successFlash);
}

interface TrayHeaderProps {
  successFlash: boolean;
  activeJobs: DownloadJob[];
  failedJobs: DownloadJob[];
  onMinimize: () => void;
  onDismiss: () => void;
}

function TrayHeader({ successFlash, activeJobs, failedJobs, onMinimize, onDismiss }: Readonly<TrayHeaderProps>) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <h2 className="flex-1 text-body font-semibold text-ink">
        {trayTitle(successFlash, activeJobs, failedJobs)}
      </h2>
      <Button
        type="button"
        variant="ghost"
        data-testid="download-tray-minimize"
        onClick={onMinimize}
        className="h-8 px-2"
        aria-label="Minimize downloads"
      >
        –
      </Button>
      {activeJobs.length === 0 && (
        <Button
          type="button"
          variant="ghost"
          data-testid="download-tray-dismiss"
          onClick={onDismiss}
          className="h-8 px-2"
          aria-label="Dismiss downloads"
        >
          ×
        </Button>
      )}
    </div>
  );
}

function TrayPausedBanner({
  consumerHealthy,
  activeCount,
}: Readonly<{ consumerHealthy: boolean | undefined; activeCount: number }>) {
  if (consumerHealthy !== false || activeCount === 0) return null;
  return (
    <p data-testid="download-tray-paused" className="mb-2 text-metadata text-signal-critical">
      Downloads are paused — the download service isn&apos;t responding.
    </p>
  );
}

interface TrayFooterProps {
  activeCount: number;
  libraryHref: string;
  onCancelAll: () => void;
}

function TrayFooter({ activeCount, libraryHref, onCancelAll }: Readonly<TrayFooterProps>) {
  return (
    <div className="mt-3 flex items-center gap-2">
      {activeCount > 0 && (
        <Button
          type="button"
          variant="ghost"
          data-testid="download-tray-cancel-all"
          onClick={onCancelAll}
          className="h-8 px-2"
        >
          Cancel all
        </Button>
      )}
      <Link
        href={libraryHref}
        data-testid="download-tray-view-library"
        className="ml-auto text-body font-medium text-link underline-offset-4 hover:underline"
      >
        View in library
      </Link>
    </div>
  );
}

interface DownloadJobRowProps {
  job: DownloadJob;
  onRetry: (jobId: string) => void;
  onCancel: (job: DownloadJob) => void;
}

function DownloadJobRow({ job, onRetry, onCancel }: Readonly<DownloadJobRowProps>) {
  return (
    <div data-testid={`download-job-row-${job.id}`} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body text-ink">
          {displayNameForJob(job)}
        </span>
        {job.status === 'failed' ? (
          <Button
            type="button"
            data-testid={`download-job-retry-${job.id}`}
            onClick={() => onRetry(job.id)}
            className="h-8 shrink-0"
          >
            Retry
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            data-testid={`download-job-cancel-${job.id}`}
            onClick={() => onCancel(job)}
            className="h-8 shrink-0 px-2"
          >
            Cancel
          </Button>
        )}
      </div>
      {job.status === 'failed' ? (
        <p className="text-metadata text-signal-critical">
          <span aria-hidden>✕ </span>
          {reasonForJob(job)}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <Progress
            value={job.progressPercent}
            aria-label={`Download progress for ${displayNameForJob(job)}`}
            className="flex-1"
          />
          <span className="w-20 shrink-0 text-right text-metadata tabular-nums text-ink-sub">
            {job.status === 'queued' && 'Queued'}
            {job.status === 'resolving' && 'Resolving…'}
            {job.status === 'downloading' &&
              (job.totalBytes
                ? `${job.progressPercent}%`
                : `${formatMegabytes(job.downloadedBytes)} downloaded`)}
          </span>
        </div>
      )}
    </div>
  );
}

interface TrayPillProps {
  failedCount: number;
  aggregatePercent: number;
  onExpand: () => void;
}

// New files in the grid: a job id that disappears from the open
// list without being user-cancelled finished, so the media list
// refetches. (Cancelled ids are recorded by the cancel handlers and
// skipped here; a spurious refetch is harmless either way.)
function trackFinishedJobs(
  jobs: DownloadJob[],
  prevOpen: { current: Map<string, DownloadJob> },
  userCancelled: { current: Set<string> },
  lastCompletedFolder: { current: string | null },
  queryClient: ReturnType<typeof useQueryClient>,
  subdomain: string
): void {
  const current = new Map(jobs.map((job) => [job.id, job]));
  let finished = false;
  for (const [id, prevJob] of prevOpen.current) {
    if (!current.has(id) && !userCancelled.current.has(id)) {
      finished = true;
      lastCompletedFolder.current = prevJob.targetFolderId;
    }
  }
  prevOpen.current = current;
  if (finished) {
    void invalidateMediaList(queryClient, subdomain);
  }
}

function TrayPill({ failedCount, aggregatePercent, onExpand }: Readonly<TrayPillProps>) {
  return (
    <button
      type="button"
      data-testid="download-tray-pill"
      onClick={onExpand}
      className="fixed right-4 bottom-4 z-dialog rounded-full bg-primary px-4 py-2 text-metadata font-semibold text-on-primary shadow-modal"
    >
      {failedCount > 0 ? (
        <span className="text-brand-rose">
          {failedCount} failed — tap to view
        </span>
      ) : (
        <span>⬇ {aggregatePercent}%</span>
      )}
    </button>
  );
}

export interface DownloadTrayProps {
  subdomain: string;
  useCleanPaths?: boolean;
}

export function DownloadTray({ subdomain, useCleanPaths = false }: Readonly<DownloadTrayProps>) {
  const { data: jobsData } = useDownloadJobs(subdomain);
  const jobs = jobsData?.jobs ?? [];
  // Consumer health (§7.1): only an explicit false shows the paused
  // state — a missing value means unknown, never paused.
  const consumerHealthy = jobsData?.consumerHealthy;
  const retryJob = useRetryDownloadJob(subdomain);
  const cancelJob = useCancelDownloadJob(subdomain);
  const queryClient = useQueryClient();

  const [minimized, setMinimized] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [successFlash, setSuccessFlash] = useState(false);
  const [prevActiveCount, setPrevActiveCount] = useState(0);

  const activeJobs = jobs.filter(isDownloadJobActive);
  const failedJobs = jobs.filter((job) => job.status === 'failed');

  applyTrayStateAdjustments({
    activeCount: activeJobs.length,
    failedCount: failedJobs.length,
    dismissed,
    successFlash,
    prevActiveCount,
    setDismissed,
    setMinimized,
    setSuccessFlash,
    setPrevActiveCount,
  });

  // The success flash hides itself (deferred timer, the same shape as
  // the library's debounce timer — never a synchronous state sync).
  useEffect(() => {
    if (!successFlash) return undefined;
    const timer = setTimeout(() => {
      setSuccessFlash(false);
      setDismissed(true);
    }, SUCCESS_FLASH_MS);
    return () => clearTimeout(timer);
  }, [successFlash]);

  const prevOpenIdsRef = useRef<Map<string, DownloadJob>>(new Map());
  const userCancelledIdsRef = useRef<Set<string>>(new Set());
  const lastCompletedFolderRef = useRef<string | null>(null);
  useEffect(() => {
    trackFinishedJobs(
      jobs,
      prevOpenIdsRef,
      userCancelledIdsRef,
      lastCompletedFolderRef,
      queryClient,
      subdomain
    );
  }, [jobs, queryClient, subdomain]);

  const showTray = shouldShowTray(dismissed, activeJobs.length, failedJobs.length, successFlash);
  if (!showTray) {
    return null;
  }

  const libraryHref = buildTenantHref(
    subdomain,
    lastCompletedFolderRef.current
      ? `/media?folder=${encodeURIComponent(lastCompletedFolderRef.current)}`
      : '/media',
    useCleanPaths
  );

  const aggregatePercent =
    activeJobs.length > 0
      ? Math.round(
          activeJobs.reduce((sum, job) => sum + job.progressPercent, 0) / activeJobs.length
        )
      : 0;

  const handleCancelAll = async (): Promise<void> => {
    await Promise.allSettled(activeJobs.map((job) => cancelJob.mutateAsync(job.id)));
  };

  const handleCancelOne = (job: DownloadJob): void => {
    userCancelledIdsRef.current.add(job.id);
    cancelJob.mutate(job.id);
  };

  if (minimized) {
    return (
      <TrayPill
        failedCount={failedJobs.length}
        aggregatePercent={aggregatePercent}
        onExpand={() => setMinimized(false)}
      />
    );
  }

  return (
    <section
      data-testid="download-tray"
      aria-label="Downloads"
      className="fixed right-4 bottom-4 z-dialog w-80 rounded-md border border-line bg-panel p-4 shadow-modal max-sm:inset-x-0 max-sm:bottom-0 max-sm:w-auto max-sm:rounded-t-md max-sm:rounded-b-none"
    >
      {/* Drag handle (mobile sheet affordance; minimize is the – button). */}
      <div aria-hidden className="mx-auto mb-2 hidden h-1 w-10 rounded-full bg-line max-sm:block" />

      <TrayHeader
        successFlash={successFlash}
        activeJobs={activeJobs}
        failedJobs={failedJobs}
        onMinimize={() => setMinimized(true)}
        onDismiss={() => {
          setDismissed(true);
          setSuccessFlash(false);
        }}
      />

      <TrayPausedBanner consumerHealthy={consumerHealthy} activeCount={activeJobs.length} />

      {successFlash ? (
        <p className="text-metadata text-ink-sub">
          New files are in the grid. Nothing is kept as history.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {jobs.map((job) => (
            <DownloadJobRow
              key={job.id}
              job={job}
              onRetry={(jobId) => retryJob.mutate(jobId)}
              onCancel={handleCancelOne}
            />
          ))}
        </div>
      )}

      <TrayFooter
        activeCount={activeJobs.length}
        libraryHref={libraryHref}
        onCancelAll={handleCancelAll}
      />
    </section>
  );
}
