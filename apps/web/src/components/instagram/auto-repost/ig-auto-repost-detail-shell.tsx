'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, buildTenantApiPath, buildUrl, isApiError } from '@/lib/api';
import {
  MirrorDetailResponseSchema,
  UpdateMirrorResponseSchema,
} from '@/lib/api/schemas/tiktok-mirrors';
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
import { toast } from '@/components/shared/ui/toast';
import { TikTokDashboardTab } from '@/components/tiktok/tiktok-dashboard-tab';
import { MirrorDetailHeader } from '@/components/tiktok/mirror-detail-header';

/**
 * Instagram mirror dedicated view — the Facebook mirror detail
 * pattern with Dashboard only. There is deliberately no Insights
 * tab: the Facebook insights panel is page-specific and no
 * Instagram destination insights panel exists. The header is the
 * shared MirrorDetailHeader (target-first, Pages-style, no
 * Facebook link for Instagram); pause/resume and delete live in
 * its three-dots menu, and delete asks first.
 */

export interface IgAutoRepostDetailShellProps {
  subdomain: string;
  mirrorId: string;
}

export function IgAutoRepostDetailShell({ subdomain, mirrorId }: Readonly<IgAutoRepostDetailShellProps>) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const [isDeleteOpen, setIsDeleteOpen] = React.useState(false);

  const detailQuery = useQuery({
    queryKey: tenant.instagramAutoRepost.detail(mirrorId),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(buildTenantApiPath(subdomain, `/tiktok-mirrors/${mirrorId}`), {
          targetPlatform: 'instagram',
        }),
        {
          schema: MirrorDetailResponseSchema,
          signal,
        }
      ),
  });

  const updateMutation = useMutation({
    mutationFn: (status: 'active' | 'paused') =>
      api.patch(
        buildTenantApiPath(subdomain, `/tiktok-mirrors/${mirrorId}`),
        { status },
        { schema: UpdateMirrorResponseSchema }
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({
        queryKey: tenant.instagramAutoRepost.detail(mirrorId),
      });
      void queryClient.invalidateQueries({ queryKey: tenant.instagramAutoRepost.list });
      toast.success(data.status === 'paused' ? 'Mirror paused' : 'Mirror resumed');
    },
    onError: () => {
      toast.error('Could not update the mirror. Please try again.');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(buildTenantApiPath(subdomain, `/tiktok-mirrors/${mirrorId}`)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tenant.instagramAutoRepost.list });
      toast.success('Mirror deleted');
      router.push(buildTenantHref(subdomain, `/instagram/auto-repost`, isTenantSubdomainHost(window.location.hostname, subdomain)));
    },
    onError: () => {
      toast.error('Could not delete the mirror. Please try again.');
    },
  });

  if (detailQuery.isPending) {
    return (
      <div data-testid="ig-auto-repost-detail-loading" className="mx-auto box-border w-full max-w-300 px-6 py-6">
        <Skeleton className="h-14 w-2/3 rounded-md" />
        <Skeleton className="mt-6 h-40 w-full rounded-md" />
      </div>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    const notFound =
      isApiError(detailQuery.error) && detailQuery.error.kind === 'http' && detailQuery.error.status === 404;
    return (
      <div className="mx-auto box-border w-full max-w-300 px-6 py-6">
        <EmptyState
          type="not-found"
          data-testid="ig-auto-repost-detail-error"
          title={notFound ? 'Mirror not found' : "Couldn't load this mirror"}
          description="Please try again."
          action={
            <Button type="button" onClick={() => { void detailQuery.refetch(); }}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  const { mirror, posts } = detailQuery.data;
  const isPaused = mirror.status === 'paused';

  return (
    <div
      data-testid="ig-auto-repost-detail-page"
      className="mx-auto box-border w-full max-w-300 px-6 py-6"
    >
      <MirrorDetailHeader
        mirror={mirror}
        backHref={buildTenantHref(subdomain, '/instagram/auto-repost', isTenantSubdomainHost(window.location.hostname, subdomain))}
        onPauseResume={() => updateMutation.mutate(isPaused ? 'active' : 'paused')}
        pausePending={updateMutation.isPending}
        onDeleteRequest={() => setIsDeleteOpen(true)}
      />

      <TikTokDashboardTab
        mirror={mirror}
        posts={posts}
        subdomain={subdomain}
        mirrorId={mirrorId}
      />

      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent data-testid="ig-auto-repost-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this mirror?</AlertDialogTitle>
            <AlertDialogDescription>
              @{mirror.sourceUsername} will stop posting to {mirror.targetDisplayName}.
              The Instagram account itself is not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="ig-auto-repost-delete-confirm-btn"
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
