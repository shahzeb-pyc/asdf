import { buildTenantApiPath } from '@/lib/api';
import {
  FolderListResponseSchema,
  MediaListResponseSchema,
} from '@/lib/api/schemas/media';
import { queryKeys } from '@/lib/data/query-keys';
import {
  createServerQueryClient,
  fetchServerFirst,
  prefetchServerQueries,
} from '@/lib/data/server';
import { DataHydration } from '@/lib/data/provider';
import { MediaLibraryExplorer } from '@/components/media/media-library-explorer';
import {
  MEDIA_LIST_LIMIT,
  toMediaFolder,
  toMediaItemResponse,
} from '@/components/media/media-data';

/**
 * Media Library route (spec 133 §6.1 / PR-133-1): a server component.
 *
 * Initial folders + the first media list load server-side IN PARALLEL
 * (spec 137 §3.2.4 — no `lib/server` media functions exist, so the
 * cookie-forwarding server variant of the typed client is used) and
 * dehydrate into the client cache under `queryKeys.media`; the
 * explorer island reads the cache — no fetch-on-mount for initial
 * data. Loading scope per OD-133-2's default: the legacy single-fetch
 * `limit=500` semantics are preserved.
 */
export default async function TenantMediaLibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ subdomain: string }>;
  searchParams?: Promise<{ folder?: string | string[] }>;
}) {
  const { subdomain } = await params;
  const tenant = queryKeys.tenant(subdomain);
  const queryClient = createServerQueryClient(subdomain);

  // The tray's "View in library" deep-links here (?folder=<id>). The id
  // is validated against the fetched folders server-side: an unknown
  // id falls back to root instead of rendering an empty folder view.
  const search = await searchParams;
  const requestedFolder =
    search?.folder && typeof search.folder === 'string' ? search.folder : null;

  const dehydratedState = await prefetchServerQueries(queryClient, [
    {
      queryKey: tenant.media.folders,
      queryFn: async () => {
        const data = await fetchServerFirst({
          path: buildTenantApiPath(subdomain, '/media/folders'),
          schema: FolderListResponseSchema,
        });
        return data.folders.map(toMediaFolder);
      },
    },
    {
      queryKey: tenant.media.list,
      queryFn: async () => {
        const data = await fetchServerFirst({
          path: `${buildTenantApiPath(subdomain, '/media')}?limit=${MEDIA_LIST_LIMIT}`,
          schema: MediaListResponseSchema,
        });
        return data.items.map(toMediaItemResponse);
      },
    },
  ]);

  const folders = queryClient.getQueryData(tenant.media.folders) as
    | Array<{ id: string }>
    | undefined;
  const initialCurrentFolderId =
    requestedFolder && folders?.some((folder) => folder.id === requestedFolder)
      ? requestedFolder
      : null;

  return (
    <DataHydration state={dehydratedState}>
      <MediaLibraryExplorer
        subdomain={subdomain}
        initialCurrentFolderId={initialCurrentFolderId}
      />
    </DataHydration>
  );
}
