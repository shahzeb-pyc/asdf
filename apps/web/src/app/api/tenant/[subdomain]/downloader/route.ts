import { type NextRequest, NextResponse } from 'next/server';
import {
  CancelDownloadJobRequestSchema,
  DOWNLOAD_CONSUMER_HEALTHY_MINUTES,
  DOWNLOAD_CONSUMER_WORKER_ID,
  DownloadJobActionResponseSchema,
  DownloadJobsStatusResponseSchema,
  RetryDownloadJobRequestSchema,
  SubmitDownloadJobsRequestSchema,
  SubmitDownloadJobsResponseSchema,
  deduplicateBatchUrls,
  detectSourcePlatform,
  isTerminalDownloadErrorCode,
  parseDownloadJobRow,
  type DownloadJob,
  type SessionPayload,
} from '@fbuploadpro/contracts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticateTenantRoute, getRouteSupabase } from '@/lib/route-auth';
import { bodyTooLargeResponse, enforceIpRateLimit, readJsonBody } from '@/lib/request-body';
import { logServerError } from '@/lib/server-analytics';

/**
 * Download jobs API (spec 149). The browser NEVER downloads media
 * itself anymore: POST only validates links and writes job rows, GET
 * reports open jobs for the tray, and retry/cancel mutate job state.
 * The Cloudflare Queue consumer owns resolving, streaming, and
 * library-row creation (backend revision, see
 * specs/149-downloader-rebuild/cloudflare-backend-spec.md).
 * The old single-link ingest path (resolve + upload inside the request)
 * is deleted, not kept alongside this one.
 *
 * Web → Queue bridge (§5): after inserting rows, the route
 * best-effort notifies the consumer Worker's /enqueue endpoint. The
 * notification must NEVER fail a submit: if the Worker is unreachable
 * the route still returns 201 and the Cron sweeper picks the job up
 * within a minute.
 */

const OPEN_JOB_STATUSES = ['queued', 'resolving', 'downloading', 'failed'] as const;
const CANCELLABLE_STATUSES = ['queued', 'resolving', 'downloading', 'processing'] as const;

function supabaseOr500(
  dbClient: SupabaseClient | undefined
): { supabase: SupabaseClient } | { error: NextResponse } {
  const supabase = getRouteSupabase(dbClient);
  if (!supabase) {
    return {
      error: NextResponse.json({ error: 'Database service unavailable' }, { status: 500 }),
    };
  }
  return { supabase };
}

/** Parses rows, skipping (and counting) any that fail validation. */
function toWireJobs(rows: unknown[]): { jobs: DownloadJob[]; skipped: number } {
  const jobs: DownloadJob[] = [];
  let skipped = 0;
  for (const row of rows) {
    const job = parseDownloadJobRow(row);
    if (job) {
      jobs.push(job);
    } else {
      skipped += 1;
    }
  }
  return { jobs, skipped };
}

/**
 * Best-effort /enqueue notification (spec §5). Never throws and
 * never blocks a submit beyond a short timeout: the Cron sweeper is
 * the backstop for any failure here. Server-only env vars, never
 * NEXT_PUBLIC_ — the shared secret must not reach the browser.
 */
async function notifyDownloadConsumer(jobIds: string[], subdomain: string): Promise<void> {
  const consumerUrl = process.env.DOWNLOAD_CONSUMER_URL;
  const secret = process.env.DOWNLOAD_ENQUEUE_SECRET;
  if (!consumerUrl || !secret || jobIds.length === 0) return;
  try {
    let end = consumerUrl.length;
    while (end > 0 && consumerUrl[end - 1] === '/') end -= 1;
    const baseUrl = consumerUrl.slice(0, end);
    const response = await fetch(`${baseUrl}/enqueue`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-download-enqueue-secret': secret,
      },
      body: JSON.stringify({ jobIds }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      logServerError('[downloader] Enqueue notification rejected', new Error(`status ${response.status}`), {
        source: 'downloader-enqueue',
        subdomain,
      });
    }
  } catch (error) {
    logServerError('[downloader] Enqueue notification failed (sweeper will retry)', error, {
      source: 'downloader-enqueue',
      subdomain,
    });
  }
}

/** Consumer health from the Cron heartbeat (§7.1). Undefined = unreadable (unknown, not paused). */
async function readConsumerHealthy(
  supabase: SupabaseClient
): Promise<boolean | undefined> {
  // An unreadable heartbeat is "unknown", not "paused": the caller omits
  // the field and the tray shows no paused banner. Unknown is a distinct
  // outcome, not a swallowed error — the failure is logged, and the
  // catch assigns rather than bare-returning (spec 137 §3.1 ban on
  // bare-catch-return in data code).
  let healthy: boolean | undefined;
  try {
    const { data, error } = await supabase
      .from('download_worker_heartbeats')
      .select('heartbeat_at')
      .eq('worker_id', DOWNLOAD_CONSUMER_WORKER_ID)
      .maybeSingle();
    if (error) {
      healthy = undefined;
    } else if (!data) {
      healthy = false;
    } else {
      const heartbeatAt = (data as { heartbeat_at?: unknown })['heartbeat_at'];
      healthy =
        typeof heartbeatAt === 'string' &&
        Date.now() - new Date(heartbeatAt).getTime() <
          DOWNLOAD_CONSUMER_HEALTHY_MINUTES * 60_000;
    }
  } catch (err: unknown) {
    logServerError('[downloader] Failed to read consumer heartbeat', err, {
      source: 'downloader-heartbeat',
    });
    healthy = undefined;
  }
  return healthy;
}

async function verifyFolderOwnership(
  supabase: SupabaseClient,
  folderId: string | null,
  userId: string
): Promise<boolean> {
  if (folderId === null) return true;
  const { data: folder } = await supabase
    .from('media_folders')
    .select('id')
    .eq('id', folderId)
    .eq('user_id', userId)
    .maybeSingle();
  return Boolean(folder);
}

async function fetchOwnedJob(
  supabase: SupabaseClient,
  jobId: string,
  userId: string
): Promise<{ row: Record<string, unknown> } | { error: NextResponse }> {
  const { data: job, error } = await supabase
    .from('media_download_jobs')
    .select('*')
    .eq('id', jobId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !job) {
    return {
      error: NextResponse.json({ error: 'Job not found' }, { status: 404 }),
    };
  }
  return { row: job as Record<string, unknown> };
}

async function readJobIdBody(
  request: NextRequest,
  schema: typeof RetryDownloadJobRequestSchema | typeof CancelDownloadJobRequestSchema
): Promise<{ jobId: string } | { error: NextResponse }> {
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') {
      return { error: bodyTooLargeResponse() };
    }
    return {
      error: NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'Invalid JSON request payload.' },
        { status: 400 }
      ),
    };
  }
  const parsed = schema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return {
      error: NextResponse.json(
        { error: 'INVALID_REQUEST', message: 'A valid job id is required.' },
        { status: 400 }
      ),
    };
  }
  return { jobId: parsed.data.jobId };
}

export async function handleSubmitDownloadJobs(
  request: NextRequest,
  subdomain: string,
  dbClient?: SupabaseClient
): Promise<NextResponse> {
  const { session, errorResponse } = await authenticateTenantRoute(request, subdomain);
  if (errorResponse) return errorResponse;
  const userId = (session as SessionPayload).userId;

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    if (bodyResult.reason === 'too-large') {
      return bodyTooLargeResponse();
    }
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON request payload.' },
      { status: 400 }
    );
  }
  const parsed = SubmitDownloadJobsRequestSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'Please paste at least one link to save to your Media Library.',
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const { links, folderId } = parsed.data;
  const deduped = deduplicateBatchUrls(links.join('\n'));
  if (deduped.urls.length === 0) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'Please enter at least one valid public link.',
        invalidLinks: deduped.invalidUrls,
      },
      { status: 400 }
    );
  }

  const resolved = supabaseOr500(dbClient);
  if ('error' in resolved) return resolved.error;
  const supabase = resolved.supabase;

  const folderValid = await verifyFolderOwnership(supabase, folderId ?? null, userId);
  if (!folderValid) {
    return NextResponse.json(
      { error: 'FOLDER_NOT_FOUND', message: 'Selected destination folder was not found.' },
      { status: 404 }
    );
  }

  const rowsToInsert = deduped.urls.map((url) => ({
    user_id: userId,
    source_url: url,
    source_platform: detectSourcePlatform(url),
    target_folder_id: folderId ?? null,
    status: 'queued',
    progress_percent: 0,
    total_bytes: null,
    downloaded_bytes: 0,
    media_id: null,
    error_code: null,
    error_message: null,
    attempts: 0,
    claimed_at: null,
    claimed_by: null,
  }));

  const { data: inserted, error: insertErr } = await supabase
    .from('media_download_jobs')
    .insert(rowsToInsert)
    .select('*');

  if (insertErr || !inserted || inserted.length !== rowsToInsert.length) {
    logServerError('[downloader] Failed to enqueue download jobs', insertErr ?? new Error('Insert mismatch'), {
      source: 'downloader-submit',
      subdomain,
    });
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Could not start these downloads right now. Please try again.' },
      { status: 500 }
    );
  }

  const { jobs, skipped } = toWireJobs(inserted);
  if (skipped > 0) {
    logServerError('[downloader] Enqueued jobs failed validation', new Error(`${skipped} rows skipped`), {
      source: 'downloader-submit',
      subdomain,
    });
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: 'Could not start these downloads right now. Please try again.' },
      { status: 500 }
    );
  }

  const payload = SubmitDownloadJobsResponseSchema.parse({
    jobs,
    skippedDuplicates: deduped.duplicateCount,
    invalidLinks: deduped.invalidUrls,
  });
  // Best-effort only: a failed notification never fails the submit.
  await notifyDownloadConsumer(
    jobs.map((job) => job.id),
    subdomain
  );
  return NextResponse.json(payload, { status: 201 });
}

export async function handleGetDownloadJobs(
  request: NextRequest,
  subdomain: string,
  dbClient?: SupabaseClient
): Promise<NextResponse> {
  const { session, errorResponse } = await authenticateTenantRoute(request, subdomain);
  if (errorResponse) return errorResponse;
  const userId = (session as SessionPayload).userId;

  const resolved = supabaseOr500(dbClient);
  if ('error' in resolved) return resolved.error;
  const supabase = resolved.supabase;

  try {
    const { data: rows, error } = await supabase
      .from('media_download_jobs')
      .select('*')
      .eq('user_id', userId)
      .in('status', [...OPEN_JOB_STATUSES])
      .order('created_at', { ascending: true })
      .limit(100);

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch jobs' }, { status: 500 });
    }

    const { jobs, skipped } = toWireJobs(rows ?? []);
    if (skipped > 0) {
      logServerError('[downloader] Job rows failed validation', new Error(`${skipped} rows skipped`), {
        source: 'downloader-jobs',
        subdomain,
      });
    }

    const consumerHealthy = await readConsumerHealthy(supabase);
    const payload = DownloadJobsStatusResponseSchema.parse({
      jobs,
      ...(consumerHealthy !== undefined ? { consumerHealthy } : {}),
    });
    return NextResponse.json(payload, { status: 200 });
  } catch (err: unknown) {
    logServerError('[downloader] Failed to fetch download jobs', err, {
      source: 'downloader-jobs',
      subdomain,
    });
    return NextResponse.json({ error: 'Internal Error' }, { status: 500 });
  }
}

export async function handleRetryDownloadJob(
  request: NextRequest,
  subdomain: string,
  dbClient?: SupabaseClient
): Promise<NextResponse> {
  const { session, errorResponse } = await authenticateTenantRoute(request, subdomain);
  if (errorResponse) return errorResponse;
  const userId = (session as SessionPayload).userId;

  const body = await readJobIdBody(request, RetryDownloadJobRequestSchema);
  if ('error' in body) return body.error;

  const resolved = supabaseOr500(dbClient);
  if ('error' in resolved) return resolved.error;
  const supabase = resolved.supabase;

  const fetched = await fetchOwnedJob(supabase, body.jobId, userId);
  if ('error' in fetched) return fetched.error;
  if (fetched.row['status'] !== 'failed') {
    return NextResponse.json(
      { error: 'JOB_NOT_RETRYABLE', message: 'Only failed downloads can be retried.' },
      { status: 409 }
    );
  }

  // Retry checkpoint rule (§8.1, encoded explicitly): a terminal
  // failure (bad link, unsupported media, over size) can never
  // resume, so its checkpoint is cleared and progress resets. Any
  // other failure keeps its checkpoint — and the progress that goes
  // with it — so the next attempt resumes instead of restarting.
  const terminalFailure = isTerminalDownloadErrorCode(
    typeof fetched.row['error_code'] === 'string' ? fetched.row['error_code'] : null
  );
  const { data: updated, error: updateErr } = await supabase
    .from('media_download_jobs')
    .update({
      status: 'queued',
      error_code: null,
      error_message: null,
      claimed_at: null,
      claimed_by: null,
      ...(terminalFailure
        ? {
            progress_percent: 0,
            downloaded_bytes: 0,
            total_bytes: null,
            r2_upload_id: null,
            checkpoint_parts: [],
            checkpoint_bytes: 0,
            checkpoint_stream_url: null,
            last_progress_at: null,
          }
        : {}),
    })
    .eq('id', body.jobId)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle();

  if (updateErr || !updated) {
    return NextResponse.json({ error: 'Failed to retry job' }, { status: 500 });
  }

  const job = parseDownloadJobRow(updated);
  if (!job) {
    return NextResponse.json({ error: 'Failed to retry job' }, { status: 500 });
  }
  // Best-effort only: a failed notification never fails the retry;
  // the Cron sweeper picks the job up within a minute.
  await notifyDownloadConsumer([job.id], subdomain);
  return NextResponse.json(DownloadJobActionResponseSchema.parse({ job }), { status: 200 });
}

export async function handleCancelDownloadJob(
  request: NextRequest,
  subdomain: string,
  dbClient?: SupabaseClient
): Promise<NextResponse> {
  const { session, errorResponse } = await authenticateTenantRoute(request, subdomain);
  if (errorResponse) return errorResponse;
  const userId = (session as SessionPayload).userId;

  const body = await readJobIdBody(request, CancelDownloadJobRequestSchema);
  if ('error' in body) return body.error;

  const resolved = supabaseOr500(dbClient);
  if ('error' in resolved) return resolved.error;
  const supabase = resolved.supabase;

  const fetched = await fetchOwnedJob(supabase, body.jobId, userId);
  if ('error' in fetched) return fetched.error;
  if (!(CANCELLABLE_STATUSES as readonly string[]).includes(String(fetched.row['status']))) {
    return NextResponse.json(
      { error: 'JOB_NOT_CANCELLABLE', message: 'This download can no longer be cancelled.' },
      { status: 409 }
    );
  }

  const { data: updated, error: updateErr } = await supabase
    .from('media_download_jobs')
    .update({ status: 'cancelled' })
    .eq('id', body.jobId)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle();

  if (updateErr || !updated) {
    return NextResponse.json({ error: 'Failed to cancel job' }, { status: 500 });
  }

  const job = parseDownloadJobRow(updated);
  if (!job) {
    return NextResponse.json({ error: 'Failed to cancel job' }, { status: 500 });
  }
  return NextResponse.json(DownloadJobActionResponseSchema.parse({ job }), { status: 200 });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const limited = await enforceIpRateLimit(request, 'tenant_downloader', 10);
  if (limited) return limited;
  return handleSubmitDownloadJobs(request, subdomain);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  return handleGetDownloadJobs(request, subdomain);
}
