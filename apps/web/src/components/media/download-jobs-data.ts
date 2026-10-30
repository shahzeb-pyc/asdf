'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { api, buildTenantApiPath } from '@/lib/api';
import { queryKeys } from '@/lib/data/query-keys';
import {
  DownloadJobActionResponseSchema,
  DownloadJobsStatusResponseSchema,
  SubmitDownloadJobsResponseSchema,
  type DownloadJob,
  type SubmitDownloadJobsResponse,
} from '@/lib/api/schemas/downloader';

/**
 * Download jobs data (spec 149). The tray and the dialog share this
 * one query: the tray polls it, the dialog's submit invalidates it,
 * and the retry/cancel mutations invalidate it. The media list is
 * invalidated by the tray (not here) when a job flips to done, so new
 * files appear in the grid without a second invalidation path.
 */

export const DOWNLOAD_JOBS_ACTIVE_POLL_MS = 3000;
export const DOWNLOAD_JOBS_IDLE_POLL_MS = 15000;

export function isDownloadJobActive(job: DownloadJob): boolean {
  return job.status === 'queued' || job.status === 'resolving' || job.status === 'downloading';
}

export function downloadJobsQuery(subdomain: string) {
  const tenant = queryKeys.tenant(subdomain);
  return {
    queryKey: tenant.downloader.jobs,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<{
      jobs: DownloadJob[];
      consumerHealthy?: boolean | undefined;
    }> => {
      const data = await api.get(buildTenantApiPath(subdomain, '/downloader'), {
        schema: DownloadJobsStatusResponseSchema,
        signal,
      });
      return { jobs: data.jobs, consumerHealthy: data.consumerHealthy };
    },
  };
}

export function useDownloadJobs(subdomain: string) {
  const definition = downloadJobsQuery(subdomain);
  return useQuery({
    queryKey: definition.queryKey,
    queryFn: definition.queryFn,
    // Fast while anything runs, slow idle: on return after closing the
    // site the tray still restores promptly, without polling hot
    // forever when nothing is downloading.
    refetchInterval: (query) => {
      const jobs = query.state.data?.jobs;
      const hasActive = jobs?.some(isDownloadJobActive) ?? false;
      return hasActive ? DOWNLOAD_JOBS_ACTIVE_POLL_MS : DOWNLOAD_JOBS_IDLE_POLL_MS;
    },
  });
}

export function invalidateDownloadJobs(
  client: QueryClient,
  subdomain: string
): Promise<void> {
  return client.invalidateQueries({
    queryKey: queryKeys.tenant(subdomain).downloader.jobs,
  });
}

export function useSubmitDownloadJobs(subdomain: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      links: string[];
      folderId: string | null;
    }): Promise<SubmitDownloadJobsResponse> => {
      return api.post(
        buildTenantApiPath(subdomain, '/downloader'),
        { links: input.links, folderId: input.folderId },
        { schema: SubmitDownloadJobsResponseSchema }
      );
    },
    onSuccess: () => invalidateDownloadJobs(client, subdomain),
  });
}

export function useRetryDownloadJob(subdomain: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string): Promise<DownloadJob> => {
      const data = await api.post(
        buildTenantApiPath(subdomain, '/downloader/retry'),
        { jobId },
        { schema: DownloadJobActionResponseSchema }
      );
      return data.job;
    },
    onSuccess: () => invalidateDownloadJobs(client, subdomain),
  });
}

export function useCancelDownloadJob(subdomain: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string): Promise<DownloadJob> => {
      const data = await api.post(
        buildTenantApiPath(subdomain, '/downloader/cancel'),
        { jobId },
        { schema: DownloadJobActionResponseSchema }
      );
      return data.job;
    },
    onSuccess: () => invalidateDownloadJobs(client, subdomain),
  });
}
