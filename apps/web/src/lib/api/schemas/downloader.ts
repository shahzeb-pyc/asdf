/**
 * Downloader resources (spec 149).
 *
 * The contracts package remains the wire truth — these are re-exports,
 * not a second item shape. The browser talks to the jobs API only
 * through the typed client (`api.*` with these schemas).
 */
export {
  CancelDownloadJobRequestSchema,
  DownloadJobActionResponseSchema,
  DownloadJobsStatusResponseSchema,
  DownloadJobSchema,
  RetryDownloadJobRequestSchema,
  SubmitDownloadJobsRequestSchema,
  SubmitDownloadJobsResponseSchema,
  type CancelDownloadJobRequest,
  type DownloadJob,
  type DownloadJobActionResponse,
  type DownloadJobsStatusResponse,
  type RetryDownloadJobRequest,
  type SubmitDownloadJobsRequest,
  type SubmitDownloadJobsResponse,
} from '@fbuploadpro/contracts';
