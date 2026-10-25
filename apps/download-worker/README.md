# Download worker (spec 149)

A plain Node service that turns submitted download jobs into files in
the Media Library. It runs on the kept VPS server — **not** on
Cloudflare, and it uses **no queues**: the `media_download_jobs` table
IS the queue.

## How it works

1. Every poll tick: heartbeat upsert, reclaim claims whose worker
   heartbeat went stale, then list users with queued jobs.
2. For each user, claim via the `claim_download_jobs` RPC — atomic,
   `FOR UPDATE SKIP LOCKED`, at most 3 active jobs per user
   (`DOWNLOAD_JOBS_PER_WORKSPACE_CONCURRENCY`). The cap is enforced
   in SQL, never by counting in this process.
3. Each claimed job streams through the web engine
   (`apps/web/src/lib/media-downloader/`, imported — never duplicated)
   into R2 via a multipart sink, so memory stays bounded by one part
   buffer no matter the file size (500 MB cap enforced by the engine,
   up front and mid-stream).
4. On success the worker inserts `media_items` rows and marks the job
   `done`; on failure it marks `failed` with the engine's error code;
   on cancel it leaves the row `cancelled` and deletes partial
   uploads. A retried job never creates a second library copy
   (idempotency is checked on `media_id` before inserting).

## Run

```sh
# Contracts must be built first (the worker imports its dist build).
pnpm --filter @fbuploadpro/contracts build
pnpm --filter @fbuploadpro/download-worker start
```

Dev/preview runs from a branch checkout against the **dev** database
only. The worker never touches production data unless the operator
points it at production credentials.

## Environment

Required (missing values fail boot loudly, listing names only):

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — the worker owns jobs
  for every user, so it uses the service key, never the anon key.
- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_BUCKET_NAME`, `R2_PUBLIC_URL` — same R2 bucket the web app
  serves media from. No mock fallback: without R2 the worker refuses
  to start.

Optional:

- `DOWNLOAD_WORKER_ID` (default `download-worker-<pid>`)
- `DOWNLOAD_WORKER_POLL_INTERVAL_MS` (default `5000`)
- `DOWNLOAD_WORKER_MAX_CONCURRENT_JOBS` (default `12`, the
  process-wide pool; the per-user cap of 3 is separate and absolute)
- `DOWNLOADER_EXTRACTOR_API_URL` (optional external extractor; the
  built-in resolvers run without it)

## Deploy (example)

`download-worker.service` in this folder is an **example** systemd
unit for the VPS server: copy it, set `WorkingDirectory` to the repo
checkout and `EnvironmentFile` to a file only root can read, then
`systemctl enable --now download-worker`. Logs go to the journal
as JSON lines.

## Verification scripts

- `pnpm --filter @fbuploadpro/download-worker verify:claim-race` —
  dev-only: fires parallel `claim_download_jobs` calls for one user
  and asserts the total claimed never exceeds 3. Needs the dev
  service key in the environment; never run against production.
