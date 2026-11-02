import React from 'react';
import { Card, CardContent } from '@/components/shared/ui/card';
import { Skeleton } from '@/components/shared/ui/skeleton';

export default function TenantPaymentsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading payments" className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-72 max-w-full" />
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
