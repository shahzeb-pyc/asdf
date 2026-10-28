/**
 * Tenant segment loading boundary (spec 137 §3.3 / PR-A2) — NEUTRAL fallback.
 *
 * This file is the loading state for every tenant route that does NOT ship
 * its own loading.tsx (prompts, connect, the destination redirector, the
 * platform account pages, and any future route). It must NEVER render
 * another page's skeleton: it previously mirrored the workspace-home
 * welcome card, so every one of those routes showed the home card on reload.
 *
 * The neutral shape is a centred stack of generic bars — no Card, no page
 * measure, no card grid, no tab bar, nothing any route could be mistaken
 * for. Routes with materially different geometry ship their own loading.tsx
 * (accounts, pages, page detail, media, settings, downloader, fdola-studio).
 * Restoring the home route's own geometry-matched skeleton is a follow-up
 * (in-page Suspense fallback, the pattern accounts/pages/settings already
 * use). It renders inside the tenant layout — sidebar and header stay in
 * place.
 */
import * as React from "react";

import { Skeleton } from "@/components/shared/ui/skeleton";

export default function TenantLoading() {
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
