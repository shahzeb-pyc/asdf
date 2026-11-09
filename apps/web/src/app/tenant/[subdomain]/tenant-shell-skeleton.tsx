import * as React from 'react';
import { Skeleton } from '@/components/shared/ui/skeleton';

/**
 * Tenant shell skeleton (spec 152 O2) — the static first paint.
 *
 * Rendered by the tenant layout's Suspense fallback while the shell's
 * server data (workspace name + entitlement seed) resolves. It is
 * deliberately plan-blind: no plan word, no pill, no gate content,
 * no text that could be mistaken for a plan state — the shell must
 * never flash paid content to a free user or vice versa. Geometry
 * mirrors the real shell (desktop rail + 44px topbar + page bars)
 * so the swap to the real shell does not shift layout.
 *
 * Design-system tokens only; no new colours, no inline styles.
 */
export function TenantShellSkeleton() {
  return (
    <div
      data-testid="tenant-shell-skeleton"
      aria-busy="true"
      aria-label="Loading"
      className="flex min-h-svh w-full bg-canvas"
    >
      {/* Desktop rail — hidden on phones, exactly like the real sidebar. */}
      <div
        aria-hidden="true"
        className="hidden w-64 shrink-0 flex-col gap-3 border-r border-line bg-panel p-4 md:flex"
      >
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-24" />
        <div className="mt-4 flex flex-col gap-2">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-canvas px-3">
          <Skeleton className="size-11 shrink-0" />
          <Skeleton className="h-4 w-32" />
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-8 w-16" />
          </div>
        </header>
        <div className="flex items-center justify-center px-6 py-12">
          <div className="flex w-full max-w-sm flex-col gap-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
      </div>
    </div>
  );
}
