'use client';

// Preview-retrigger note (no behaviour change): this comment exists only so
// the branch carries a real file change for Vercel to build after the
// rate-limited deployment; it will vanish in the squash merge.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';

import { api, buildTenantApiPath } from '@/lib/api';
import { ListMirrorsResponseSchema } from '@/lib/api/schemas/tiktok-mirrors';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
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
  const tenant = queryKeys.tenant(subdomain);
  const [isAddOpen, setIsAddOpen] = React.useState(false);
  const [highlightedId, setHighlightedId] = React.useState<string | null>(null);

  const mirrorsQuery = useQuery({
    queryKey: tenant.tiktokMirrors.list,
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, '/tiktok-mirrors'), {
        schema: ListMirrorsResponseSchema,
        signal,
      }),
  });

  const mirrors = mirrorsQuery.data?.mirrors ?? [];

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
            {mirrors.length === 0
              ? 'Auto-repost TikTok reels to your Facebook pages.'
              : `${mirrors.length} ${mirrors.length === 1 ? 'mirror' : 'mirrors'}`}
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
