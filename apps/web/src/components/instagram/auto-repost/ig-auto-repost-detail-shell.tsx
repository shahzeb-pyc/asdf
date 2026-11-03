'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';
import { toast } from '@/components/shared/ui/toast';
import { TikTokDashboardTab } from '@/components/tiktok/tiktok-dashboard-tab';
import { TikTokHistoryTab, type HistoryStatusFilter } from '@/components/tiktok/tiktok-history-tab';
import { MirrorDetailHeader } from '@/components/tiktok/mirror-detail-header';

/**
 * Instagram mirror dedicated view — the Facebook mirror detail
 * pattern with Dashboard + History tabs. There is deliberately no
 * Insights tab: the Facebook insights panel is page-specific and
 * no Instagram destination insights panel exists. Tab state lives
 * in ?tab= and the History filter in ?status=, like the Facebook
 * shell. The header is the shared MirrorDetailHeader (target-first,
 * Pages-style, no Facebook link for Instagram); pause/resume and
 * delete live in its three-dots menu, and delete asks first.
 */

type DetailTab = 'dashboard' | 'history';

const TAB_IDS: ReadonlySet<string> = new Set(['dashboard', 'history']);

function resolveTab(raw: string | null): DetailTab {
  return raw !== null && TAB_IDS.has(raw) ? (raw as DetailTab) : 'dashboard';
}

function resolveHistoryStatus(raw: string | null): HistoryStatusFilter {
  return raw === 'posted' || raw === 'failed' || raw === 'skipped' ? raw : 'all';
}

export interface IgAutoRepostDetailShellProps {
  subdomain: string;
  mirrorId: string;
}

export function IgAutoRepostDetailShell({ subdomain, mirrorId }: Readonly<IgAutoRepostDetailShellProps>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const [isDeleteOpen, setIsDeleteOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<DetailTab>(() =>
    resolveTab(searchParams.get('tab'))
  );
  const [historyStatus, setHistoryStatus] = React.useState<HistoryStatusFilter>(() =>
    resolveHistoryStatus(searchParams.get('status'))
  );

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

  const { mirror, posts, postCounts, postCountsError } = detailQuery.data;
  const isPaused = mirror.status === 'paused';

  const detailHref = (params: URLSearchParams): string => {
    const query = params.toString();
    return buildTenantHref(
      subdomain,
      query ? `/instagram/auto-repost/${mirrorId}?${query}` : `/instagram/auto-repost/${mirrorId}`,
      isTenantSubdomainHost(window.location.hostname, subdomain)
    );
  };

  const handleTabChange = (value: string) => {
    const tab = resolveTab(value);
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams.toString());
    if (tab === 'dashboard') params.delete('tab');
    else params.set('tab', tab);
    if (tab !== 'history') params.delete('status');
    else if (historyStatus !== 'all') params.set('status', historyStatus);
    router.replace(detailHref(params), { scroll: false });
  };

  const handleHistoryStatusChange = (next: HistoryStatusFilter) => {
    setHistoryStatus(next);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'history');
    if (next === 'all') params.delete('status');
    else params.set('status', next);
    router.replace(detailHref(params), { scroll: false });
  };

  const handleViewFailed = () => {
    setHistoryStatus('failed');
    setActiveTab('history');
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', 'history');
    params.set('status', 'failed');
    router.replace(detailHref(params), { scroll: false });
  };

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

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList data-testid="ig-auto-repost-detail-tabs">
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="dashboard">
          <TikTokDashboardTab
            posts={posts}
            postCounts={postCounts}
            postCountsError={postCountsError ?? false}
            onViewFailed={handleViewFailed}
          />
        </TabsContent>
        <TabsContent value="history">
          <TikTokHistoryTab
            mirror={mirror}
            subdomain={subdomain}
            mirrorId={mirrorId}
            status={historyStatus}
            onStatusChange={handleHistoryStatusChange}
          />
        </TabsContent>
      </Tabs>

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
