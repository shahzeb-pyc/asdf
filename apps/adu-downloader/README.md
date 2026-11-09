# ADU Buffer Downloader (Ubuntu VPS Guide)

The downloader service continuously claims pending ADU reels from Supabase, downloads the video in high quality with audio, and uploads it to the Cloudflare R2 buffer.

Ported from the old fbuploadpro service (`backend_v3/services/facebook/auto-download-upload/downloader`). The download method is exactly the old one; only the tables changed (`pages`/`reels` → `adu_configs`/`adu_reels`, uuid ids). TikTok downloads live here now (moved from the Cloudflare Worker `apps/tiktok-downloader` on 2026-11-07 — the Worker failed from its egress on all three steps: tikwm resolve, Countik fallback, and stream fetches; the VPS opens the same links fine). TikTok resolve goes through the owner-supplied rotating resolve proxy (`RESOLVE_PROXY_URL` — resolve + Countik only, never downloads); the video bytes are fetched direct. YouTube downloads go through the Video Download Api first (1080p, merged audio+video, $0.0002/job — spec 157), with a direct yt-dlp fallback and no proxy anywhere on that fallback. No other third-party download API is used in ADU except the tikwm/Countik resolvers for TikTok.

## How it works (old flow, unchanged)

1. Claim: two RPCs, one per side — `claim_tiktok_buffer_downloads(p_limit)` for TikTok configs and `claim_non_tiktok_buffer_downloads(p_limit)` for everything else — only for configs that are `active` + `synced`, `posts_per_day > 0`, with `posts_per_day × 1` day of buffer not yet filled (downloaded + processing count toward the target), skipping configs with >10 `download_failed` reels in the last 24h. Only the lowest-buffered hungry configs are eligible, one reel per config per claim, random tie-break, `FOR UPDATE SKIP LOCKED`. A claimed reel goes `pending → processing`, `download_retries + 1`, `download_claimed_at = now()`. The Cloudflare Worker used to claim TikTok rows; its cron is disabled, so this service is the only TikTok claimant now (migration 20261103150000).
2. Download: TikTok — resolve via tikwm through the resolve proxy (Countik through the same proxy as fallback; no yt-dlp — its TikTok extractor is broken), then direct stream fetch via aria2c (no proxy anywhere on the download path; the aria2c subprocess runs with proxy variables stripped), size check (>10,000 bytes, 1 GiB cap), then `verify_video_has_audio` (ffprobe; a successful ffprobe run with no audio stream fails the reel, an ffprobe failure is inconclusive and accepts). One attempt per claim (the claim budget of 3 is the retry mechanism). Other platforms — per-platform yt-dlp (see `media_download.py`):
   - Instagram: `yt-dlp --dump-single-json` metadata (optional datacenter proxy), then direct CDN fetch via aria2; video + audio muxed with ffmpeg when separate.
   - YouTube: Video Download Api first (`format=1080`, `no_merge=0`,
    `add_info=1` for the title; key `YT_VIDEO_DOWNLOAD_API_KEY`,
    $0.0002/job, charged on acceptance), direct yt-dlp fallback
    (`bv*+ba/b`, `--js-runtimes node` (EJS), no proxy argument,
    proxy-stripped environment, `--ignore-config`) on any API failure;
    missing key fails loudly with no silent yt-dlp substitute. Title
    falls back to yt-dlp metadata when the API gives none. See
    `video_download_api.py` and spec 157.
   - Facebook: yt-dlp `bv*+ba/b`, `b[ext=mp4]/b`, datacenter proxy, `--force-generic-extractor` fallback.
   - All: `--impersonate chrome`, `--retries 1`, `--extractor-retries 2–3`, `--fragment-retries 2–3`, `--socket-timeout 30`, aria2 downloader `-x4 -s4 -k1M`, `--merge-output-format mp4`. Per-video resolve is `yt-dlp --dump-single-json` (no-watermark URL + verbatim description/title as caption, normalized by `caption_utils.py`: empty / generic / ID-like captions become `❤️`).
   - 4 download attempts per claim (`ADU_DOWNLOADER_ATTEMPT_RETRIES`, separate from the DB `download_retries`), 1 GiB max file (`ADU_DOWNLOAD_MAX_BYTES`), local disk cache keyed by source reel id (skips re-download when upload/DB update fails).
3. Upload: stream to R2 bucket `fbuploadpro-adu-buffer` at `adu-buffer/<config_id>/<reel_id>.mp4`, 8 MiB chunks, SHA-256 computed while streaming, content type from the file extension.
4. Mark: `mark_adu_reel_downloaded` stores `media_object_key`, `media_size_bytes`, `media_content_type`, `media_sha256`, caption, `downloaded_at`, and the public `media_url` (`R2_PUBLIC_URL/<key>` — the new app's Facebook publisher fetches that URL at publish time; the old publisher read R2 directly). On failure `mark_adu_reel_download_failed`: while `download_retries < 3` the reel returns to `pending`; at 3 it becomes `download_failed` with `download_failed_at`, and if that config then has >50 `download_failed` reels all-time its status flips to `creator_suspended`.
5. Loop: up to 30 concurrent downloads, in-flight poll 20s, idle sleep 60s, stale `processing` claims (>40 min) reset to `pending` each loop.

## 1. Quick Setup (.env Configuration)

Navigate to the downloader directory on your Ubuntu VPS:

```bash
cd apps/adu-downloader
```

Create your `.env` file from the template:

```bash
cp .env.example .env
nano .env
```

Fill in your Supabase and Cloudflare R2 credentials:

```ini
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key

R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
R2_ADU_BUFFER_BUCKET=fbuploadpro-adu-buffer
R2_PUBLIC_URL=https://<your-r2-public-host>

# TikTok resolve proxy (required for TikTok downloads): the
# owner-supplied rotating residential proxy. Resolve + Countik only —
# video bytes are always fetched direct, never through it. Value lives
# ONLY in this .env (mode 600); never commit or log it.
RESOLVE_PROXY_URL=
```

> **Note:** The `.env` file must be located directly inside the `downloader/` directory (not the repository root). `R2_PUBLIC_URL` is required here (same value as the web app's `R2_PUBLIC_URL`).

## 2. Run with Docker (Recommended)

Docker is the easiest way to run the service on Ubuntu. It packages Python, FFmpeg, aria2, and Node.js automatically, keeps the downloader running 24/7, and restarts automatically on server reboot.

### Start the Service

```bash
chmod +x start.sh
./start.sh
```

*This script installs Docker (if missing), builds the image, launches the container in the background, and tails live logs.*

### Daily Docker Commands

Run these from the `downloader/` directory:

| Action | Command |
| :--- | :--- |
| View live logs | `sudo docker compose logs -f` |
| Check status | `sudo docker compose ps` |
| Restart worker | `sudo docker compose restart` |
| Stop worker | `sudo docker compose down` |
| Update after git pull | `git pull && sudo docker compose up -d --build` |

## 3. Alternative: Run with PM2 (Native Python)

### Step 1: Install System Dependencies

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip ffmpeg aria2 nodejs npm
sudo npm install -g pm2
```

(ffmpeg provides ffprobe for the TikTok audio check; aria2c fetches the
resolved TikTok stream direct. Without them TikTok downloads fail loud
at the audio check / download step — the service still runs for other
platforms.)

### Step 2: Set Up Python Virtual Environment

```bash
cd apps/adu-downloader
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Step 3: Start with PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
# (Run the exact command that the terminal prints out)
```

### Daily PM2 Commands

| Action | Command |
| :--- | :--- |
| View live logs | `pm2 logs fbuploadpro-adu-downloader` |
| Check status | `pm2 status` |
| Restart worker | `pm2 restart fbuploadpro-adu-downloader` |
| Stop worker | `pm2 stop fbuploadpro-adu-downloader` |
| Update after git pull | `git pull && source .venv/bin/activate && pip install -r requirements.txt && pm2 restart fbuploadpro-adu-downloader` |

## 4. Log Files

Rotating logs are saved under `logs/`:

- `logs/adu-downloader.log` — Full operational history
- `logs/adu-downloader.error.log` — Errors and warnings only

## 5. What this service does NOT do

- It does not discover reels — that is the sibling `apps/adu-scraper` service (yt-dlp + Puppeteer, same host).
- It does not schedule or publish — the Cloudflare Worker (`apps/worker`, ADU tick) intakes downloaded reels at schedule slots and publishes them through the existing Facebook reel publisher, which fetches `media_url`.
- It does not run in Vercel or the Cloudflare Worker. It needs a persistent Ubuntu VPS host with Python, ffmpeg, aria2, Node.js, and yt-dlp (Docker image does this; see `Dockerfile`, entrypoint auto-updates yt-dlp to the latest nightly on startup).

## 6. Troubleshooting Checklist

1. **Process crashes or fails on startup:** check the logs, verify `.env` is present and has valid Supabase and R2 keys (including `R2_PUBLIC_URL`).
2. **Docker permission denied:** run with `sudo`, or `sudo usermod -aG docker $USER && newgrp docker`.
3. **Platform extraction updates:** the Docker container automatically updates `yt-dlp` every time it starts. If Instagram, YouTube, or TikTok change their layout, simply restart the container: `sudo docker compose restart`.
