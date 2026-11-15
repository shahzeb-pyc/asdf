// Claim rotation for the ADU scraper main loop (index.js).
//
// Instagram discovery is BLOCKED at the code level — owner order
// 2026-11-16: an Instagram config in `pending` / `browser_pending`
// must never be claimed, no matter how it got there (e.g. a retry/sync
// tap in the UI). It sits in `pending` and the UI shows "Scrape
// pending" — the existing loud behaviour for an unclaimed config.
//
// This is a TEMPORARY stop, not a removal: the Instagram dispatch,
// platform-map entry, scrapers/instagram.js, and its imports all stay
// in place in index.js. To re-enable Instagram discovery, re-add
// 'instagram' to BOTH arrays below (and restore the test expectation
// in claim-rotation.test.js). That is a separate change on the owner's
// word; do not build it now.

// The `browser_pending` rotation: the full platform set, minus
// Instagram (blocked, see above).
export const PLATFORM_ORDER = ['tiktok', 'youtube', 'facebook'];

// The TikTok worker pool (tiktok-pool.js) owns TikTok `pending`
// claims, so the main loop's `pending` rotation EXCLUDES tiktok
// while the pool runs. `browser_pending` keeps the full rotation —
// the TikTok browser fallback still uses the shared Puppeteer page
// on the main loop.
export const PENDING_PLATFORM_ORDER = ['youtube', 'facebook'];
