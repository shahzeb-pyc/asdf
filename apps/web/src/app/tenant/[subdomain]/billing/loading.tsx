import * as React from 'react';

import { Skeleton } from '@/components/shared/ui/skeleton';

export default function BillingLoading() {
  return (
    <div aria-busy="true" aria-label="Loading billing" className="flex min-h-screen flex-col gap-6 px-6 py-6">
      <Skeleton className="h-8 w-32" />
      <div className="flex w-full max-w-2xl flex-col gap-4 rounded-md border border-line bg-panel p-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-32" />
      </div>
    </div>
  );
}
