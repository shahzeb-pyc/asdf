/**
 * Threads In-app Schedule list loading — same geometry as the loaded
 * list: header + subtitle, Add button, filter bar, and card grid.
 */
import * as React from 'react';

import { Skeleton } from '@/components/shared/ui/skeleton';

export default function ThreadsScheduleLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading scheduled accounts"
      className="mx-auto flex w-full max-w-300 flex-col px-6 py-6"
    >
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-11 w-40" />
      </div>
      <Skeleton className="mb-6 h-11 w-full max-w-80" />
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
        <Skeleton className="h-45 w-full rounded-md" />
        <Skeleton className="h-45 w-full rounded-md" />
        <Skeleton className="h-45 w-full rounded-md" />
      </div>
    </div>
  );
}
