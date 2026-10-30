import { INSTAGRAM_CONFIG, SCRAPER_CONFIG } from "../config.js";

const sleep = ms => new Promise(res => setTimeout(res, ms));

/**
 * Navigates to Instagram for manual login.
 * @param {import("puppeteer").Page} page - The browser page.
 */
export async function loginToInstagram(page) {
    console.log("🔑 Opening Instagram for manual login...");
    await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "networkidle2" });
    console.log("⚠️  PLEASE LOG IN MANUALLY IN THE BROWSER WINDOW.");
}


/**
 * Scrapes the Instagram profile of a target user.
 * @param {import("puppeteer").Page} page - The logged-in Puppeteer page object.
 * @param {string} targetUser - The username of the Instagram profile to scrape.
 * @returns {Promise<object>} An object containing the scraped data.
 */
export async function scrapeInstagramProfile(page, targetUser) {
    try {
        const reelsUrl = `https://www.instagram.com/${targetUser}/reels/`;
        await page.goto(reelsUrl, { waitUntil: "networkidle2" });
        console.log(`📍 Navigated to ${reelsUrl}`);
        await sleep(5000);

        const uniqueLinks = new Set();
        let lastHeight = 0;
        let sameHeightCount = 0;

        while (true) {
            const links = await page.evaluate(() => {
                const xpath = '//a[contains(@href, "/reel/")]';
                const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                const ids = [];
                for (let i = 0; i < result.snapshotLength; i++) {
                    const node = result.snapshotItem(i);
                    if (node && node.href) {
                        // Extract ID: /path/reel/ID/ -> split by /reel/ -> ID/ -> remove trailing slashes
                        const parts = node.href.split('?')[0].split('/reel/');
                        if (parts.length > 1) {
                            const rawId = parts[1].split('/')[0];
                            if (rawId) ids.push(rawId);
                        }
                    }
                }
                return ids;
            });

            links.forEach(id => {
                uniqueLinks.add(id);
            });

            if (uniqueLinks.size >= SCRAPER_CONFIG.MAX_REELS_PER_PLATFORM) {
                console.log(`🛑 Limit of ${SCRAPER_CONFIG.MAX_REELS_PER_PLATFORM} reels reached. Stopping scroll...`);
                break;
            }

            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
            await sleep(SCRAPER_CONFIG.SCROLL_PAUSE);

            const newHeight = await page.evaluate("document.body.scrollHeight");

            if (newHeight === lastHeight) {
                sameHeightCount++;
                if (sameHeightCount >= SCRAPER_CONFIG.MAX_SAME_HEIGHT) {
                    console.log("📍 Reached the end of the page. Stopping scroll...");
                    break;
                }
            } else {
                sameHeightCount = 0;
            }

            lastHeight = newHeight;
            console.log(`⬇️ Scrolling... collected ${uniqueLinks.size} unique reels so far.`);
        }

        return {
            uniqueLinks: Array.from(uniqueLinks),
        };
    } catch (error) {
        console.error("❌ An error occurred during scraping:", error);
        return null;
    }
}
