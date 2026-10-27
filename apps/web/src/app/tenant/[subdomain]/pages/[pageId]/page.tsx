/**
 * Dedicated Facebook Page section route — server component (spec 131
 * PR-131-3, spec §8.1/§8.4).
 *
 * The former 642-line client controller is decomposed: this file is the
 * server-first entry only; the frame composition (identity header, tab
 * bar, slot mounts) lives in `page-section-shell.tsx`, the 131-owned tab
 * content in `components/pages/dedicated/{page-header,tab-dashboard,
 * insights-panel,insights-chart}.tsx`, and all data in the spec 137 data
 * layer.
 *
 * Server-first pattern (spec 137 §3.2.4): page detail, the pages list
 * (the detail fallback), queue items, and posting slots are fetched in
 * parallel here through the cookie-forwarding server variant of the
 * typed API client and dehydrated into the React Query cache the shell
 * and the slotted 132/134 panels read from — the frame's repeated slots
 * reads collapse to one cache entry (spec §8.1). Zero fetch-on-mount
 * for initial data; the route holds zero `fetch(` of its own.
 *
 * Failure handling: `prefetchServerQueries` never throws — a failed
 * prefetch simply leaves the key out of the dehydrated state and the
 * shell's query fetches on mount instead, where its error state is the
 * ladder rung (the preserved "Couldn't locate the requested Facebook
 * Page." state, never silent).
 */

import * as React from 'react';

import { buildTenantApiPath } from '@/lib/api/client';
import {
  ListFacebookPagesResponseSchema,
  PageDetailResponseSchema,
} from '@/lib/api/schemas/pages';
import {
  ListQueueItemsResponseSchema,
  ListQueueSlotsResponseSchema,
} from '@/lib/api/schemas/queue';
import { DataHydration, queryKeys } from '@/lib/data';
import {
  createServerQueryClient,
  prefetchServerQueries,
  serverApiFetch,
} from '@/lib/data/server';

import PageDetailLoading from './loading';
import TenantDedicatedPageView from './page-section-shell';

export type {
  DedicatedPageTab,
  TenantDedicatedPageViewProps,
} from './page-section-shell';

interface TenantPageSectionPageProps {
  params: Promise<{ subdomain: string; pageId: string }>;
}

export default async function TenantPageSectionPage({
  params,
}: Readonly<TenantPageSectionPageProps>) {
  const { subdomain, pageId } = await params;
  const tenant = queryKeys.tenant(subdomain);

  const queryClient = createServerQueryClient(subdomain);
  const state = await prefetchServerQueries(queryClient, [
    {
      queryKey: tenant.pages.detail(pageId),
      queryFn: () =>
        serverApiFetch(buildTenantApiPath(subdomain, `/pages/${pageId}`), {
          schema: PageDetailResponseSchema,
        }),
    },
    {
      queryKey: tenant.pages.list,
      queryFn: () =>
        serverApiFetch(buildTenantApiPath(subdomain, '/pages'), {
          schema: ListFacebookPagesResponseSchema,
        }),
    },
    {
      queryKey: tenant.queue.items(pageId),
      queryFn: () =>
        serverApiFetch(
          `${buildTenantApiPath(subdomain, '/publishing/queue')}?pageId=${encodeURIComponent(pageId)}`,
          { schema: ListQueueItemsResponseSchema }
        ),
    },
    {
      queryKey: tenant.pages.slots(pageId),
      queryFn: () =>
        serverApiFetch(buildTenantApiPath(subdomain, `/pages/${pageId}/slots`), {
          schema: ListQueueSlotsResponseSchema,
        }),
    },
  ]);

  return (
    <DataHydration state={state}>
      <React.Suspense fallback={<PageDetailLoading />}>
        <TenantDedicatedPageView subdomainProp={subdomain} pageIdProp={pageId} />
      </React.Suspense>
    </DataHydration>
  );
}
