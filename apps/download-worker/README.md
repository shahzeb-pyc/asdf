# Download consumer Worker (spec 149, Cloudflare backend revision)

A Cloudflare Worker that turns submitted download jobs into files in
the Media Library. One deployment, three entry points:

- `fetch()` — `POST /enqueue` only. The web app's best-effort bridge
  (Next.js has no Queue binding): the web route inserts job rows,
  then posts `{ jobIds }` with a shared-secret header. The Worker
  re-reads each job row and only enqueues jobs still `queued`.
- `queue()` — the `download-jobs` consumer and the
  `download-jobs-dlq` consumer. The consumer claims via the
  `claim_download_jobs` RPC (atomic, at most 3 active jobs per user),
  streams each claimed job to R2 through the R2 binding in 8 MB
  multipart parts, and updates the same Supabase job rows the tray
  polls. The jobs table is the tray's single source of truth; the
  Queue is delivery only, never a second source of truth.
- `scheduled()` — every 60 seconds: heartbeat upsert
  (`cf-download-consumer`), sweep of queued jobs with free slots,
  and reclaim of jobs with no progress update for 30 minutes
  (checkpoint kept, so the next attempt resumes).

## What it deliberately does NOT do

- No `nodejs_compat` flag. The Worker is Workers-native: global
  `fetch`, `globalThis.crypto`, the R2 binding, no Node APIs, no
  AWS SDK, no filesystem, no long-lived process, no polling loop.
- No mock fallback: a missing R2 binding or missing secret fails
  loudly at entry, never silently pretends to save files.
- No Durable Object consumer, no admin dashboard, no WebDAV, no MCP,
  no shares. Those were evaluated and rejected (see the backend
  spec); only chunked multipart streaming was borrowed as an idea.

## How a job flows

1. Web inserts `media_download_jobs` rows (`queued`) and notifies
   `/enqueue` (best-effort; a failure still returns 201 and the Cron
   sweeper picks the job up within a minute).
2. Consumer claims via RPC, writes `pending_media_id` to the row
   before any byte streams, resolves the link (built-in resolvers,
   optional external extractor), and streams to R2.
3. Every completed part writes its ETag to the job row (checkpoint).
   A re-claimed job resumes the same multipart upload with a
   `Range` request; a Range-refusing source restarts once from
   byte 0 in the same attempt.
4. On success the media row is inserted with `pending_media_id`
   (`ON CONFLICT DO NOTHING` — a retry can never create a second
   library copy) and the job is marked `done`, checkpoint cleared.
5. On failure the job is marked `failed` with its error code
   (`UNSAFE_URL`, `UNSUPPORTED_MEDIA`, `FILE_TOO_LARGE`,
   `DOWNLOAD_FAILED`); terminal failures clear the checkpoint,
   transient ones keep it. After 5 attempts the checkpoint is
   cleared and the job stays failed. After Queue retries exhaust,
   the DLQ consumer marks unresolved jobs failed.
6. Cancel is checked before work, between parts (after every
   uploaded part the row is re-read), and after resolve. A
   cancelled row is never overwritten by a failure, and partial
   uploads are aborted.

## Run / deploy (operator steps, not done by the PR)

```sh
# Contracts must be built first (the Worker imports its dist build).
pnpm --filter @fbuploadpro/contracts build
pnpm --filter @fbuploadpro/download-worker build
pnpm --filter @fbuploadpro/download-worker test
```

Deploy with wrangler (configuration in `wrangler.toml` — Worker,
Queue, DLQ, Cron trigger, R2 binding; no secrets in that file):

```sh
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put DOWNLOAD_ENQUEUE_SECRET
wrangler deploy
```

Then set the web app's server-only env vars (never `NEXT_PUBLIC_`):
`DOWNLOAD_CONSUMER_URL` (the Worker `/enqueue` URL) and
`DOWNLOAD_ENQUEUE_SECRET` (same value as the Worker secret), plus
`R2_PUBLIC_URL` as a Worker var (the public host serving the media
bucket — the SAME bucket the web app already serves media from, or
finished files will not be visible in the library).

Supabase migrations, in order, applied to the target database with a
separate go-ahead (never by the PR itself): the existing
`20261025120000` claim migration, then the new
`20261030120000` checkpoint migration.

## Layout

- `src/index.ts` — entry points + env validation (fail loud).
- `src/consumer.ts` — Queue + DLQ message handling.
- `src/process-job.ts` — the job-state machine (claim → resolve →
  stream → insert → done/failed/cancelled).
- `src/store.ts` — Supabase JobStore over fetch (15 s bound).
- `src/r2-sink.ts` — R2-binding multipart sink + storage service.
- `src/heartbeat.ts` — Cron heartbeat / sweep / stale reclaim.
- `src/engine/` — Worker-side streaming only (`stream.ts` +
  `index.ts` orchestrator). The resolvers/mime/extractors/http/errors
  engine is NOT copied here: it lives once in the shared package
  `packages/downloader-engine/` (canonical location, imported by both
  this Worker and the web app's `apps/web/src/lib/media-downloader/`
  orchestrator). Behaviour changes go in the package, never in a
  Worker-local copy — there must be no second copy to drift. The web
  orchestrator's Node-only pieces (presigned sink, `node:crypto`,
  `process.env`) stay web-side and are not part of the package.
