/**
 * Settings loading (spec 137 §3.3.3 / PR-A2; geometry aligned to the
 * rebuilt shell in spec 135 PR-135-1) — heading, horizontal tab rail
 * (4 tabs at the shell's final geometry), and the active panel below,
 * matching `settings-shell.tsx` so the loaded shell replaces this
 * skeleton without layout shift.
 */
import * as React from "react";

import { Skeleton } from "@/components/shared/ui/skeleton";

export default function SettingsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading settings" className="flex min-h-screen flex-col gap-6 px-8 py-8">
      <Skeleton className="h-8 w-32" />
      <div className="flex gap-1 border-b border-line" aria-hidden="true">
        <Skeleton className="h-10 w-20" />
        <Skeleton className="h-10 w-24" />
        <Skeleton className="h-10 w-24" />
        <Skeleton className="h-10 w-20" />
        <Skeleton className="h-10 w-20" />
        <Skeleton className="h-10 w-12" />
        <Skeleton className="h-10 w-16" />
      </div>
      <div className="flex w-full max-w-2xl flex-col gap-4 rounded-md border border-line bg-panel p-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-32" />
      </div>
    </div>
  );
}
