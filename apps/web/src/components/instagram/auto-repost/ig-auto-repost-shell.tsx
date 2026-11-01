'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';

import { api, buildTenantApiPath, buildUrl } from '@/lib/api';
import { ListMirrorsResponseSchema } from '@/lib/api/schemas/tiktok-mirrors';
import { queryKeys } from '@/lib/data/query-keys';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';
import { buildTenantHref, isTenantSubdomainHost } from '@/lib/tenant-href';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { ListPagination } from '@/components/shared/ui/list-pagination';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { TikTokCard } from '@/components/tiktok/tiktok-card';
import { FeatureCapText, useFeatureCap } from '@/components/billing/feature-cap';
import { IgAddMirrorDialog } from './ig-add-mirror-dialog';

/**
 * Instagram Auto Repost list — the Facebook Auto Repost list pattern
 * for Instagram targets: header + Add button, grid of cards, empty
 * state, load-error state with Retry. Cards navigate to the
 * Instagram mirror's dedicated view. The list is the generalised
 * mirror API filtered to Instagram targets only, so Facebook
 * mirrors never appear here.
 */

export interface IgAutoRepostShellProps {
  subdomain: string;
}

export function IgAutoRepostShell({ subdomain }: Readonly<IgAutoRepostShellProps>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenant = queryKeys.tenant(subdomain);
  const [isAddOpen, setIsAddOpen] = React.useState(false);
  const [highlightedId, setHighlightedId] = React.useState<string | null>(null);
  // Plan cap: the Add Auto Repost button disables at the cap, and
  // the mirror create route enforces the same cap server-side.
  const { cap: instagramCap } = useFeatureCap(subdomain, 'instagram');

  const initialPage = React.useMemo(() => {
    const raw = Number.parseInt(searchParams.get('page') ?? '', 10);
    return Number.isFinite(raw) && raw >= 1 ? raw : 1;
    // Deliberately read once at mount: later URL changes flow
    // through the sync effect, not through this initializer.
  }, []);
  const [page, setPage] = React.useState(initialPage);

  const mirrorsQuery = useQuery({
    queryKey: tenant.instagramAutoRepost.listPage({ page }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(buildTenantApiPath(subdomain, '/tiktok-mirrors'), {
          page,
          limit: DEFAULT_PAGE_SIZE,
          targetPlatform: 'instagram',
        }),
        {
          schema: ListMirrorsResponseSchema,
          signal,
        }
      ),
  });

  const mirrors = mirrorsQuery.data?.mirrors ?? [];
  const total = mirrorsQuery.data?.total ?? 0;
  const totalPages = mirrorsQuery.data?.totalPages ?? 0;

  React.useEffect(() => {
    if (mirrorsQuery.data && mirrorsQuery.data.page !== undefined && mirrorsQuery.data.page !== page) {
      setPage(mirrorsQuery.data.page);
    }
  }, [mirrorsQuery.data, page]);

  React.useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (page <= 1) params.delete('page');
    else params.set('page', String(page));
    const next = params.toString();
    if (next !== searchParams.toString()) {
      router.replace(next ? `?${next}` : '?', { scroll: false });
    }
  }, [page, router, searchParams]);

  let contentNode: React.ReactNode;
  if (mirrorsQuery.isPending) {
    contentNode = (
      <div data-testid="ig-auto-repost-loading-skeleton" aria-busy="true" aria-label="Loading mirrors" className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-50 w-full rounded-md" />
        ))}
      </div>
    );
  } else if (mirrorsQuery.isError) {
    contentNode = (
      <EmptyState
        type="not-found"
        data-testid="ig-auto-repost-load-error"
        title="Couldn't load your mirrors"
        description="Please try again."
        action={
          <Button type="button" data-testid="ig-auto-repost-load-retry-btn" onClick={() => { void mirrorsQuery.refetch(); }}>
            Retry
          </Button>
        }
      />
    );
  } else if (mirrors.length === 0) {
    contentNode = (
      <EmptyState
        type="no-results"
        data-testid="ig-auto-repost-empty-state"
        title="No mirrors yet"
        description="Add a TikTok username and every new reel from that account will be reposted to your Instagram account automatically."
        action={
          <div className="flex flex-col items-center gap-2">
            {instagramCap ? (
              <FeatureCapText cap={instagramCap} platform="instagram" />
            ) : null}
            <Button
              type="button"
              data-testid="ig-auto-repost-empty-add-btn"
              onClick={() => setIsAddOpen(true)}
              disabled={instagramCap?.atCap ?? false}
            >
              <PlusIcon aria-hidden />
              <span>Add Auto Repost</span>
            </Button>
          </div>
        }
      />
    );
  } else {
    contentNode = (
      <>
        <div data-testid="ig-auto-repost-mirrors-grid" className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {mirrors.map((mirror) => (
            <TikTokCard
              key={mirror.id}
              mirror={mirror}
              highlighted={highlightedId === mirror.id}
              onSelect={(selected) => {
                router.push(buildTenantHref(subdomain, `/instagram/auto-repost/${selected.id}`, isTenantSubdomainHost(window.location.hostname, subdomain)));
              }}
            />
          ))}
        </div>
        <ListPagination
          page={page}
          totalPages={totalPages}
          total={total}
          limit={DEFAULT_PAGE_SIZE}
          onPageChange={setPage}
        />
      </>
    );
  }

  return (
    <div
      data-testid="ig-auto-repost-page"
      className="mx-auto box-border w-full max-w-300 px-6 py-6"
    >
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 data-testid="ig-auto-repost-page-title" className="mb-1 text-xxl font-bold tracking-h1 text-ink">
            Auto Repost
          </h1>
          <p data-testid="ig-auto-repost-page-subtitle" className="m-0 text-body text-ink-sub">
            {total === 0
              ? 'Auto-repost TikTok reels to your Instagram accounts.'
              : `${total} ${total === 1 ? 'mirror' : 'mirrors'}`}
          </p>
          {instagramCap ? (
            <FeatureCapText cap={instagramCap} platform="instagram" />
          ) : null}
        </div>
        <Button
          type="button"
          data-testid="ig-header-add-mirror-btn"
          onClick={() => setIsAddOpen(true)}
          disabled={instagramCap?.atCap ?? false}
        >
          <PlusIcon aria-hidden />
          <span>Add Auto Repost</span>
        </Button>
      </div>

      {contentNode}

      <IgAddMirrorDialog
        subdomain={subdomain}
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
        onSuccess={(mirrorId) => setHighlightedId(mirrorId)}
      />
    </div>
  );
}
