/**
 * Threads In-app Schedule detail loading — same geometry as the loaded
 * detail: header, tab bar, and content skeleton.
 */
import * as React from 'react';

import { Skeleton } from '@/components/shared/ui/skeleton';

export default function ThreadsScheduleDetailLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading scheduled account"
      className="flex flex-col gap-6"
    >
      <div className="flex items-center gap-4">
        <Skeleton className="size-11 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
      </div>
      <Skeleton className="h-11 w-full max-w-xl" />
      <Skeleton className="h-45 w-full rounded-md" />
    </div>
  );
}
