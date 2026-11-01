'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, buildTenantApiPath } from '@/lib/api';
import {
  MirrorDetailResponseSchema,
  UpdateMirrorResponseSchema,
} from '@/lib/api/schemas/threads-auto-repost';
import { queryKeys } from '@/lib/data/query-keys';
import { buildTenantHref, isTenantSubdomainHost } from '@/lib/tenant-href';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/shared/ui/alert-dialog';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { Switch } from '@/components/shared/ui/switch';
import { toast } from '@/components/shared/ui/toast';
import { ThreadsAutoRepostDashboardTab } from './threads-auto-repost-dashboard-tab';

/**
 * Threads mirror dedicated view — Dashboard only (no Insights tab:
 * there is no Threads destination insights panel to reuse, unlike
 * Facebook pages). Pause/resume is a switch; delete asks first.
 * Resuming arms the tick's catch-up rule: the first tick after
 * resume posts only the newest reel.
 */

export interface ThreadsAutoRepostDetailShellProps {
  subdomain: string;
  mirrorId: string;
}

export function ThreadsAutoRepostDetailShell({ subdomain, mirrorId }: Readonly<ThreadsAutoRepostDetailShellProps>) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const [isDeleteOpen, setIsDeleteOpen] = React.useState(false);

  const detailQuery = useQuery({
    queryKey: tenant.threadsAutoRepost.detail(mirrorId),
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, `/threads/auto-repost/${mirrorId}`), {
        schema: MirrorDetailResponseSchema,
        signal,
      }),
  });

  const updateMutation = useMutation({
    mutationFn: (status: 'active' | 'paused') =>
      api.patch(
        buildTenantApiPath(subdomain, `/threads/auto-repost/${mirrorId}`),
        { status },
        { schema: UpdateMirrorResponseSchema }
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({
        queryKey: tenant.threadsAutoRepost.detail(mirrorId),
      });
      void queryClient.invalidateQueries({ queryKey: tenant.threadsAutoRepost.list });
      toast.success(data.status === 'paused' ? 'Mirror paused' : 'Mirror resumed');
    },
    onError: () => {
      toast.error('Could not update the mirror. Please try again.');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(buildTenantApiPath(subdomain, `/threads/auto-repost/${mirrorId}`)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tenant.threadsAutoRepost.list });
      toast.success('Mirror deleted');
      router.push(buildTenantHref(subdomain, `/threads/auto-repost`, isTenantSubdomainHost(window.location.hostname, subdomain)));
    },
    onError: () => {
      toast.error('Could not delete the mirror. Please try again.');
    },
  });

  if (detailQuery.isPending) {
    return <Skeleton className="h-50 w-full rounded-md" />;
  }
  if (detailQuery.isError || !detailQuery.data) {
    return (
      <EmptyState
        type="not-found"
        data-testid="threads-mirror-detail-error"
        title="Couldn't load this mirror"
        description="Please try again."
        action={
          <Button type="button" onClick={() => { void detailQuery.refetch(); }}>
            Retry
          </Button>
        }
      />
    );
  }

  const { mirror, posts } = detailQuery.data;
  const paused = mirror.status === 'paused';

  return (
    <div data-testid="threads-mirror-detail-page" className="mx-auto box-border w-full max-w-300 px-6 py-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-xxl font-bold tracking-h1 text-ink">
            @{mirror.sourceUsername}
          </h1>
          <p className="m-0 text-body text-ink-sub">
            Mirroring to {mirror.targetDisplayName} on Threads
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-body text-ink">
            <Switch
              checked={!paused}
              onCheckedChange={(checked) =>
                updateMutation.mutate(checked ? 'active' : 'paused')
              }
              aria-label={paused ? 'Resume mirror' : 'Pause mirror'}
            />
            <span>{paused ? 'Paused' : 'Active'}</span>
          </label>
          <Button type="button" variant="destructive" onClick={() => setIsDeleteOpen(true)}>
            Delete
          </Button>
        </div>
      </div>

      <ThreadsAutoRepostDashboardTab mirror={mirror} posts={posts} />

      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this mirror?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops reposting @{mirror.sourceUsername} to {mirror.targetDisplayName}
              and removes its mirror history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
