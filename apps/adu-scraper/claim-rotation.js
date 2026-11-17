// Claim rotation for the ADU scraper main loop (index.js).
//
// Instagram discovery is back in the rotation: it was code-blocked
// (owner order 2026-11-16, PR #270) until the session + proxy issue
// was resolved, and now runs through the dedicated Instagram browser
// behind the single residential proxy (spec
// scraper-ig-residential-proxies). The Instagram dispatch,
// platform-map entry, scrapers/instagram.js, and its imports all stay
// in place in index.js — the block is lifted by re-adding
// 'instagram' to BOTH arrays below.

// The `browser_pending` rotation: the full platform set.
export const PLATFORM_ORDER = ['instagram', 'tiktok', 'youtube', 'facebook'];

// The TikTok worker pool (tiktok-pool.js) owns TikTok `pending`
// claims, so the main loop's `pending` rotation EXCLUDES tiktok
// while the pool runs. `browser_pending` keeps the full rotation —
// the TikTok browser fallback still uses the shared Puppeteer page
// on the main loop.
export const PENDING_PLATFORM_ORDER = ['instagram', 'youtube', 'facebook'];
