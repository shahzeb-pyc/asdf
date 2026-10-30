import { SCRAPER_CONFIG } from "../config.js";

const sleep = ms => new Promise(res => setTimeout(res, ms));

/**
 * Opens TikTok for manual login.
 * @param {import("puppeteer").Page} page
 */
export async function loginToTikTok(page) {
    console.log("🔑 Opening TikTok for manual login...");
    await page.goto("https://www.tiktok.com/login", { waitUntil: "networkidle2" });
    console.log("⚠️  PLEASE LOG IN MANUALLY TO TIKTOK IN THE BROWSER WINDOW.");
}

/**
 * Scrapes TikTok videos from a profile.
 * @param {import("puppeteer").Page} page - The browser page.
 * @param {string} username - The TikTok username.
 * @returns {Promise<object>} Scraped data.
 */
export async function scrapeTikTokProfile(page, username) {
    try {
        const formattedUser = username.startsWith('@') ? username : `@${username}`;
        const url = `https://www.tiktok.com/${formattedUser}`;

        console.log(`📍 Navigating to TikTok: ${url}`);
        await page.goto(url, { waitUntil: "networkidle2" });
        await sleep(3000);

        // Solve for "Open interaction" modals or captive portals if minimal
        // Often TikTok has a "Continue as Guest" or login modal. We try to ignore/close.

        const uniqueLinks = new Set();
        let lastHeight = 0;
        let sameHeightCount = 0;

        while (true) {
            const links = await page.evaluate(() => {
                const xpath = '//a[contains(@href, "/video/")]';
                const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                const ids = [];
                for (let i = 0; i < result.snapshotLength; i++) {
                    const node = result.snapshotItem(i);
                    if (node && node.href) {
                        const parts = node.href.split('?')[0].split('/video/');
                        const id = parts[parts.length - 1];
                        if (id) ids.push(id);
                    }
                }
                return ids;
            });

            links.forEach(id => {
                uniqueLinks.add(id);
            });

            if (uniqueLinks.size >= SCRAPER_CONFIG.MAX_REELS_PER_PLATFORM) {
                console.log(`🛑 Limit of ${SCRAPER_CONFIG.MAX_REELS_PER_PLATFORM} videos reached.`);
                break;
            }

            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
            await sleep(SCRAPER_CONFIG.SCROLL_PAUSE);

            const newHeight = await page.evaluate("document.body.scrollHeight");
            if (newHeight === lastHeight) {
                sameHeightCount++;
                if (sameHeightCount >= SCRAPER_CONFIG.MAX_SAME_HEIGHT) {
                    break;
                }
            } else {
                sameHeightCount = 0;
            }
            lastHeight = newHeight;
            console.log(`⬇️ Scrolling TikTok... collected ${uniqueLinks.size} videos.`);
        }

        return { uniqueLinks: Array.from(uniqueLinks) };

    } catch (error) {
        console.error("❌ TikTok scraping error:", error);
        return null;
    }
}