/**
 * ADU reels scraper — ported from the old fbuploadpro service
 * (backend_v3/services/facebook/auto-download-upload/scraping/reels-scraper).
 *
 * Discovery is EXACTLY the old method, unchanged except for the table
 * names, which are the new app's ADU tables:
 * - old `pages` (one row per Facebook Page + source + schedule) is now
 *   `adu_configs` (linked to a unified `destinations` row);
 * - old `reels` (page_id, reel_id) is now `adu_reels`
 *   (config_id, source_reel_id).
 * Everything else — yt-dlp-first TikTok discovery via Countik sec_uid,
 * Puppeteer logged-in fallback / only path for YouTube, Instagram and
 * Facebook, the pending -> processing -> synced | error |
 * browser_pending state machine, the 60s idle sleep, the 500-job
 * browser restart, the manual startup logins — is the old code.
 * No third-party download API anywhere in discovery (discovery
 * never used one; the old downloader's third-party TikTok stream
 * is removed in the downloader, not here).
 *
 * This CANNOT run in Vercel or the Cloudflare Worker: it needs a
 * persistent host with yt-dlp on PATH and a logged-in Chromium
 * profile (see README.md). It talks to Supabase with the service
 * role key only.
 */
import puppeteer from 'puppeteer';
import { supabase } from './db.js';
import { loginToInstagram, scrapeInstagramProfile } from './scrapers/instagram.js';
import { loginToTikTok, scrapeTikTokProfile } from './scrapers/tiktok.js';
import { loginToYouTube, scrapeYoutubeChannel } from './scrapers/youtube.js';
import { loginToFacebook, scrapeFacebookProfile } from './scrapers/facebook.js';
import { BROWSER_CONFIG, LOGIN_CONFIG, SCRAPER_CONFIG } from './config.js';
import { supportsYtdlpDiscovery } from './discovery/profile-urls.js';
import { discoverReelIdsWithYtdlp } from './discovery/ytdlp.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Graceful shutdown (Sonar S2189): the daemon loop used to be
// `while (true)` with no exit condition. It now runs until a SIGTERM
// or SIGINT asks it to stop (PM2 sends SIGINT on restart), and the
// 60s idle wait is interruptible in 1s steps so shutdown is prompt
// instead of waiting out a full minute. jobsProcessed is still reset
// in launchOrRestartBrowser on a session restart, as before.
let shutdownRequested = false;
process.once('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down after the current job...');
  shutdownRequested = true;
});
process.once('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down after the current job...');
  shutdownRequested = true;
});
async function interruptibleSleep(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (shutdownRequested) return;
    await sleep(Math.min(1000, deadline - Date.now()));
  }
}

function cleanSourceUsername(sourcePlatform, sourceUsername) {
  if (!sourceUsername) return '';
  
  let cleaned = sourceUsername.trim();
  
  // Handle leading @ if it exists (e.g. @https://... or @username)
  if (cleaned.startsWith('@')) {
    cleaned = cleaned.substring(1).trim();
  }
  
  // Clean internal whitespaces if it's not a URL
  const isUrl = cleaned.includes('http') || cleaned.includes('.');
  if (!isUrl) {
    cleaned = cleaned.replace(/\s/g, '');
  }

  try {
    // If it looks like a URL or has domain components, try to parse it
    if (isUrl) {
      const urlString = cleaned.startsWith('http') ? cleaned : 'https://' + cleaned;
      const url = new URL(urlString);
      
      if (sourcePlatform === 'facebook') {
        if (url.searchParams.has('id')) {
          return url.searchParams.get('id') || '';
        }
        let pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length > 1 && ['people', 'pages', 'groups', 'profile'].includes(pathParts[0].toLowerCase())) {
          pathParts.shift();
        }
        if (pathParts[0]) {
          return pathParts[0];
        }
      } else if (sourcePlatform === 'instagram') {
        let pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts[0]) {
          return pathParts[0];
        }
      } else if (sourcePlatform === 'tiktok') {
        let pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts[0]) {
          return pathParts[0].replace(/^@+/, '');
        }
      } else if (sourcePlatform === 'youtube') {
        let pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length > 1 && ['c', 'channel', 'user'].includes(pathParts[0].toLowerCase())) {
          pathParts.shift();
        }
        if (pathParts[0]) {
          return pathParts[0].replace(/^@+/, '');
        }
      }
    }
  } catch (e) {
    // Fall back to text parsing if URL parsing fails
  }

  // Text-based fallback (e.g. "username/shorts" or "@username")
  const slashParts = cleaned.split('/');
  const firstSegment = slashParts[0] || cleaned;
  
  return firstSegment.replace(/\s/g, '').replace(/^@+/, '');
}


const PLATFORM_HANDLERS = {
  instagram: {
    login: loginToInstagram,
    scrape: scrapeInstagramProfile,
  },
  tiktok: {
    login: loginToTikTok,
    scrape: scrapeTikTokProfile,
  },
  youtube: {
    login: loginToYouTube,
    scrape: scrapeYoutubeChannel,
  },
  facebook: {
    login: loginToFacebook,
    scrape: scrapeFacebookProfile,
  },
};

const PLATFORM_ORDER = Object.keys(PLATFORM_HANDLERS);

const CLAIM_RPC = {
  pending: 'get_next_pending_adu_config',
  browser_pending: 'get_next_browser_pending_adu_config',
};

async function applyDetectionHardening(page) {
  await page.setUserAgent(BROWSER_CONFIG.USER_AGENT);
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Linux x86_64' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
  });
}

async function upsertReelsAndMarkSynced(job, platform, ids) {
  const reelsToInsert = ids.map((id) => ({
    config_id: job.id,
    source_reel_id: id,
    status: 'pending',
  }));

  const { error: insertError } = await supabase
    .from('adu_reels')
    .upsert(reelsToInsert, { onConflict: 'config_id,source_reel_id', ignoreDuplicates: true });

  if (insertError) {
    throw insertError;
  }

  const { error: updateError } = await supabase
    .from('adu_configs')
    .update({ sync_status: 'synced' })
    .eq('id', job.id);

  if (updateError) {
    throw updateError;
  }
}

async function markSyncStatus(configId, syncStatus) {
  const { error } = await supabase.from('adu_configs').update({ sync_status: syncStatus }).eq('id', configId);
  if (error) {
    throw error;
  }
}

async function claimNextJob(claimSource, platformRotationStart) {
  const orderedPlatforms = PLATFORM_ORDER.map((_, idx) => (
    PLATFORM_ORDER[(platformRotationStart + idx) % PLATFORM_ORDER.length]
  ));

  const rpcName = CLAIM_RPC[claimSource];

  for (const platform of orderedPlatforms) {
    const { data: pages, error } = await supabase.rpc(rpcName, { p_platform: platform });

    if (error) {
      console.error(`❌ RPC Error [${claimSource}/${platform}]:`, error);
      continue;
    }

    if (pages && pages.length > 0) {
      return { job: pages[0], platform, claimSource };
    }
  }

  return null;
}

async function scrapeWithBrowser(page, platform, sourceUsername) {
  const handlers = PLATFORM_HANDLERS[platform];
  if (!handlers) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const scrapedData = await handlers.scrape(page, sourceUsername);
  if (!scrapedData?.uniqueLinks?.length) {
    return null;
  }

  return scrapedData.uniqueLinks;
}

async function runYtdlpDiscovery(platform, sourceUsername) {
  return discoverReelIdsWithYtdlp(
    platform,
    sourceUsername,
    SCRAPER_CONFIG.MAX_REELS_PER_PLATFORM,
  );
}

async function processJob(page, job, platform, claimSource) {
  const cleanUsername = cleanSourceUsername(platform, job.source_username);
  if (cleanUsername !== job.source_username) {
    console.log(`🧹 Normalizing legacy source_username in database: "${job.source_username}" -> "${cleanUsername}"`);
    const { error: updateError } = await supabase
      .from('adu_configs')
      .update({ source_username: cleanUsername })
      .eq('id', job.id);
    if (updateError) {
      console.error(`❌ Failed to update normalized source_username:`, updateError);
    }
    job.source_username = cleanUsername;
  }

  const label = `[${claimSource} → ${platform}] ${job.source_username}`;
  console.log(`🎬 Processing ${label}`);


  if (claimSource === 'browser_pending') {
    const browserIds = await scrapeWithBrowser(page, platform, job.source_username);
    if (browserIds?.length) {
      console.log(`✅ Browser scraped ${browserIds.length} item(s).`);
      await upsertReelsAndMarkSynced(job, platform, browserIds);
      console.log(`💾 Synced ${job.source_username} (browser fallback).`);
      return;
    }

    console.warn(`⚠️ Browser fallback found no items for ${job.source_username}.`);
    await markSyncStatus(job.id, 'error');
    return;
  }

  // claimSource === 'pending'
  if (supportsYtdlpDiscovery(platform)) {
    const ytdlpResult = await runYtdlpDiscovery(platform, job.source_username);

    if (ytdlpResult.ok) {
      await upsertReelsAndMarkSynced(job, platform, ytdlpResult.ids);
      console.log(`💾 Synced ${job.source_username} (yt-dlp).`);
      return;
    }

    if (platform === 'tiktok') {
      console.warn(
        `⚠️ yt-dlp discovery failed for TikTok user ${job.source_username} (${ytdlpResult.reason}); marking as error.`,
      );
      await markSyncStatus(job.id, 'error');
    } else {
      console.warn(
        `⚠️ yt-dlp discovery failed for ${job.source_username} (${ytdlpResult.reason}); queueing browser fallback.`,
      );
      await markSyncStatus(job.id, 'browser_pending');
    }
    return;
  }

  const browserIds = await scrapeWithBrowser(page, platform, job.source_username);
  if (browserIds?.length) {
    console.log(`✅ Browser scraped ${browserIds.length} item(s).`);
    await upsertReelsAndMarkSynced(job, platform, browserIds);
    console.log(`💾 Synced ${job.source_username} (browser).`);
    return;
  }

  console.warn(`⚠️ No items found for ${job.source_username}.`);
  await markSyncStatus(job.id, 'error');
}

async function getActivePage(b, existingPage) {
  try {
    if (existingPage && !existingPage.isClosed()) {
      await existingPage.evaluate(() => true);
      return existingPage;
    }
  } catch (_) {
    try {
      if (existingPage && !existingPage.isClosed()) {
        await existingPage.close().catch(() => {});
      }
    } catch (_) {}
  }
  const newPage = await b.newPage();
  await applyDetectionHardening(newPage);
  return newPage;
}

async function main() {
  console.log('🚀 Starting Multi-Platform Scraper Orchestrator (yt-dlp + browser)...');

  let browser = null;
  let page = null;
  let jobsProcessed = 0;
  const maxJobsPerSession = 500;
  let nextPlatformIndex = 0;

  async function verifyDatabaseConnection() {
    console.log('🩺 Checking database connection...');
    const { error } = await supabase.from('adu_configs').select('id').limit(1);
    if (error) {
      throw new Error(`Database connection check failed: ${error.message}`);
    }
    console.log('✅ Database connection is healthy.');
  }

  async function launchOrRestartBrowser() {
    if (browser) {
      console.log('♻️  Closing old browser instance...');
      await browser.close();
    }
    console.log('🌏 Launching new browser instance...');
    const launchOptions = {
      headless: false,
      defaultViewport: null,
      userDataDir: BROWSER_CONFIG.USER_DATA_DIR,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--start-maximized',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--lang=en-US,en',
      ],
    };

    if (BROWSER_CONFIG.EXECUTABLE_PATH) {
      console.log(`🧭 Using custom browser binary: ${BROWSER_CONFIG.EXECUTABLE_PATH}`);
      launchOptions.executablePath = BROWSER_CONFIG.EXECUTABLE_PATH;
    }

    if (BROWSER_CONFIG.PROFILE_DIRECTORY) {
      console.log(`👤 Using browser profile directory: ${BROWSER_CONFIG.PROFILE_DIRECTORY}`);
      launchOptions.args.push(`--profile-directory=${BROWSER_CONFIG.PROFILE_DIRECTORY}`);
    }

    browser = await puppeteer.launch(launchOptions);

    page = await browser.newPage();
    await applyDetectionHardening(page);

    try {
      if (LOGIN_CONFIG.SKIP_STARTUP_LOGINS) {
        console.log('⏭️  SKIP_STARTUP_LOGINS=true, skipping manual login prompts for all platforms.');
      } else {
        for (const [platform, handlers] of Object.entries(PLATFORM_HANDLERS)) {
          page = await getActivePage(browser, page);
          await handlers.login(page);

          const readline = (await import('readline')).createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          await new Promise((resolve) => {
            readline.question(`👉 Press Enter AFTER you have successfully logged in to ${platform}...`, () => {
              readline.close();
              resolve();
            });
          });

          console.log(`✅ ${platform} login step completed.`);
        }
      }

      console.log(`🗂️ Session profile path: ${BROWSER_CONFIG.USER_DATA_DIR}`);
      console.log('✅ Proceeding after manual login checks for all platforms.');
    } catch (e) {
      console.error('❌ Initial platform login setup failed:', e);
    } finally {
      page = await getActivePage(browser, page);
    }

    jobsProcessed = 0;
  }

  try {
    await verifyDatabaseConnection();
  } catch (error) {
    console.error('❌ Startup aborted:', error);
    process.exit(1);
  }

  await launchOrRestartBrowser();

  while (!shutdownRequested) {
    if (jobsProcessed >= maxJobsPerSession) {
      console.log('🚀 Reached session limit. Restarting browser...');
      await launchOrRestartBrowser();
    }

    console.log('\n--------------------------------------------------');
    console.log('🔄 Checking for next scrape job (pending, then browser_pending)...');

    const rotationStart = nextPlatformIndex;
    nextPlatformIndex = (nextPlatformIndex + 1) % PLATFORM_ORDER.length;

    let selection =
      (await claimNextJob('pending', rotationStart)) ||
      (await claimNextJob('browser_pending', rotationStart));

    if (!selection) {
      console.log('✅ No pending or browser_pending pages. Waiting 60s...');
      await interruptibleSleep(60000);
      continue;
    }

    const { job, platform, claimSource } = selection;

    try {
      page = await getActivePage(browser, page);
      await processJob(page, job, platform, claimSource);
      jobsProcessed += 1;
    } catch (err) {
      console.error(`❌ Error processing ${job.source_username}:`, err);

      if (claimSource === 'pending' && supportsYtdlpDiscovery(platform) && platform !== 'tiktok') {
        try {
          await markSyncStatus(job.id, 'browser_pending');
        } catch (markErr) {
          console.error('❌ Failed to mark browser_pending after error:', markErr);
        }
      } else {
        try {
          await markSyncStatus(job.id, 'error');
        } catch (markErr) {
          console.error('❌ Failed to mark error after failure:', markErr);
        }
      }

      await sleep(5000);
    }
  }
}

// Awaited with a rejection handler (Sonar S9383): an unhandled
// rejection here used to be silently dropped by the runtime.
main().catch((error) => {
  console.error('❌ Scraper daemon failed:', error);
  process.exit(1);
});
