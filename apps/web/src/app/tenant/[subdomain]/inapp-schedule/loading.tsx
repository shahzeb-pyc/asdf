/**
 * Pages list loading (spec 137 §3.3.3 / PR-A2) — refined to the
 * rebuilt surface's final geometry (spec 131 PR-131-2, §8.8):
 * the shell's container, header row, and card grid.
 */
import * as React from "react";

import { Skeleton } from "@/components/shared/ui/skeleton";

export default function InAppScheduleLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading pages"
      className="mx-auto flex w-full max-w-300 flex-col gap-6 px-6 py-6 sm:px-page sm:py-page"
    >
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-11 w-32" />
      </div>
      <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
      </div>
    </div>
  );
}
