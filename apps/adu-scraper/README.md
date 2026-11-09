# ADU Reels Scraper Service

Discovers short-form content IDs for ADU source configs and upserts them into `public.adu_reels` (`status = pending`). Runs on a VPS as a long-lived Node process (PM2 recommended).

Ported from the old fbuploadpro service (`backend_v3/services/facebook/auto-download-upload/scraping/reels-scraper`). The discovery method is exactly the old one; only the table names changed (`pages` → `adu_configs`, `reels` → `adu_reels`). The one addition over the old service: when all yt-dlp profile attempts fail, the paid TikWM `/user/info` API resolves the profile ID (`secUid`) for one `tiktokuser:` direct attempt (see step 1); no third-party *download* API is used anywhere in discovery. The one departure: YouTube discovery moved from the logged-in browser to the official YouTube Data API v3 (spec 154) — no browser, no login; see `discovery/youtube-api.js`.

## Two-stage discovery

1. **yt-dlp (TikTok only)** — flat-playlist extract with `--playlist-items`.
   yt-dlp only: the plain profile URL `https://www.tiktok.com/@{handle}` goes through the rotating proxy (`COUNTIK_PROXY_URL` from env), so yt-dlp resolves the `sec_uid` itself from the profile page. The profile attempt is retried up to **5 times per claim** (2s delay between attempts) — each attempt draws a different rotating proxy exit IP, which is what decides success when an exit IP is blocked (empty response / TLS EOF). Only when all 5 fail, the paid TikWM `/user/info` fallback runs (`discovery/tikwm.js`, keys from `TIKWMAPI_KEYS_SCRAPER`, comma-separated, tried in order, no proxy): it resolves the camelCase `secUid` and attempts the `tiktokuser:{secUid}` direct feed once, exactly as the old Countik path did. No Countik anywhere in discovery: no secuid Worker call, no direct Countik fallback. When `TIKWMAPI_KEYS_SCRAPER` is unset the fallback is disabled (one loud warning at startup) and discovery stays yt-dlp-only. Mobile iPhone UA + full `Sec-Fetch-*` headers (see `discovery/ytdlp-args.js`), `--retries 5`, `--extractor-retries 10`, `--socket-timeout 30`, proxy from `DATACENTER_PROXY` / `PROXY_URL` / `HTTP_PROXY` / `HTTPS_PROXY` when set (the `COUNTIK_PROXY_URL` proxy is passed explicitly by the discovery code, never read from env by the argv builder). Yields video IDs only; "new" is set difference against stored IDs (upsert `onConflict: 'config_id,source_reel_id'`, duplicates ignored).
2. **Puppeteer (Instagram/Facebook, and TikTok fallback)** — scrolls profile pages using logged-in sessions (persistent profile, manual login at startup).
3. **YouTube Data API v3 (YouTube only, spec 154)** — `channels.list` resolves the handle to a channel ID (cached on the config, so repeat checks skip it), `playlistItems.list` walks the uploads playlist newest first, `videos.list` durations keep Shorts only (at most 60 seconds at any date, or at most 180 seconds when published on or after 15 Oct 2024). Never `search.list`. Quota exhaustion fails loudly to `error`, never to a browser fallback. Key from `YOUTUBE_DATA_API_KEY`.

```text
pending ──claim──► processing
  ├─ tiktok: yt-dlp ──► synced (IDs found)
  │          └─ all 5 fail ──► TikWM secUid fallback ──► synced (direct attempt found IDs)
  │                                  └─ fail ──► error (TikTok goes to error, not browser_pending — old code)
  ├─ youtube: Data API ──► synced | error (never browser_pending)
  ├─ instagram/facebook: browser ──► synced | error
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

At startup (unless `SKIP_STARTUP_LOGINS=true`) the browser opens each platform's login page in turn and waits for a human to press Enter after logging in manually: TikTok `https://www.tiktok.com/login`, Instagram `https://www.instagram.com/accounts/login/`, Facebook `https://www.facebook.com/login`. YouTube needs no login (Data API). The logged-in session persists in `BROWSER_USER_DATA_DIR` (default `.browser-profile`).

## Platform behavior

| Platform | `pending` claim | `browser_pending` claim |
|----------|-----------------|-------------------------|
| TikTok | yt-dlp → `synced` or `error` | Puppeteer only |
| YouTube | Data API → `synced` or `error` (never browser) | Data API |
| Instagram | Puppeteer only | Puppeteer only |
| Facebook | Puppeteer only | Puppeteer only |

TikTok yt-dlp profile URL: `https://www.tiktok.com/@{handle}` (leading `@` stripped).
Browser scrapers, verbatim from the old service: TikTok `//a[contains(@href, "/video/")]`, Instagram `https://www.instagram.com/{user}/reels/` with `//a[contains(@href, "/reel/")]`, Facebook `https://facebook.com/{user}/reels` with `//a[@aria-label="Reel tile preview"]`. All scroll with a 2s pause, stop after 44 unchanged heights, cap `MAX_REELS_PER_PLATFORM` (default `1000`). YouTube no longer has a browser scraper (Data API, spec 154).

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
| `COUNTIK_PROXY_URL` | Rotating HTTP proxy for TikTok discovery: the yt-dlp profile-URL attempts (up to 5 per claim) go through it; downloads never use it |
| `TIKWMAPI_KEYS_SCRAPER` | Paid TikWM API keys (comma-separated) for the TikTok secUid fallback, used only after all 5 yt-dlp attempts fail; separate from the shared `TIKWMAPI_KEYS`, which the scraper never reads |
| `YOUTUBE_DATA_API_KEY` | YouTube Data API v3 key for YouTube discovery (spec 154); discovery fails loudly without it; the key is never logged |

## Database RPCs (migration `supabase/migrations/20261030130000_adu_claim_rpc.sql`)

- `get_next_pending_adu_config` — claims `sync_status = pending`
- `get_next_browser_pending_adu_config` — claims `sync_status = browser_pending`
- `reset_stuck_adu_configs` — `processing` → `pending` when stuck >1h

## Modules

- `discovery/youtube-api.js` — YouTube Data API v3 discovery (resolve, list, Shorts filter; tests) — key from `YOUTUBE_DATA_API_KEY`, never `search.list`
- `discovery/ytdlp.js` — TikTok yt-dlp discovery (`execFile`, JSON parse) + TikWM fallback after 5 failed profile attempts
- `discovery/tikwm.js` — paid TikWM `/user/info` secUid lookup (keys from `TIKWMAPI_KEYS_SCRAPER` only, direct, redacted)
- `discovery/ytdlp-args.js` — argv builder (aligned with old `video_downloader/scraper.py`)
- `discovery/profile-urls.js` — TikTok profile URL + platform gate
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
