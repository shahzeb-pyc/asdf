import { SCRAPER_CONFIG } from "../config.js";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Opens Facebook for manual login.
 * @param {import("puppeteer").Page} page
 */
export async function loginToFacebook(page) {
    console.log("🔑 Opening Facebook for manual login...");
    await page.goto("https://www.facebook.com/login", { waitUntil: "networkidle2" });
    console.log("⚠️  PLEASE LOG IN MANUALLY TO FACEBOOK IN THE BROWSER WINDOW.");
}

/**
 * Scrapes Facebook reels from a profile/page.
 * @param {import("puppeteer").Page} page - The browser page.
 * @param {string} username - Facebook page/account username.
 * @returns {Promise<{uniqueLinks: string[]} | null>} Scraped data.
 */
export async function scrapeFacebookProfile(page, username) {
    try {
        // Strip leading/trailing slashes without a regex (Sonar
        // S8786 flagged the regex form): plain string trims, with
        // internal slashes preserved exactly as before.
        let normalizedUsername = (username || "").trim();
        while (normalizedUsername.startsWith("/")) normalizedUsername = normalizedUsername.slice(1);
        while (normalizedUsername.endsWith("/")) normalizedUsername = normalizedUsername.slice(0, -1);
        const reelsUrl = `https://facebook.com/${normalizedUsername}/reels`;

        console.log(`📍 Navigating to Facebook Reels: ${reelsUrl}`);
        await page.goto(reelsUrl, { waitUntil: "networkidle2" });
        await sleep(3000);

        const uniqueLinks = new Set();
        let lastHeight = 0;
        let sameHeightCount = 0;

        while (true) {
            const links = await page.evaluate(() => {
                const xpath = '//a[@aria-label="Reel tile preview"]';
                const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                const ids = [];

                for (let i = 0; i < result.snapshotLength; i++) {
                    const node = result.snapshotItem(i);
                    if (!node || !node.getAttribute) continue;
                    const rawHref = node.getAttribute("href") || "";
                    const match = rawHref.match(/\/reel\/([^\/?#]+)\//);
                    if (match && match[1]) ids.push(match[1]);
                }

                return ids;
            });

            links.forEach((id) => uniqueLinks.add(id));

            if (uniqueLinks.size >= SCRAPER_CONFIG.MAX_REELS_PER_PLATFORM) {
                console.log(`🛑 Limit of ${SCRAPER_CONFIG.MAX_REELS_PER_PLATFORM} reels reached.`);
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
            console.log(`⬇️ Scrolling Facebook... collected ${uniqueLinks.size} reels.`);
        }

        return { uniqueLinks: Array.from(uniqueLinks) };
    } catch (error) {
        console.error("❌ Facebook scraping error:", error);
        return null;
    }
}
