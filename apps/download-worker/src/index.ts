import {
  DownloadEnqueueRequestSchema,
  validateSafeRemoteUrl,
  type DownloadQueueMessage,
} from '@fbuploadpro/contracts';
import { handleDlqMessage, handleQueueMessage } from './consumer.js';
import { runCron } from './heartbeat.js';
import { processClaimedJob } from './process-job.js';
import { R2MultipartSink, R2StorageService } from './r2-sink.js';
import { createSupabaseClient, SupabaseJobStore } from './store.js';

/**
 * Download consumer Worker (spec 149, Cloudflare backend revision).
 * One deployment, three entry points:
 * - fetch(): POST /enqueue only — the web app's best-effort bridge
 *   (Next.js has no Queue binding). Signed with a shared secret.
 * - queue(): the download-jobs consumer and the DLQ consumer.
 * - scheduled(): the 60-second Cron trigger (heartbeat + sweep +
 *   stale reclaim).
 *
 * Fail loud, everywhere: a missing R2 binding, missing secrets, or
 * a non-https / private extractor URL is a 500 / boot error, never
 * a silent no-op. There is no mock fallback and no nodejs_compat.
 */

export interface DownloadWorkerEnv {
  MEDIA_BUCKET: R2Bucket;
  DOWNLOAD_QUEUE: Queue<DownloadQueueMessage>;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  DOWNLOAD_ENQUEUE_SECRET: string;
  R2_PUBLIC_URL: string;
  DOWNLOADER_EXTRACTOR_API_URL?: string | undefined;
}

const WORKER_ID = 'cf-download-consumer';

function log(message: string, context?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    service: 'download-consumer',
    message,
    ...(context ?? {}),
  });
  // Workers has no process.stdout; console is the log sink.
  console.log(line);
}

function missingEnv(env: DownloadWorkerEnv): string[] {
  const missing: string[] = [];
  if (!env.MEDIA_BUCKET) missing.push('MEDIA_BUCKET binding');
  if (!env.DOWNLOAD_QUEUE) missing.push('DOWNLOAD_QUEUE binding');
  if (!env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!env.DOWNLOAD_ENQUEUE_SECRET) missing.push('DOWNLOAD_ENQUEUE_SECRET');
  if (!env.R2_PUBLIC_URL) missing.push('R2_PUBLIC_URL');
  return missing;
}

function validateExtractorUrl(url: string | undefined): string | null {
  if (!url || url.trim().length === 0) return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith('https://')) {
    throw new Error('DOWNLOADER_EXTRACTOR_API_URL must be https');
  }
  const check = validateSafeRemoteUrl(trimmed);
  if (!check.valid) {
    throw new Error(`DOWNLOADER_EXTRACTOR_API_URL rejected: ${check.reason ?? 'unsafe URL'}`);
  }
  return trimmed;
}

function buildStore(env: DownloadWorkerEnv): SupabaseJobStore {
  return new SupabaseJobStore(
    createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
  );
}

async function handleEnqueue(request: Request, env: DownloadWorkerEnv): Promise<Response> {
  const missing = missingEnv(env);
  if (missing.length > 0) {
    return new Response(
      JSON.stringify({ error: `Download consumer misconfigured: missing ${missing.join(', ')}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const secret = request.headers.get('x-download-enqueue-secret');
  if (!secret || secret !== env.DOWNLOAD_ENQUEUE_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  let body: unknown;
  try {
    body = (await request.json()) as unknown;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const parsed = DownloadEnqueueRequestSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'Invalid enqueue request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const store = buildStore(env);
  let enqueued = 0;
  for (const jobId of parsed.data.jobIds) {
    try {
      const job = await store.fetchJob(jobId);
      // Only jobs still queued are enqueued: the claim RPC is the
      // gate, and a duplicate trigger is harmless either way.
      if (job && job.status === 'queued') {
        await env.DOWNLOAD_QUEUE.send({ jobId: job.id, userId: job.userId });
        enqueued += 1;
      }
    } catch (error) {
      // One bad job id must not fail the whole enqueue batch.
      log('enqueue job failed', { jobId, error: String(error) });
    }
  }
  return new Response(JSON.stringify({ enqueued }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const worker = {
  async fetch(request: Request, env: DownloadWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/enqueue') {
      return handleEnqueue(request, env);
    }
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async queue(
    batch: MessageBatch<DownloadQueueMessage>,
    env: DownloadWorkerEnv
  ): Promise<void> {
    const missing = missingEnv(env);
    if (missing.length > 0) {
      throw new Error(`Download consumer misconfigured: missing ${missing.join(', ')}`);
    }
    const extractorApiUrl = validateExtractorUrl(env.DOWNLOADER_EXTRACTOR_API_URL);
    const store = buildStore(env);
    const storage = new R2StorageService(env.MEDIA_BUCKET, env.R2_PUBLIC_URL);
    const isDlq = batch.queue === 'download-jobs-dlq';

    // Sequential, per spec §3.2/§5.2: one invocation never fans out
    // into parallel streams (6 connections, 128 MB).
    for (const message of batch.messages) {
      if (isDlq) {
        await handleDlqMessage(message.body, { store, log });
        continue;
      }
      await handleQueueMessage(message.body, {
        store,
        workerId: WORKER_ID,
        processJob: processClaimedJob,
        processDeps: {
          storage,
          createSink: (key, contentType, resume, onPart) =>
            new R2MultipartSink(env.MEDIA_BUCKET, key, contentType, env.R2_PUBLIC_URL, {
              resumeUploadId: resume?.uploadId ?? undefined,
              resumeParts: resume?.parts ?? undefined,
              initialBytes: resume?.initialBytes ?? undefined,
              onPart,
            }),
          extractorApiUrl,
          log,
        },
        log,
      });
    }
  },

  async scheduled(_event: ScheduledEvent, env: DownloadWorkerEnv): Promise<void> {
    const missing = missingEnv(env);
    if (missing.length > 0) {
      throw new Error(`Download consumer misconfigured: missing ${missing.join(', ')}`);
    }
    const store = buildStore(env);
    await runCron({
      store,
      queue: {
        send: (message: DownloadQueueMessage) => env.DOWNLOAD_QUEUE.send(message),
      },
      log,
    });
  },
};

export default worker;
