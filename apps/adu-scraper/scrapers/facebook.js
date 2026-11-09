import { chromium } from 'patchright';
import { FACEBOOK_CONFIG, SCRAPER_CONFIG } from '../config.js';

// Spike-proven timings (fb-reels-spike-patchright, commit 7a30088):
// the page needs a few seconds after load before the grid appears,
// and each scroll needs time for the next batch to load.
const NAVIGATION_TIMEOUT_MS = 60000;
const LOAD_SETTLE_MS = 5000;
const GRID_WAIT_TIMEOUT_MS = 30000;
const SCROLL_SETTLE_MS = 3000;
const WHEEL_SETTLE_MS = 1500;
const DISMISS_SETTLE_MS = 1200;
const DIALOG_CLICK_TIMEOUT_MS = 2000;

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

// The "See more on Facebook" login dialog that blocks scrolling. It
// can appear AFTER scrolling starts, not just at page load — so it is
// checked and dismissed before AND after every scroll. NEVER log in:
// no email/password is ever filled, the form is never submitted — the
// dialog is only ever closed (variant A) or hidden (variant B).
// A dialog that has been HIDDEN counts as GONE, not present: hiding
// leaves the form in the DOM, so a pure DOM-presence check would keep
// reporting the dialog forever. Visibility is checked up the ancestor
// chain (a hidden top div hides everything inside it).
async function detectLoginDialog(page) {
    return page.evaluate(() => {
        const isEffectivelyVisible = (el) => {
            let cur = el;
            while (cur) {
                const cs = getComputedStyle(cur);
                if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
                cur = cur.parentElement;
            }
            return true;
        };
        const form = document.querySelector('#login_popup_cta_form');
        const dialog = document.querySelector('[aria-modal="true"][role="dialog"]');
        const formVisible = form ? isEffectivelyVisible(form) : false;
        const dialogVisible = dialog ? isEffectivelyVisible(dialog) : false;
        const dialogText = dialogVisible ? (dialog.innerText || '') : '';
        const seesMore = dialogText.includes('See more on Facebook');
        const closeInDialog = dialogVisible
            ? !!dialog.querySelector('[aria-label="Close"], [aria-label="close"]')
            : false;
        return {
            present: formVisible || (dialogVisible && seesMore),
            closeInDialog,
        };
    }).catch((error) => {
        console.warn('[facebook] login-dialog probe failed, treating as absent:', error.message);
        return { present: false, closeInDialog: false };
    });
}

// HIDE the login overlay at its TOPMOST div — do NOT remove it.
// Removing only the dialog node leaves the wrappers in the DOM and the
// page stays faded; REMOVING the top div is worse — it clears the fade
// and collapses the page (scrollHeight 900 -> 0, CNN 40 reels instead
// of 50) because that div carries page layout as well as the dim layer.
// So: `visibility: hidden` keeps the element's layout box,
// `pointer-events: none` stops it intercepting scrolls or clicks.
// Climb rule (safety first): start at the dialog, keep going to
// parentElement while the parent (a) is a DIV, (b) is not body/html,
// and (c) contains NO a[href*="/reel/"] links anywhere inside it — so
// the reels grid can never be hidden. Never touches the login form's
// inputs and never submits it.
async function hideTopOverlayDiv(page) {
    return page.evaluate(() => {
        const form = document.querySelector('#login_popup_cta_form');
        const dialog = form
            ? form.closest('[aria-modal="true"][role="dialog"]')
            : document.querySelector('[aria-modal="true"][role="dialog"]');
        const start = dialog || form;
        if (!start) {
            return { hidden: 0, levelsClimbed: 0 };
        }
        let top = start;
        let levels = 0;
        let cur = start;
        while (cur.parentElement) {
            const parent = cur.parentElement;
            if (parent.tagName !== 'DIV') break;
            if (parent === document.body || parent === document.documentElement) break;
            if (parent.querySelector('a[href*="/reel/"]')) break;
            top = parent;
            levels++;
            cur = parent;
        }
        // HIDE, do not remove: visibility:hidden keeps the layout box,
        // pointer-events:none stops the overlay intercepting scrolls/clicks.
        top.style.visibility = 'hidden';
        top.style.pointerEvents = 'none';
        // The modal locks page scroll while it is up — release it.
        if (document.body) {
            document.body.style.overflow = '';
            document.body.style.position = '';
        }
        if (document.documentElement) document.documentElement.style.overflow = '';
        return { hidden: 1, levelsClimbed: levels };
    }).catch((error) => {
        console.warn('[facebook] top-overlay hide failed:', error.message);
        return { hidden: 0, levelsClimbed: 0 };
    });
}

async function pressEscape(page) {
    try {
        await page.keyboard.press('Escape');
    } catch (error) {
        console.warn('[facebook] Escape key press failed (dialog may still be open):', error.message);
    }
}

// Dismiss the login dialog if it is present. Variant A (Close control
// present): real click on the dialog's Close control, then in-page
// click, then Escape, then top-div hiding as the last resort.
// Variant B (no Close control at all): go straight to HIDING the
// overlay at its topmost div — clicking is pointless with no control.
// Returns { seen, dismissed, stillPresent }: when the dialog is still
// present after all attempts, the scroll counts as blocked and the
// stall rule stops the run instead of spinning forever.
async function dismissLoginDialog(page) {
    const probe = await detectLoginDialog(page);
    if (!probe.present) {
        // No login dialog — best-effort generic dismiss (e.g. a "Not
        // now" overlay at page load). No wait if nothing is there.
        const clicked = await page.evaluate(() => {
            const closeByLabel = document.querySelector(
                '[aria-label="Close"], [aria-label="close"], [aria-label="Dismiss"]',
            );
            if (closeByLabel) { closeByLabel.click(); return 'aria-label Close'; }
            const buttons = Array.from(document.querySelectorAll('button, [role="button"], div[role="button"]'));
            for (const b of buttons) {
                const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
                if (/^(Close|Not now|No thanks)$/i.test(t)) { b.click(); return t; }
            }
            return null;
        }).catch((error) => {
            // A failed generic-dismiss probe is not fatal — the dialog
            // re-probe below decides whether scrolling is blocked — but
            // it is never swallowed silently.
            console.warn('[facebook] generic overlay dismiss probe failed:', error.message);
            return null;
        });
        if (clicked) {
            console.log(`[facebook] dismissed generic overlay via: ${clicked}`);
            await pressEscape(page);
            await page.waitForTimeout(DISMISS_SETTLE_MS);
            return { seen: false, dismissed: true, stillPresent: false };
        }
        return { seen: false, dismissed: false, stillPresent: false };
    }

    const variant = probe.closeInDialog ? 'A (with Close)' : 'B (no Close)';
    console.log(`[facebook] login dialog present, variant ${variant} — dismissing`);

    // Re-probe, and if the dialog is gone record the dismiss.
    // detectLoginDialog is visibility-aware, so a HIDDEN dialog counts
    // as gone even though its form stays in the DOM.
    const gone = async (method) => {
        const after = await detectLoginDialog(page);
        if (!after.present) {
            console.log(`[facebook] login dialog dismissed via ${method}`);
            return { seen: true, dismissed: true, stillPresent: false, method };
        }
        return null;
    };

    // Variant B has NO Close button, so clicking is pointless — go
    // straight to HIDING the overlay at its TOPMOST div.
    if (!probe.closeInDialog) {
        const hidden = await hideTopOverlayDiv(page);
        if (hidden.hidden > 0) {
            await page.waitForTimeout(DISMISS_SETTLE_MS);
            const done = await gone('hid top overlay div (visibility:hidden + pointer-events:none, variant B, no Close)');
            if (done) return done;
        }
        await pressEscape(page);
        await page.waitForTimeout(DISMISS_SETTLE_MS);
        const done = await gone('Escape after top-div hide');
        if (done) return done;
        // The page may re-render the dialog — try hiding it once more.
        const hiddenAgain = await hideTopOverlayDiv(page);
        if (hiddenAgain.hidden > 0) {
            await page.waitForTimeout(DISMISS_SETTLE_MS);
            const done2 = await gone('hid top overlay div, 2nd attempt');
            if (done2) return done2;
        }
        console.error('[facebook] login dialog (variant B) STILL PRESENT after top-div hide — scrolling is blocked');
        return { seen: true, dismissed: false, stillPresent: true };
    }

    // Variant A (with Close): real click on the dialog's Close control.
    const closeSelectors = [
        '[aria-modal="true"][role="dialog"] [aria-label="Close"]',
        '[aria-modal="true"][role="dialog"] [aria-label="close"]',
        '#login_popup_cta_form [aria-label="Close"]',
        '[aria-label="Close"]',
    ];
    let method = null;
    for (const sel of closeSelectors) {
        try {
            await page.click(sel, { timeout: DIALOG_CLICK_TIMEOUT_MS });
            method = `real click: ${sel}`;
            break;
        } catch (error) {
            // Selector not present/clickable — try the next one. A miss
            // here is a probe, not a failure: the dialog may simply
            // use a different Close control.
            continue;
        }
    }
    if (method) {
        await page.waitForTimeout(DISMISS_SETTLE_MS);
        const done = await gone(method);
        if (done) return done;
    }

    // Fall back to an in-page click on the dialog's Close control.
    const evalClicked = await page.evaluate(() => {
        const dialog = document.querySelector('[aria-modal="true"][role="dialog"]');
        const scope = dialog || document;
        const closeBtn = scope.querySelector('[aria-label="Close"], [aria-label="close"]');
        if (closeBtn) { closeBtn.click(); return 'evaluate click: dialog Close'; }
        return null;
    }).catch((error) => {
        console.warn('[facebook] in-page dialog Close click failed:', error.message);
        return null;
    });
    if (evalClicked) {
        await page.waitForTimeout(DISMISS_SETTLE_MS);
        const done = await gone(evalClicked);
        if (done) return done;
    }

    // Escape, then top-div hiding as the last resort.
    await pressEscape(page);
    await page.waitForTimeout(DISMISS_SETTLE_MS);
    let done = await gone('Escape');
    if (done) return done;
    const hidden = await hideTopOverlayDiv(page);
    if (hidden.hidden > 0) {
        await page.waitForTimeout(DISMISS_SETTLE_MS);
        done = await gone('hid top overlay div (variant A fallback)');
        if (done) return done;
    }

    console.error('[facebook] login dialog STILL PRESENT after all dismiss attempts — scrolling is blocked');
    return { seen: true, dismissed: false, stillPresent: true };
}

// Snapshot of the page state when scrolling stalls, so a stall can be
// diagnosed from the daemon log instead of guessed at: is the login
// dialog up, how many /reel/ links exist, how far the page has
// scrolled, and how tall the page is. A login form sitting in the DOM
// is NOT a failure signal — only a visible dialog blocking the scroll
// is reported here.
async function diagnoseStall(page) {
    return page.evaluate(() => {
        const isEffectivelyVisible = (el) => {
            let cur = el;
            while (cur) {
                const cs = getComputedStyle(cur);
                if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
                cur = cur.parentElement;
            }
            return true;
        };
        const form = document.querySelector('#login_popup_cta_form');
        const dialog = document.querySelector('[aria-modal="true"][role="dialog"]');
        const formVisible = form ? isEffectivelyVisible(form) : false;
        const dialogVisible = dialog ? isEffectivelyVisible(dialog) : false;
        const dialogText = dialogVisible ? (dialog.innerText || '') : '';
        return {
            dialogPresent: formVisible || (dialogVisible && dialogText.includes('See more on Facebook')),
            reelLinksInDom: document.querySelectorAll('a[href*="/reel/"]').length,
            scrollY: Math.round(window.scrollY || 0),
            scrollHeight: Math.round(document.body ? document.body.scrollHeight : 0),
            innerHeight: Math.round(window.innerHeight || 0),
        };
    }).catch((error) => {
        console.warn('[facebook] stall diagnosis failed:', error.message);
        return null;
    });
}

/**
 * Scrapes Facebook reels from a profile/page on an already-open
 * Patchright page — the testable core of scrapeFacebookProfile.
 * No login, no cookies, no saved session: the page is logged out.
 * @param {import("patchright").Page} page - The Patchright page.
 * @param {string} username - Facebook page/account username.
 * @returns {Promise<{uniqueLinks: string[]} | null>} Numeric reel IDs
 * in first-seen order, or null on loud failure (navigation timeout,
 * grid never rendered, 0 reels, unexpected exception).
 */
export async function scrapeFacebookProfileFromPage(page, username) {
    const normalizedUsername = normalizeUsername(username);
    const reelsUrl = `https://facebook.com/${normalizedUsername}/reels`;

    console.log(`📍 Navigating to Facebook Reels (no login): ${reelsUrl}`);
    try {
        await page.goto(reelsUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    } catch (error) {
        console.error(`❌ Facebook navigation failed for ${reelsUrl}:`, error);
        return null;
    }
    await page.waitForTimeout(LOAD_SETTLE_MS);

    // The dialog can already be up at page load — dismiss it before
    // waiting for the grid, so it cannot hide the first batch.
    await dismissLoginDialog(page);

    // Wait for the reels grid: at least one /reel/ link. Failure is
    // "grid never rendered" — a login form sitting in the DOM does NOT
    // mean the content was blocked.
    try {
        await page.waitForSelector('a[href*="/reel/"]', { timeout: GRID_WAIT_TIMEOUT_MS });
    } catch (error) {
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
            // The login dialog can appear mid-scroll and block the page
            // behind it, so dismiss it BEFORE each scroll attempt…
            const preScroll = await dismissLoginDialog(page);
            let blockedThisScroll = preScroll.stillPresent;
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
            // …and AFTER every scroll, before collecting, in case it
            // popped up while the new batch was loading.
            const postScroll = await dismissLoginDialog(page);
            if (postScroll.stillPresent) blockedThisScroll = true;
            if (blockedThisScroll) {
                console.log('[facebook] scroll blocked: login dialog still present after dismiss');
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
                    console.log(`[facebook] no new reels for ${FACEBOOK_CONFIG.STALL_LIMIT} consecutive scrolls — stopping`);
                    const diagnosis = await diagnoseStall(page);
                    if (diagnosis) console.log(`[facebook] stall diagnosis: ${JSON.stringify(diagnosis)}`);
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
 * Scrapes Facebook reels from a profile/page with no login at all:
 * owns its own Patchright headless-shell session per job (launch →
 * fresh context → scrape → close in finally).
 * @param {string} username - Facebook page/account username.
 * @returns {Promise<{uniqueLinks: string[]} | null>} Scraped data.
 */
export async function scrapeFacebookProfile(username) {
    let browser = null;
    try {
        browser = await chromium.launch({
            headless: true,
            ...(FACEBOOK_CONFIG.EXECUTABLE_PATH ? { executablePath: FACEBOOK_CONFIG.EXECUTABLE_PATH } : {}),
            args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        });
        const context = await browser.newContext({
            viewport: { width: 1280, height: 900 },
            locale: 'en-US',
            timezoneId: 'Asia/Karachi',
        });
        const page = await context.newPage();
        return await scrapeFacebookProfileFromPage(page, username);
    } catch (error) {
        console.error(`❌ Facebook browser launch failed for ${username}:`, error);
        return null;
    } finally {
        if (browser) {
            await browser.close().catch((error) => {
                console.error('❌ Failed to close Facebook browser:', error);
            });
        }
    }
}
