'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { z } from 'zod';

import { api, buildTenantApiPath } from '@/lib/api';
import { getErrorMessage } from '@/lib/api/errors';
import {
  InstagramScheduleDetailResponseSchema,
} from '@/lib/api/schemas/instagram-schedule';
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
import { StatusMark } from '@/components/shared/ui/status-mark';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';
import { toast } from '@/components/shared/ui/toast';
import { CalendarPanel } from './calendar-panel';
import { CreatePostDialog } from './create-post-dialog';
import { DashboardPanel } from './dashboard-panel';
import { InsightsPanel } from './insights-panel';
import { PostingTimesPanel } from './posting-times-panel';
import { QueuePanel } from './queue-panel';

/**
 * Instagram Schedule detail shell — the Facebook Page detail frame's
 * five tabs for Instagram: Dashboard, Insights, Queue, Calendar View,
 * Posting Times. Tab state lives in ?tab=, panels mount on first
 * visit and stay mounted. Header actions: Pause/Resume and Remove
 * from Schedule (with confirmation). Create Post opens the single-
 * post composer.
 */

const AckSchema = z.object({}).passthrough();

type DetailTab = 'dashboard' | 'insights' | 'queue' | 'calendar-view' | 'calendar';

const TAB_ITEMS: Array<{ id: DetailTab; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'insights', label: 'Insights' },
  { id: 'queue', label: 'Queue' },
  { id: 'calendar-view', label: 'Calendar View' },
  { id: 'calendar', label: 'Posting Times' },
];

const TAB_IDS = new Set(TAB_ITEMS.map((tab) => tab.id));

function statusMarkFor(status: string) {
  switch (status) {
    case 'active':
      return { kind: 'operational' as const, label: 'Connected' };
    case 'paused':
      return { kind: 'queued' as const, label: 'Paused' };
    case 'expired':
      return { kind: 'critical' as const, label: 'Session expired' };
    default:
      return { kind: 'critical' as const, label: 'Disconnected' };
  }
}

export function ScheduleDetailShell({
  subdomain,
  destinationId,
}: Readonly<{ subdomain: string; destinationId: string }>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);

  const initialTab = React.useMemo<DetailTab>(() => {
    const raw = searchParams.get('tab') ?? '';
    return TAB_IDS.has(raw as DetailTab) ? (raw as DetailTab) : 'dashboard';
  }, []);
  const [tab, setTab] = React.useState<DetailTab>(initialTab);
  const [visitedTabs, setVisitedTabs] = React.useState<Set<DetailTab>>(
    new Set([initialTab])
  );
  const [composerOpen, setComposerOpen] = React.useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = React.useState(false);

  const detailPath = buildTenantApiPath(
    subdomain,
    `/instagram/schedule/${destinationId}`
  );
  const detailQuery = useQuery({
    queryKey: tenant.instagramSchedule.detail(destinationId),
    queryFn: ({ signal }) =>
      api.get(detailPath, {
        schema: InstagramScheduleDetailResponseSchema,
        signal,
      }),
  });

  const handleTabChange = React.useCallback(
    (next: DetailTab) => {
      setTab(next);
      setVisitedTabs((prev) => new Set(prev).add(next));
      const params = new URLSearchParams(searchParams.toString());
      params.set('tab', next);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  const pauseMutation = useMutation({
    mutationFn: (paused: boolean) =>
      api.patch(detailPath, { paused }, { schema: AckSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: tenant.instagramSchedule.detail(destinationId),
      });
      void queryClient.invalidateQueries({
        queryKey: tenant.instagramSchedule.list,
      });
      toast.success('Schedule updated.');
    },
    onError: (error) => {
      toast.error(getErrorMessage(error, "Couldn't update this account. Please try again."));
    },
  });

  const removeMutation = useMutation({
    mutationFn: () => api.delete(detailPath, { schema: AckSchema }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: tenant.instagramSchedule.list,
      });
      toast.success('Account removed from Schedule.');
      router.push(buildTenantHref(subdomain, `/instagram/schedule`, isTenantSubdomainHost(window.location.hostname, subdomain)));
    },
    onError: (error) => {
      toast.error(getErrorMessage(error, "Couldn't remove this account from Schedule. Please try again."));
    },
  });

  if (detailQuery.isPending) {
    return (
      <div className="mx-auto box-border w-full max-w-300 px-6 py-6">
        <Skeleton className="h-24 w-full rounded-md" />
      </div>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <div className="mx-auto box-border w-full max-w-300 px-6 py-6">
        <EmptyState
          type="not-found"
          data-testid="instagram-schedule-detail-error"
          title="Couldn't load this scheduled account"
          description="It may have been removed from Schedule."
          action={
            <Button
              type="button"
              onClick={() =>
                router.push(buildTenantHref(subdomain, `/instagram/schedule`, isTenantSubdomainHost(window.location.hostname, subdomain)))
              }
            >
              Back to Schedule
            </Button>
          }
        />
      </div>
    );
  }

  const item = detailQuery.data.item;
  const mark = statusMarkFor(item.status);
  const isPaused = item.status === 'paused';

  return (
    <div
      data-testid="instagram-schedule-detail-page"
      className="mx-auto box-border w-full max-w-300 px-6 py-6"
    >
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {item.accountAvatarUrl ? (
            <Image
              src={item.accountAvatarUrl}
              alt=""
              width={48}
              height={48}
              className="size-12 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="flex size-12 shrink-0 items-center justify-center rounded-full bg-subtle text-lg font-semibold text-ink"
            >
              {item.accountDisplayName.charAt(0).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <h1 className="mb-1 truncate text-xxl font-bold tracking-h1 text-ink">
              {item.accountDisplayName}
            </h1>
            <p className="m-0 truncate text-body text-ink-sub">
              {item.handle ? `@${item.handle}` : 'Instagram account'}
              {item.accountType ? ` · ${item.accountType}` : ''} · {item.timezone}
            </p>
            <div className="mt-1">
              <StatusMark
                kind={mark.kind}
                label={mark.label}
                testId="instagram-schedule-detail-status"
              />
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => setComposerOpen(true)}>
            Create post
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={pauseMutation.isPending}
            onClick={() => pauseMutation.mutate(!isPaused)}
          >
            {isPaused ? 'Resume' : 'Pause'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setRemoveDialogOpen(true)}
          >
            Remove from Schedule
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(value) => handleTabChange(value as DetailTab)}>
        <TabsList>
          {TAB_ITEMS.map((tabItem) => (
            <TabsTrigger key={tabItem.id} value={tabItem.id}>
              {tabItem.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {visitedTabs.has('dashboard') && (
          <TabsContent value="dashboard" hidden={tab !== 'dashboard'}>
            <DashboardPanel
              subdomain={subdomain}
              item={item}
              onCreatePost={() => setComposerOpen(true)}
              onViewQueue={() => handleTabChange('queue')}
            />
          </TabsContent>
        )}
        {visitedTabs.has('insights') && (
          <TabsContent value="insights" hidden={tab !== 'insights'}>
            <InsightsPanel subdomain={subdomain} item={item} />
          </TabsContent>
        )}
        {visitedTabs.has('queue') && (
          <TabsContent value="queue" hidden={tab !== 'queue'}>
            <QueuePanel
              subdomain={subdomain}
              destinationId={destinationId}
              timezone={item.timezone}
              detailStatus={item.status}
              onCreatePost={() => setComposerOpen(true)}
            />
          </TabsContent>
        )}
        {visitedTabs.has('calendar-view') && (
          <TabsContent value="calendar-view" hidden={tab !== 'calendar-view'}>
            <CalendarPanel
              subdomain={subdomain}
              destinationId={destinationId}
              timezone={item.timezone}
            />
          </TabsContent>
        )}
        {visitedTabs.has('calendar') && (
          <TabsContent value="calendar" hidden={tab !== 'calendar'}>
            <PostingTimesPanel
              subdomain={subdomain}
              destinationId={destinationId}
              timezone={item.timezone}
              queuedCount={item.counts.queued}
            />
          </TabsContent>
        )}
      </Tabs>

      <CreatePostDialog
        subdomain={subdomain}
        destinationId={destinationId}
        accountDisplayName={item.accountDisplayName}
        open={composerOpen}
        onOpenChange={setComposerOpen}
      />

      <AlertDialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <AlertDialogContent data-testid="instagram-schedule-remove-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove from Schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              {item.accountDisplayName} will no longer post on this
              schedule, its posting times will be deleted, and queued
              posts will be cancelled. Published posts and the
              connected account are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep in Schedule</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setRemoveDialogOpen(false);
                removeMutation.mutate();
              }}
            >
              Remove from Schedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
