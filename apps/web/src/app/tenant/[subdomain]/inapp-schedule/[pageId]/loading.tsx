/**
 * Page section loading (spec 137 §3.3.3 / PR-A2; geometry refined to
 * the rebuilt frame by spec 131 PR-131-3, §8.8) — back link, identity
 * header, tab bar, and the active panel at their final geometry.
 */
import * as React from "react";

import { Skeleton } from "@/components/shared/ui/skeleton";

export default function PageDetailLoading() {
  return (
    <div aria-busy="true" aria-label="Loading page" className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6">
      <Skeleton className="h-5 w-28" />
      <div className="flex items-center gap-3">
        <Skeleton className="size-6" />
        <Skeleton className="size-11 rounded-md" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
      </div>
      <Skeleton className="h-11 w-full" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
