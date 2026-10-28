/**
 * Root segment loading boundary (spec 137 §3.3 / PR-A2) — NEUTRAL fallback.
 *
 * This boundary wraps the root segment's children, which includes every
 * child segment's LAYOUT — so on a hard reload of any tenant URL, this is
 * the fallback that paints while the tenant layout resolves (session +
 * workspace display-name lookup) and BEFORE the sidebar/header exist.
 * The tenant loading.tsx only wraps the tenant PAGE, so it can never
 * cover that window. That is why this file must stay neutral: its
 * previous bordered panel read as a card on every tenant page reload,
 * even after the tenant fallback itself was neutralised.
 *
 * The neutral shape is a centred stack of generic bars — no bordered
 * panel, no page measure, no card grid, nothing any route could be
 * mistaken for. Routes wanting geometry-matched loaders ship their own
 * loading.tsx (the pattern accounts/pages/settings already use).
 */
import * as React from "react";

import { Skeleton } from "@/components/shared/ui/skeleton";

export default function RootLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="flex items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-sm flex-col gap-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </div>
  );
}
