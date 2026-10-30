'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';

import { api, buildTenantApiPath, buildUrl } from '@/lib/api';
import { ListMirrorsResponseSchema } from '@/lib/api/schemas/tiktok-mirrors';
import { queryKeys } from '@/lib/data/query-keys';
import { DEFAULT_PAGE_SIZE } from '@/lib/server/pagination';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { ListPagination } from '@/components/shared/ui/list-pagination';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { AddMirrorDialog } from './add-mirror-dialog';
import { TikTokCard } from './tiktok-card';

/**
 * TikTok mirrors list — the Pages list pattern for mirrors: header +
 * Add button, grid of cards, empty state, load-error state with
 * Retry. Cards navigate to the mirror's dedicated view.
 */

export interface TikTokShellProps {
  subdomain: string;
}

export function TikTokShell({ subdomain }: Readonly<TikTokShellProps>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tenant = queryKeys.tenant(subdomain);
  const [isAddOpen, setIsAddOpen] = React.useState(false);
  const [highlightedId, setHighlightedId] = React.useState<string | null>(null);

  // Pagination state lives in the URL (?page=) so refresh and a shared
  // link land on the same page; an unparseable value falls back to 1.
  const initialPage = React.useMemo(() => {
    const raw = Number.parseInt(searchParams.get('page') ?? '', 10);
    return Number.isFinite(raw) && raw >= 1 ? raw : 1;
    // Deliberately read once at mount: later URL changes flow
    // through the sync effect, not through this initializer.
  }, []);
  const [page, setPage] = React.useState(initialPage);

  const mirrorsQuery = useQuery({
    queryKey: tenant.tiktokMirrors.listPage({ page }),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(buildTenantApiPath(subdomain, '/tiktok-mirrors'), {
          page,
          limit: DEFAULT_PAGE_SIZE,
        }),
        {
          schema: ListMirrorsResponseSchema,
          signal,
        }
      ),
  });

  const mirrors = mirrorsQuery.data?.mirrors ?? [];
  // The API returns the page slice, so the total/totalPages come from
  // the API's total, not the page length.
  const total = mirrorsQuery.data?.total ?? 0;
  const totalPages = mirrorsQuery.data?.totalPages ?? 0;

  // An out-of-range ?page= is clamped by the API; sync the state (and
  // the URL, via the effect below) to the page that actually came back.
  React.useEffect(() => {
    if (mirrorsQuery.data && mirrorsQuery.data.page !== undefined && mirrorsQuery.data.page !== page) {
      setPage(mirrorsQuery.data.page);
    }
  }, [mirrorsQuery.data, page]);

  // Keep ?page= in the URL in step with state (page 1 omits the param).
  // A query-only replace resolves against the current pathname, so no
  // usePathname dependency is needed.
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
      <div data-testid="tiktok-loading-skeleton" aria-busy="true" aria-label="Loading mirrors" className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-50 w-full rounded-md" />
        ))}
      </div>
    );
  } else if (mirrorsQuery.isError) {
    contentNode = (
      <EmptyState
        type="not-found"
        data-testid="tiktok-load-error"
        title="Couldn't load your mirrors"
        description="Please try again."
        action={
          <Button type="button" data-testid="tiktok-load-retry-btn" onClick={() => { void mirrorsQuery.refetch(); }}>
            Retry
          </Button>
        }
      />
    );
  } else if (mirrors.length === 0) {
    contentNode = (
      <EmptyState
        type="no-results"
        data-testid="tiktok-empty-state"
        title="No mirrors yet"
        description="Add a TikTok username and every new reel from that account will be reposted to your Facebook page automatically."
        action={
          <Button type="button" data-testid="tiktok-empty-add-btn" onClick={() => setIsAddOpen(true)}>
            <PlusIcon aria-hidden />
            <span>Add Auto Repost</span>
          </Button>
        }
      />
    );
  } else {
    contentNode = (
      <>
        <div data-testid="tiktok-mirrors-grid" className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {mirrors.map((mirror) => (
            <TikTokCard
              key={mirror.id}
              mirror={mirror}
              highlighted={highlightedId === mirror.id}
              onSelect={(selected) => {
                router.push(`/tenant/${subdomain}/tiktok-mirrors/${selected.id}`);
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
      data-testid="tiktok-mirrors-page"
      className="mx-auto box-border w-full max-w-300 px-6 py-6"
    >
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 data-testid="tiktok-page-title" className="mb-1 text-xxl font-bold tracking-h1 text-ink">
            Auto Repost
          </h1>
          <p data-testid="tiktok-page-subtitle" className="m-0 text-body text-ink-sub">
            {total === 0
              ? 'Auto-repost TikTok reels to your Facebook pages.'
              : `${total} ${total === 1 ? 'mirror' : 'mirrors'}`}
          </p>
        </div>
        <Button type="button" data-testid="header-add-mirror-btn" onClick={() => setIsAddOpen(true)}>
          <PlusIcon aria-hidden />
          <span>Add Auto Repost</span>
        </Button>
      </div>

      {contentNode}

      <AddMirrorDialog
        subdomain={subdomain}
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
        onSuccess={(mirrorId) => setHighlightedId(mirrorId)}
      />
    </div>
  );
}
