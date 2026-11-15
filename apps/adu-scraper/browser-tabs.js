// Browser tab discipline (owner order 2026-11-15, spec
// scraper-fb-loggedin-route, corrected 2026-11-15 ~21:38): the shared
// browser holds AT MOST 2 tabs at any time — one blank about:blank
// anchor tab that always stays open, and one worker tab. Every browser
// job (Facebook, Instagram, TikTok browser fallback) runs in the
// worker tab, which is closed when the job ends.
//
// Jobs are NEVER skipped because of tabs. Browser jobs serialize
// through the single worker tab — the scraper's main loop is the only
// caller and it awaits one job at a time, so a job that arrives while
// the worker tab is busy simply waits its turn in the loop; it is
// never dropped. When extra tabs are open, they are RECLAIMED, not
// piled up: an extra tab is navigated to about:blank first (which
// frees that page's memory) and then reused as the worker tab, instead
// of opening a new one. If closing the worker tab after a job fails,
// it is navigated to about:blank and reused for the next job instead.
// The blank anchor tab is never closed, never navigated, never reused
// as a worker tab. Reclaim and reuse are logged loudly, but the job
// always runs.
//
// The anchor is tracked per browser object (below), never by URL
// alone: after a reclaim the worker tab is blank too, so URL alone
// cannot tell anchor and worker apart. The scraper restarts its
// browser every 500 jobs; a new Browser object gets a fresh entry,
// and a closed anchor falls back to the first blank tab.
export const MAX_TABS = 2;

// Anchor tab per browser object. WeakMap so a discarded browser
// (after a restart) drops its entry with no cleanup.
const anchors = new WeakMap();

function safeUrl(page) {
    try {
        return page.url() || '<unknown>';
    } catch {
        return '<unknown>';
    }
}

function isAnchor(page) {
    try {
        return page.url() === 'about:blank';
    } catch {
        return false;
    }
}

// Resolves the anchor for this browser: the tracked tab when it is
// still open, else the first blank tab (which then becomes the tracked
// anchor — e.g. a blanked ex-worker promoted after the anchor died),
// else null.
function resolveAnchor(browser, pages) {
    const stored = anchors.get(browser);
    if (stored && pages.includes(stored)) {
        try {
            if (!stored.isClosed()) {
                return stored;
            }
        } catch {
            // The liveness check failed — fall through to URL search.
        }
    }
    const found = pages.find(isAnchor);
    if (found) {
        anchors.set(browser, found);
    }
    return found || null;
}

// Navigates a tab to about:blank, freeing its page's memory. Returns
// true when the tab is blank afterwards (it may already have been).
async function blankTab(page, log) {
    try {
        if (page.url() === 'about:blank') {
            return true;
        }
    } catch {
        // The URL cannot be read — try the navigation anyway.
    }
    try {
        await page.goto('about:blank');
        return true;
    } catch (error) {
        log.warn(`[browser-tabs] could not navigate tab ${safeUrl(page)} to about:blank:`, error?.message || error);
        return false;
    }
}

/**
 * Opens a worker tab for one browser job — by reclaiming an extra tab
 * when one is open, by opening a fresh tab when the browser holds only
 * the anchor. The blank anchor is kept (opened first if none is
 * open). Returns null ONLY when the browser itself is unusable (tabs
 * cannot be listed, or no tab can be opened at all) — never because
 * of the tab count: a job is never skipped for tabs.
 * @param {import("puppeteer").Browser} browser - The shared browser.
 * @param {Console} [log=console] - Logger (injectable for tests).
 * @returns {Promise<import("puppeteer").Page | null>} The worker tab,
 * or null when the browser itself cannot provide one.
 */
export async function acquireWorkerTab(browser, log = console) {
    let pages;
    try {
        pages = await browser.pages();
    } catch (error) {
        log.error('[browser-tabs] could not list browser tabs:', error?.message || error);
        return null;
    }

    let anchor = resolveAnchor(browser, pages);
    if (!anchor) {
        try {
            anchor = await browser.newPage();
        } catch (error) {
            log.error('[browser-tabs] could not open the blank anchor tab:', error?.message || error);
            return null;
        }
        anchors.set(browser, anchor);
        log.log('[browser-tabs] opened blank anchor tab (none was open)');
    }

    // Re-list: opening the anchor changed the tab set.
    try {
        pages = await browser.pages();
    } catch (error) {
        log.error('[browser-tabs] could not re-list browser tabs:', error?.message || error);
        return null;
    }

    // Reclaim order: non-blank extras first (they hold memory), then
    // blank leftovers (e.g. a worker tab a failed release blanked).
    // The anchor is never a candidate.
    const extras = pages.filter((page) => page !== anchor);
    const ordered = [
        ...extras.filter((page) => !isAnchor(page)),
        ...extras.filter((page) => isAnchor(page)),
    ];

    // No extra tab at all: the normal case — open a fresh worker tab.
    if (ordered.length === 0) {
        try {
            return await browser.newPage();
        } catch (error) {
            log.error('[browser-tabs] could not open a worker tab:', error?.message || error);
            return null;
        }
    }

    // Reclaim the first extra tab as the worker tab: blank it first
    // (frees its memory), then reuse it — no new tab is opened.
    for (const candidate of ordered) {
        const url = safeUrl(candidate);
        if (await blankTab(candidate, log)) {
            log.error(`[browser-tabs] reclaimed extra tab ${url} as the worker tab (navigated to about:blank first, no new tab opened)`);
            // Close any remaining extras; blank the ones that refuse
            // to close, so their memory is freed either way.
            for (const extra of ordered) {
                if (extra === candidate) continue;
                const extraUrl = safeUrl(extra);
                try {
                    await extra.close();
                    log.log(`[browser-tabs] closed stray tab: ${extraUrl}`);
                } catch (closeError) {
                    log.error(`[browser-tabs] could not close stray tab ${extraUrl} — blanking it instead to free its memory:`, closeError?.message || closeError);
                    await blankTab(extra, log);
                }
            }
            return candidate;
        }
        // Blank failed: try closing it outright, then move on to the
        // next candidate.
        try {
            await candidate.close();
            log.log(`[browser-tabs] closed unblankable stray tab: ${url}`);
        } catch (closeError) {
            log.error(`[browser-tabs] stray tab ${url} could neither be blanked nor closed — leaving it and trying the next tab:`, closeError?.message || closeError);
        }
    }

    // Every reclaim failed: open a fresh worker tab anyway and log
    // loudly. The job is never skipped because of tabs; the next
    // acquire retries the cleanup.
    log.error(`[browser-tabs] no extra tab could be reclaimed — opening a fresh worker tab anyway (tab count is above ${MAX_TABS}); the job runs, cleanup retried on the next acquire`);
    try {
        return await browser.newPage();
    } catch (error) {
        log.error('[browser-tabs] could not open a worker tab:', error?.message || error);
        return null;
    }
}

/**
 * Closes a worker tab when its job ends (success or failure). If the
 * close fails, the tab is navigated to about:blank instead, so its
 * memory is freed and the next acquire can reclaim and reuse it. The
 * job already ran — this only warns, never throws, never skips.
 * @param {import("puppeteer").Page | null} page - The worker tab.
 * @param {Console} [log=console] - Logger (injectable for tests).
 */
export async function releaseWorkerTab(page, log = console) {
    if (!page) return;
    try {
        await page.close();
    } catch (error) {
        log.warn('[browser-tabs] could not close the worker tab:', error?.message || error);
        if (await blankTab(page, log)) {
            log.log('[browser-tabs] worker tab navigated to about:blank for reuse');
        }
    }
}
