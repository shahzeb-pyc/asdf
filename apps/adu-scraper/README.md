# ADU Reels Scraper Service

Discovers short-form content IDs for ADU source configs and upserts them into `public.adu_reels` (`status = pending`). Runs on a VPS as a long-lived Node process (PM2 recommended).

Ported from the old fbuploadpro service (`backend_v3/services/facebook/auto-download-upload/scraping/reels-scraper`). The discovery method is exactly the old one; only the table names changed (`pages` → `adu_configs`, `reels` → `adu_reels`). The one addition over the old service: the paid TikWM `/user/info` API is the PRIMARY TikTok discovery path — it resolves the profile ID (`secUid`) for one `tiktokuser:` direct attempt, and only when that whole paid path fails do the yt-dlp profile-URL attempts run as backup (see step 1); no third-party *download* API is used anywhere in discovery. TikTok `pending` jobs run on a parallel worker pool of 2 (see "Job polling"); the main loop's `pending` rotation excludes TikTok while the pool runs. The one departure: YouTube discovery moved from the logged-in browser to the official YouTube Data API v3 (spec 154) — no browser, no login; see `discovery/youtube-api.js`. The second departure: Facebook discovery moved from the logged-in Puppeteer browser to its own no-login Patchright headless-shell session per job (spec 158) — no manual Facebook login anymore; see `scrapers/facebook.js`.

## Two-stage discovery

1. **TikWM-first, yt-dlp backup (TikTok only)** — the paid TikWM `/user/info` API runs FIRST (`discovery/tikwm.js`, keys from `TIKWMAPI_KEYS_SCRAPER`, comma-separated, round-robin start, no proxy): it resolves the camelCase `secUid` and attempts the `tiktokuser:{secUid}` direct feed once, exactly as the old Countik path did. Only when that whole paid path fails (lookup failure or direct-attempt failure) does the backup run: the plain profile URL `https://www.tiktok.com/@{handle}` through the rotating proxy (`COUNTIK_PROXY_URL` from env), retried up to **5 times per claim** (2s delay between attempts) — each attempt draws a different rotating proxy exit IP, which is what decides success when an exit IP is blocked (empty response / TLS EOF). No Countik anywhere in discovery: no secuid Worker call, no direct Countik fallback. When `TIKWMAPI_KEYS_SCRAPER` is unset the primary is disabled (one loud ERROR at startup, one warning per claim) and discovery runs on the backup alone. A yt-dlp attempt that exits non-zero can still carry usable IDs on stdout — those partial IDs are recovered (see `discovery/ytdlp.js`). Mobile iPhone UA + full `Sec-Fetch-*` headers (see `discovery/ytdlp-args.js`), `--retries 5`, `--extractor-retries 10`, `--socket-timeout 30`, proxy from `DATACENTER_PROXY` / `PROXY_URL` / `HTTP_PROXY` / `HTTPS_PROXY` when set (the `COUNTIK_PROXY_URL` proxy is passed explicitly by the discovery code, never read from env by the argv builder). Yields video IDs only; "new" is set difference against stored IDs (upsert `onConflict: 'config_id,source_reel_id'`, duplicates ignored).
2. **Puppeteer (Instagram, and TikTok fallback)** — scrolls profile pages using logged-in sessions (persistent profile, manual login at startup).
3. **Patchright headless shell (Facebook only, spec 158)** — no login, no cookies, no session: each Facebook job launches its own `chrome-headless-shell` session, opens `facebook.com/{user}/reels`, dismisses the "See more on Facebook" login dialog whenever it appears (real click when it has a Close control, otherwise the overlay is hidden at its topmost div — never removed), scrolls until 5 consecutive scrolls yield no new reels, and returns numeric reel IDs only. A login form sitting in the DOM is not a failure — failure is navigation timeout, grid never rendered, or 0 reels.
4. **YouTube Data API v3 (YouTube only, spec 154)** — `channels.list` resolves the handle to a channel ID (cached on the config, so repeat checks skip it), `playlistItems.list` walks the uploads playlist newest first, `videos.list` durations keep Shorts only (at most 60 seconds at any date, or at most 180 seconds when published on or after 15 Oct 2024). Never `search.list`. Quota exhaustion parks the source until the next midnight Pacific reset and retries it automatically (spec 156), never to a browser fallback. Key from `YOUTUBE_DATA_API_KEY`.

```text
pending ──claim──► processing
  ├─ tiktok: TikWM primary ──► synced (direct attempt found IDs)
  │          └─ paid path fails ──► yt-dlp profile backup (up to 5) ──► synced
  │                                  └─ fail ──► error (TikTok goes to error, not browser_pending — old code)
  ├─ youtube: Data API ──► synced | error | quota_parked (never browser_pending)
  ├─ instagram/facebook: browser ──► synced | error
browser_pending ──claim──► processing ──► browser ──► synced | error

stuck processing (>1h) ──► pending (reset_stuck_adu_configs)
```

Terminal page states: **`synced`** and **`error`**. Scheduling still requires `synced`.

## Requirements — this cannot run in Vercel or the Cloudflare Worker

- A persistent host (Ubuntu VPS, as the old setup) with a display-capable session for the first manual login. Puppeteer launches with `headless: false`, `--no-sandbox`, `--start-maximized`. Facebook needs no display and no manual login (Patchright headless shell, spec 158).
- Node.js 18+
- **yt-dlp** on `PATH` (or `python3 -m yt_dlp` fallback)
- Chromium via Puppeteer
- Headless shell for Facebook discovery (spec 158): `npx patchright install chromium --only-shell` (once, on the host). To use an existing headless-shell binary instead of Patchright's bundled one, set `FACEBOOK_HEADLESS_SHELL_PATH`.
- Supabase service role credentials

## Job polling (`index.js`)

Infinite loop:

1. Re-queue quota-parked YouTube sources whose retry time passed (spec 156).
2. Rotate platforms (TikTok excluded — see below); call `get_next_pending_adu_config(p_platform)` until a row is claimed (`sync_status → processing`).
3. If none, call `get_next_browser_pending_adu_config(p_platform)` for browser fallbacks (TikTok included here — its browser fallback still uses the shared Puppeteer page on the main loop).
4. If none, sleep **60 seconds**.

TikTok `pending` jobs are claimed by a parallel worker pool (`tiktok-pool.js`, `TIKTOK_CONCURRENCY` workers, default 2 — measured on the old VPS: nproc 2, 1034 MB free, 2026-11-12): each worker claims via the same `get_next_pending_adu_config` RPC scoped to `p_platform='tiktok'`, runs the TikTok-only path (TikWM-first discovery → upsert + synced, or mark error), never touches the browser page, and never increments the 500-job counter. When no TikTok `pending` row exists a worker sleeps 30s before the next claim. On shutdown the pool stops claiming and lets in-flight jobs finish their upsert/mark step.

Browser restarts after **500** jobs per session (`MAX_JOBS_PER_SESSION`).

At startup (unless `SKIP_STARTUP_LOGINS=true`) the browser opens each platform's login page in turn and waits for a human to press Enter after logging in manually: TikTok `https://www.tiktok.com/login`, Instagram `https://www.instagram.com/accounts/login/`. Facebook has no login step (spec 158 — no-login Patchright discovery) and YouTube needs no login (Data API). The logged-in session persists in `BROWSER_USER_DATA_DIR` (default `.browser-profile`).

## Platform behavior

| Platform | `pending` claim | `browser_pending` claim |
|----------|-----------------|-------------------------|
| TikTok | TikWM primary → yt-dlp profile backup, on the pool → `synced` or `error` | Puppeteer only |
| YouTube | Data API → `synced`, `error`, or `quota_parked` until the next midnight Pacific reset (never browser) | Data API |
| Instagram | Puppeteer only | Puppeteer only |
| Facebook | Patchright, no login (spec 158) | Patchright, no login (spec 158) |

TikTok yt-dlp profile URL: `https://www.tiktok.com/@{handle}` (leading `@` stripped).
Browser scrapers, verbatim from the old service: TikTok `//a[contains(@href, "/video/")]`, Instagram `https://www.instagram.com/{user}/reels/` with `//a[contains(@href, "/reel/")]`. Both scroll with a 2s pause, stop after 44 unchanged heights, cap `MAX_REELS_PER_PLATFORM` (default `1000`). Facebook (spec 158, rewritten, no login): `https://facebook.com/{user}/reels` with `a[href*="/reel/"]`, numeric IDs only, scrolls until 5 consecutive scrolls yield no new reels, cap `MAX_REELS_PER_PLATFORM` (default `1000`). YouTube no longer has a browser scraper (Data API, spec 154).

## Configuration (`config.js` / `.env`)

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin key (bypasses RLS) |
| `BROWSER_USER_DATA_DIR` | Persistent Puppeteer profile |
| `BROWSER_USER_AGENT` | Puppeteer User-Agent |
| `MAX_REELS_PER_PLATFORM` | Cap per discovery run (default `1000`) |
| `FACEBOOK_HEADLESS_SHELL_PATH` | Optional path to a headless-shell executable for Facebook discovery (spec 158); unset = Patchright's bundled shell |
| `SKIP_STARTUP_LOGINS` | Skip interactive login prompts when `true` |
| `YTDLP_BIN` | yt-dlp binary (default `yt-dlp`) |
| `YTDLP_TIMEOUT_MS` | Subprocess timeout (default `600000`) |
| `COUNTIK_PROXY_URL` | Rotating HTTP proxy for TikTok discovery: the yt-dlp profile-URL backup attempts (up to 5 per claim) go through it; downloads never use it |
| `TIKWMAPI_KEYS_SCRAPER` | Paid TikWM API keys (comma-separated) for the TikTok PRIMARY, used first on every TikTok claim; separate from the shared `TIKWMAPI_KEYS`, which the scraper never reads |
| `TIKTOK_CONCURRENCY` | TikTok pool worker count (default `2`, clamped 1–4; non-numeric logs a loud warning and defaults to 2) |
| `YOUTUBE_DATA_API_KEY` | YouTube Data API v3 key for YouTube discovery (spec 154); discovery fails loudly without it; the key is never logged |

## Database RPCs (migration `supabase/migrations/20261030130000_adu_claim_rpc.sql`)

- `get_next_pending_adu_config` — claims `sync_status = pending`
- `get_next_browser_pending_adu_config` — claims `sync_status = browser_pending`
- `reset_stuck_adu_configs` — `processing` → `pending` when stuck >1h

## Modules

- `discovery/youtube-api.js` — YouTube Data API v3 discovery (resolve, list, Shorts filter; tests) — key from `YOUTUBE_DATA_API_KEY`, never `search.list`
- `discovery/ytdlp.js` — TikTok yt-dlp discovery (`execFile`, JSON parse): TikWM-first order + partial-IDs recovery from failed attempts + profile-URL backup (up to 5 attempts)
- `discovery/tikwm.js` — paid TikWM `/user/info` secUid lookup, the TikTok PRIMARY (keys from `TIKWMAPI_KEYS_SCRAPER` only, direct, redacted, round-robin start under concurrency)
- `tiktok-pool.js` — TikTok `pending` worker pool (injected deps, no side effects on import, node builtins only)
- `jobs.js` — the single implementation of `upsertReelsAndMarkSynced` / `markSyncStatus`, shared by the main loop and the pool
- `discovery/ytdlp-args.js` — argv builder (aligned with old `video_downloader/scraper.py`)
- `discovery/profile-urls.js` — TikTok profile URL + platform gate
- `discovery/extract-ids.js` — shared JSON ID helpers (tests)
- `scrapers/*.js` — Puppeteer per platform (Instagram, TikTok); Facebook is Patchright, no login (spec 158)

## Running

```bash
npm install
cp .env.example .env
npm start
```

## Tests

```bash
npm test
npm run lint
```

## Deploying

Install Chromium dependencies and **yt-dlp** on the VPS. Supervise with PM2. The downloader (`apps/adu-downloader`) is the sibling service on the same host; the web app and the Cloudflare Worker never run this code.
