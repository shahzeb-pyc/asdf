import { Skeleton } from '@/components/shared/ui/skeleton';

export default function BulkDeletePostsLoading() {
  return (
    <div className="space-y-6" aria-label="Loading Bulk Delete Posts">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-5 w-96" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
