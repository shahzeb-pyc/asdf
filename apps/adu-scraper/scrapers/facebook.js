import { FACEBOOK_CONFIG, SCRAPER_CONFIG } from '../config.js';

// Timings carried over from the logged-in sweep (2026-11-15, proven
// live: 777 unique IDs / 14,681 NEW rows across 5 pages, no
// checkpoint): the page needs a few seconds after load before the
// grid appears, and each scroll needs time for the next batch.
const NAVIGATION_TIMEOUT_MS = 60000;
const LOAD_SETTLE_MS = 5000;
const GRID_WAIT_TIMEOUT_MS = 30000;
const SCROLL_SETTLE_MS = 3000;
const WHEEL_SETTLE_MS = 1500;

// Strip leading/trailing slashes without a regex (Sonar S8786 flagged
// the regex form): plain string trims, with internal slashes preserved
// exactly as before.
function normalizeUsername(username) {
    let normalizedUsername = (username || '').trim();
    while (normalizedUsername.startsWith('/')) normalizedUsername = normalizedUsername.slice(1);
    while (normalizedUsername.endsWith('/')) normalizedUsername = normalizedUsername.slice(0, -1);
    return normalizedUsername;
}

/**
 * Extracts the numeric reel ID from a /reel/ href. Facebook reel IDs
 * are numeric; non-numeric /reel/ hrefs are not reels and are ignored.
 * @param {string} href
 * @returns {string | null} The numeric ID, or null when there is none.
 */
export function extractReelId(href) {
    const match = (href || '').match(/\/reel\/(\d+)/);
    return match ? match[1] : null;
}

// All /reel/ hrefs currently in the DOM (raw hrefs — extraction and
// dedupe happen in Node, so they stay unit-testable).
async function collectReelHrefs(page) {
    return page.evaluate(() => {
        const hrefs = [];
        const links = document.querySelectorAll('a[href*="/reel/"]');
        for (const a of links) {
            hrefs.push(a.href || a.getAttribute('href') || '');
        }
        return hrefs;
    });
}

/**
 * Session gate (spec scraper-fb-loggedin-route req 2): is the Facebook
 * session in this shared-browser tab live? Reads only — it never logs
 * in, never fills a form, never clicks anything.
 * @param {import("puppeteer").Page} page - The shared logged-in page.
 * @returns {Promise<'ok' | 'checkpoint' | 'loginwall' | 'unavailable' | 'unknown'>}
 * 'checkpoint' = identity checkpoint / "confirm it's you";
 * 'loginwall' = logged out, on the login page or facing a login form;
 * 'unavailable' = the page itself says the content isn't available
 * (a dead source, not an account problem); 'unknown' = the probe
 * itself failed, so the session cannot be verified.
 */
export async function checkFacebookSessionState(page) {
    try {
        return await page.evaluate(() => {
            // facebookSessionState probe — the marker string below is
            // how the unit tests dispatch this evaluate call.
            const url = window.location.href;
            const text = document.body ? document.body.innerText || '' : '';
            if (url.includes('/checkpoint/') || /couldn't confirm your identity|confirm it's you|we need to confirm/i.test(text)) {
                return 'checkpoint';
            }
            const hasLoginForm = !!document.querySelector('#email');
            if (url.includes('/login') || (hasLoginForm && /log in to facebook/i.test(text))) {
                return 'loginwall';
            }
            if (/this content isn't available|content isn't available/i.test(text)) {
                return 'unavailable';
            }
            return 'ok';
        });
    } catch (error) {
        console.warn('[facebook] session-state probe failed:', error.message);
        return 'unknown';
    }
}

// The reels page the run navigated to — a logged-out session is
// redirected to /login or the home page (or drops to the profile
// picker), so a URL that is no longer the reels page is itself a
// session failure, even when the state probe says 'ok'.
function isStillOnReelsPage(currentUrl, normalizedUsername) {
    const expectedPath = `facebook.com/${normalizedUsername}/reels`;
    const actualPath = (currentUrl || '')
        .replace(/^https?:\/\/(www\.)?/, '')
        .split(/[?#]/)[0]
        .replace(/\/$/, '');
    return actualPath === expectedPath;
}

// Logs the session failure loudly and returns null: the caller marks
// the config error. Never a silent empty success.
function failSession(sessionState, username) {
    if (sessionState === 'checkpoint' || sessionState === 'loginwall') {
        console.error(`❌ Facebook session is ${sessionState} for ${username} — not logged in; the scraper NEVER logs in, NEVER enters credentials, NEVER clicks through a checkpoint. Mark the config error.`);
    } else if (sessionState === 'unavailable') {
        console.error(`❌ Facebook page is unavailable for ${username} ("content isn't available") — dead source.`);
    } else {
        console.error(`❌ Facebook session state could not be verified for ${username} (probe returned ${sessionState}) — failing loud, mark the config error.`);
    }
    return null;
}

/**
 * Scrapes Facebook reels from a profile/page in the shared logged-in
 * Puppeteer browser — the testable core of scrapeFacebookProfile.
 * The page is a worker tab of the scraper's own headed browser, whose
 * persistent profile holds the logged-in Facebook session. No second
 * Chrome, no Patchright, no login of any kind: a dead or checkpointed
 * session fails loudly (null) instead of discovering logged-out.
 * @param {import("puppeteer").Page} page - The shared logged-in page.
 * @param {string} username - Facebook page/account username.
 * @returns {Promise<{uniqueLinks: string[]} | null>} Numeric reel IDs
 * in first-seen order, or null on loud failure (session dead /
 * checkpointed, navigation timeout, grid never rendered, 0 reels,
 * unexpected exception).
 */
export async function scrapeFacebookProfileFromPage(page, username) {
    const normalizedUsername = normalizeUsername(username);
    const reelsUrl = `https://facebook.com/${normalizedUsername}/reels`;

    console.log(`📍 Navigating to Facebook Reels (logged in): ${reelsUrl}`);
    try {
        await page.goto(reelsUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    } catch (error) {
        console.error(`❌ Facebook navigation failed for ${reelsUrl}:`, error);
        return null;
    }
    await page.waitForTimeout(LOAD_SETTLE_MS);

    // Session gate, before any discovery: a dead session must fail
    // loudly here, never discover logged-out.
    const sessionState = await checkFacebookSessionState(page);
    if (sessionState !== 'ok') {
        return failSession(sessionState, normalizedUsername);
    }
    let currentUrl = '';
    try {
        currentUrl = page.url();
    } catch (error) {
        console.warn('[facebook] could not read the current URL:', error.message);
    }
    if (currentUrl && !isStillOnReelsPage(currentUrl, normalizedUsername)) {
        console.error(`❌ Facebook left the reels page for ${normalizedUsername} (now at ${currentUrl}) — session may have dropped to the profile picker; never clicking through, mark the config error.`);
        return null;
    }

    // Wait for the reels grid: at least one /reel/ link.
    try {
        await page.waitForSelector('a[href*="/reel/"]', { timeout: GRID_WAIT_TIMEOUT_MS });
    } catch (error) {
        // The grid never rendered — re-check the session before
        // calling it a page problem: a checkpoint can appear late.
        const lateState = await checkFacebookSessionState(page);
        if (lateState !== 'ok') {
            return failSession(lateState, normalizedUsername);
        }
        console.error(`❌ Facebook reels grid never rendered for ${reelsUrl} (no /reel/ link within 30s):`, error);
        return null;
    }
    console.log(`✅ Facebook reels grid rendered for ${normalizedUsername}`);

    try {
        const uniqueLinks = new Set();
        const collect = async () => {
            const hrefs = await collectReelHrefs(page);
            for (const href of hrefs) {
                const id = extractReelId(href);
                if (id) uniqueLinks.add(id);
            }
        };

        await collect();
        console.log(`[facebook] initial reels: ${uniqueLinks.size}`);

        let stalls = 0;
        let scrolls = 0;
        while (uniqueLinks.size < SCRAPER_CONFIG.MAX_REELS_PER_PLATFORM) {
            const before = uniqueLinks.size;
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(SCROLL_SETTLE_MS);
            // A mouse-wheel nudge, which some infinite-scroll handlers
            // listen for instead of a raw scrollTo.
            try {
                await page.mouse.wheel(0, 1200);
            } catch (error) {
                console.warn('[facebook] mouse-wheel nudge failed:', error.message);
            }
            await page.waitForTimeout(WHEEL_SETTLE_MS);
            // The session can die mid-scroll — re-gate after every
            // scroll, before collecting, so a checkpoint never yields
            // a half-logged-in batch.
            const midState = await checkFacebookSessionState(page);
            if (midState !== 'ok') {
                return failSession(midState, normalizedUsername);
            }
            await collect();
            scrolls += 1;
            console.log(`[facebook] scroll ${scrolls}: ${before} -> ${uniqueLinks.size} reels`);
            if (uniqueLinks.size >= SCRAPER_CONFIG.MAX_REELS_PER_PLATFORM) {
                console.log(`[facebook] reel cap reached: ${SCRAPER_CONFIG.MAX_REELS_PER_PLATFORM} — stopping`);
                break;
            }
            if (uniqueLinks.size === before) {
                stalls += 1;
                if (stalls >= FACEBOOK_CONFIG.STALL_LIMIT) {
                    console.log(`[facebook] no new reels for ${FACEBOOK_CONFIG.STALL_LIMIT} consecutive scrolls — stopping (found ${uniqueLinks.size} after ${scrolls} scrolls)`);
                    break;
                }
            } else {
                stalls = 0;
            }
        }

        if (uniqueLinks.size === 0) {
            console.error(`❌ Facebook discovery found 0 reels for ${normalizedUsername} (grid rendered but empty)`);
            return null;
        }
        return { uniqueLinks: Array.from(uniqueLinks).slice(0, SCRAPER_CONFIG.MAX_REELS_PER_PLATFORM) };
    } catch (error) {
        console.error(`❌ Facebook scraping error for ${normalizedUsername}:`, error);
        return null;
    }
}

/**
 * Scrapes Facebook reels from a profile/page in the shared logged-in
 * browser. The page is a worker tab of the scraper's own headed
 * Puppeteer browser — this function never launches its own browser
 * and never logs in.
 * @param {import("puppeteer").Page} page - The shared logged-in page.
 * @param {string} username - Facebook page/account username.
 * @returns {Promise<{uniqueLinks: string[]} | null>} Scraped data.
 */
export async function scrapeFacebookProfile(page, username) {
    return scrapeFacebookProfileFromPage(page, username);
}
