# ADU Reels Scraper Service

Discovers short-form content IDs for ADU source configs and upserts them into `public.adu_reels` (`status = pending`). Runs on a VPS as a long-lived Node process (PM2 recommended).

Ported from the old fbuploadpro service (`backend_v3/services/facebook/auto-download-upload/scraping/reels-scraper`). The discovery method is exactly the old one; only the table names changed (`pages` → `adu_configs`, `reels` → `adu_reels`). No third-party download API is used anywhere in discovery.

## Two-stage discovery

1. **yt-dlp (TikTok only)** — flat-playlist extract with `--playlist-items`.
   Resolves the TikTok `sec_uid` first via Countik (`GET https://countik.com/api/exist/<username>`, see `discovery/sec-uid.js`), targets `tiktokuser:{sec_uid}` (mobile feed, bypasses desktop captcha walls), falls back to `https://www.tiktok.com/@{handle}`. Mobile iPhone UA + full `Sec-Fetch-*` headers (see `discovery/ytdlp-args.js`), `--retries 5`, `--extractor-retries 10`, `--socket-timeout 30`, proxy from `DATACENTER_PROXY` / `PROXY_URL` / `HTTP_PROXY` / `HTTPS_PROXY` when set. Yields video IDs only; "new" is set difference against stored IDs (upsert `onConflict: 'config_id,source_reel_id'`, duplicates ignored).
2. **Puppeteer (YouTube + Instagram/Facebook, and TikTok fallback)** — scrolls profile pages using logged-in sessions (persistent profile, manual login at startup).

```text
pending ──claim──► processing
  ├─ tiktok: yt-dlp ──► synced (IDs found)
  │          └─ fail/empty ──► error (TikTok goes to error, not browser_pending — old code)
  ├─ youtube/instagram/facebook: browser ──► synced | error
browser_pending ──claim──► processing ──► browser ──► synced | error

stuck processing (>1h) ──► pending (reset_stuck_adu_configs)
```

Terminal page states: **`synced`** and **`error`**. Scheduling still requires `synced`.

## Requirements — this cannot run in Vercel or the Cloudflare Worker

- A persistent host (Ubuntu VPS, as the old setup) with a display-capable session for the first manual login. Puppeteer launches with `headless: false`, `--no-sandbox`, `--start-maximized`.
- Node.js 18+
- **yt-dlp** on `PATH` (or `python3 -m yt_dlp` fallback)
- Chromium via Puppeteer
- Supabase service role credentials

## Job polling (`index.js`)

Infinite loop:

1. Rotate platforms; call `get_next_pending_adu_config(p_platform)` until a row is claimed (`sync_status → processing`).
2. If none, call `get_next_browser_pending_adu_config(p_platform)` for browser fallbacks.
3. If none, sleep **60 seconds**.

Browser restarts after **500** jobs per session (`MAX_JOBS_PER_SESSION`).

At startup (unless `SKIP_STARTUP_LOGINS=true`) the browser opens each platform's login page in turn and waits for a human to press Enter after logging in manually: TikTok `https://www.tiktok.com/login`, Instagram `https://www.instagram.com/accounts/login/`, YouTube Google ServiceLogin, Facebook `https://www.facebook.com/login`. The logged-in session persists in `BROWSER_USER_DATA_DIR` (default `.browser-profile`).

## Platform behavior

| Platform | `pending` claim | `browser_pending` claim |
|----------|-----------------|-------------------------|
| TikTok | yt-dlp → `synced` or `error` | Puppeteer only |
| YouTube | Puppeteer only | Puppeteer only |
| Instagram | Puppeteer only | Puppeteer only |
| Facebook | Puppeteer only | Puppeteer only |

TikTok yt-dlp profile URL: `https://www.tiktok.com/@{handle}` (leading `@` stripped).
Browser scrapers, verbatim from the old service: TikTok `//a[contains(@href, "/video/")]`, Instagram `https://www.instagram.com/{user}/reels/` with `//a[contains(@href, "/reel/")]`, YouTube `https://www.youtube.com/@{handle}/shorts` with `//a[contains(@href, "/shorts/")]`, Facebook `https://facebook.com/{user}/reels` with `//a[@aria-label="Reel tile preview"]`. All scroll with a 2s pause, stop after 44 unchanged heights, cap `MAX_REELS_PER_PLATFORM` (default `1000`).

## Configuration (`config.js` / `.env`)

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin key (bypasses RLS) |
| `BROWSER_USER_DATA_DIR` | Persistent Puppeteer profile |
| `BROWSER_USER_AGENT` | Puppeteer User-Agent |
| `MAX_REELS_PER_PLATFORM` | Cap per discovery run (default `1000`) |
| `SKIP_STARTUP_LOGINS` | Skip interactive login prompts when `true` |
| `YTDLP_BIN` | yt-dlp binary (default `yt-dlp`) |
| `YTDLP_TIMEOUT_MS` | Subprocess timeout (default `600000`) |

## Database RPCs (migration `supabase/migrations/20261030130000_adu_claim_rpc.sql`)

- `get_next_pending_adu_config` — claims `sync_status = pending`
- `get_next_browser_pending_adu_config` — claims `sync_status = browser_pending`
- `reset_stuck_adu_configs` — `processing` → `pending` when stuck >1h

## Modules

- `discovery/ytdlp.js` — TikTok yt-dlp discovery (`execFile`, JSON parse)
- `discovery/ytdlp-args.js` — argv builder (aligned with old `video_downloader/scraper.py`)
- `discovery/profile-urls.js` — TikTok profile URL + platform gate
- `discovery/sec-uid.js` — Countik `sec_uid` resolver
- `discovery/extract-ids.js` — shared JSON ID helpers (tests)
- `scrapers/*.js` — Puppeteer per platform

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
