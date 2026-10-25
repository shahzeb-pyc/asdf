'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { DownloadJob } from '@fbuploadpro/contracts';
import { Button } from '@/components/shared/ui/button';
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

export interface DownloadTrayProps {
  subdomain: string;
  useCleanPaths?: boolean;
}

export function DownloadTray({ subdomain, useCleanPaths = false }: Readonly<DownloadTrayProps>) {
  const { data: jobsData } = useDownloadJobs(subdomain);
  const jobs = jobsData ?? [];
  const retryJob = useRetryDownloadJob(subdomain);
  const cancelJob = useCancelDownloadJob(subdomain);
  const queryClient = useQueryClient();

  const [minimized, setMinimized] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [successFlash, setSuccessFlash] = useState(false);
  const [prevActiveCount, setPrevActiveCount] = useState(0);

  const activeJobs = jobs.filter(isDownloadJobActive);
  const failedJobs = jobs.filter((job) => job.status === 'failed');

  // Render-phase adjustments (the documented React pattern for
  // deriving state from new data — not effects): new activity
  // re-opens the tray expanded; work finishing cleanly flashes
  // success; the flash and the tray never linger past new work.
  if ((activeJobs.length > 0 || failedJobs.length > 0) && dismissed) {
    setDismissed(false);
    setMinimized(false);
    setSuccessFlash(false);
  }
  if ((activeJobs.length > 0 || failedJobs.length > 0) && successFlash) {
    setSuccessFlash(false);
  }
  if (prevActiveCount !== activeJobs.length) {
    if (
      activeJobs.length === 0 &&
      failedJobs.length === 0 &&
      prevActiveCount > 0 &&
      !dismissed
    ) {
      setSuccessFlash(true);
    }
    setPrevActiveCount(activeJobs.length);
  }

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

  // New files in the grid: a job id that disappears from the open
  // list without being user-cancelled finished, so the media list
  // refetches. (Cancelled ids are recorded by the cancel handlers and
  // skipped here; a spurious refetch is harmless either way.)
  const prevOpenIdsRef = useRef<Map<string, DownloadJob>>(new Map());
  const userCancelledIdsRef = useRef<Set<string>>(new Set());
  const lastCompletedFolderRef = useRef<string | null>(null);
  useEffect(() => {
    const current = new Map(jobs.map((job) => [job.id, job]));
    let finished = false;
    for (const [id, prevJob] of prevOpenIdsRef.current) {
      if (!current.has(id) && !userCancelledIdsRef.current.has(id)) {
        finished = true;
        lastCompletedFolderRef.current = prevJob.targetFolderId;
      }
    }
    prevOpenIdsRef.current = current;
    if (finished) {
      void invalidateMediaList(queryClient, subdomain);
    }
  }, [jobs, queryClient, subdomain]);

  const showTray = !dismissed && (activeJobs.length > 0 || failedJobs.length > 0 || successFlash);
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
      <button
        type="button"
        data-testid="download-tray-pill"
        onClick={() => setMinimized(false)}
        className="fixed right-4 bottom-4 z-dialog rounded-full bg-primary px-4 py-2 text-metadata font-semibold text-on-primary shadow-modal"
      >
        {failedJobs.length > 0 ? (
          <span className="text-brand-rose">
            {failedJobs.length} failed — tap to view
          </span>
        ) : (
          <span>⬇ {aggregatePercent}%</span>
        )}
      </button>
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

      <div className="mb-2 flex items-center gap-2">
        <h2 className="flex-1 text-body font-semibold text-ink">
          {successFlash
            ? '✓ Downloaded'
            : activeJobs.length > 0
              ? `⬇ Downloading ${activeJobs.length} ${activeJobs.length === 1 ? 'file' : 'files'}`
              : `${failedJobs.length} ${failedJobs.length === 1 ? 'download' : 'downloads'} failed`}
        </h2>
        <Button
          type="button"
          variant="ghost"
          data-testid="download-tray-minimize"
          onClick={() => setMinimized(true)}
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
            onClick={() => {
              setDismissed(true);
              setSuccessFlash(false);
            }}
            className="h-8 px-2"
            aria-label="Dismiss downloads"
          >
            ×
          </Button>
        )}
      </div>

      {successFlash ? (
        <p className="text-metadata text-ink-sub">
          New files are in the grid. Nothing is kept as history.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {jobs.map((job) => (
            <div key={job.id} data-testid={`download-job-row-${job.id}`} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-body text-ink">
                  {displayNameForJob(job)}
                </span>
                {job.status === 'failed' ? (
                  <Button
                    type="button"
                    data-testid={`download-job-retry-${job.id}`}
                    onClick={() => retryJob.mutate(job.id)}
                    className="h-8 shrink-0"
                  >
                    Retry
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    data-testid={`download-job-cancel-${job.id}`}
                    onClick={() => handleCancelOne(job)}
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
                  <div
                    role="progressbar"
                    aria-valuenow={job.totalBytes ? job.progressPercent : undefined}
                    aria-label={`Download progress for ${displayNameForJob(job)}`}
                    className="h-2 flex-1 overflow-hidden rounded-full bg-line"
                  >
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${job.progressPercent}%` }}
                    />
                  </div>
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
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        {activeJobs.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            data-testid="download-tray-cancel-all"
            onClick={handleCancelAll}
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
    </section>
  );
}
