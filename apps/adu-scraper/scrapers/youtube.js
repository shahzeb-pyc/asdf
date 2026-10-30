import { SCRAPER_CONFIG } from "../config.js";

const sleep = ms => new Promise(res => setTimeout(res, ms));

/**
 * Opens YouTube for manual login.
 * @param {import("puppeteer").Page} page
 */
export async function loginToYouTube(page) {
    console.log("🔑 Opening YouTube for manual login...");
    await page.goto("https://accounts.google.com/ServiceLogin?service=youtube", { waitUntil: "networkidle2" });
    console.log("⚠️  PLEASE LOG IN MANUALLY TO YOUTUBE IN THE BROWSER WINDOW.");
}

/**
 * Scrapes YouTube Shorts from a channel.
 * @param {import("puppeteer").Page} page - The browser page.
 * @param {string} channelHandle - The channel handle (e.g. "@MrBeast").
 * @returns {Promise<object>} Scraped data.
 */
export async function scrapeYoutubeChannel(page, channelHandle) {
    try {
        // Handle format: @username or plain username
        const formattedHandle = channelHandle.startsWith('@') ? channelHandle : `@${channelHandle}`;
        const shortsUrl = `https://www.youtube.com/${formattedHandle}/shorts`;

        console.log(`📍 Navigating to YouTube Shorts: ${shortsUrl}`);
        await page.goto(shortsUrl, { waitUntil: "networkidle2" });
        await sleep(3000);

        // Cookie consent check (simple)
        try {
            const consentButton = await page.$('button[aria-label="Accept all"]');
            if (consentButton) {
                await consentButton.click();
                await sleep(1000);
            }
        } catch (e) {
            // Ignore cookie errors
        }

        const uniqueLinks = new Set();
        let lastHeight = 0;
        let sameHeightCount = 0;

        while (true) {
            const links = await page.evaluate(() => {
                const xpath = '//a[contains(@href, "/shorts/") and (not(@title) or @title != "Shorts")]';
                const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                const ids = [];
                for (let i = 0; i < result.snapshotLength; i++) {
                    const node = result.snapshotItem(i);
                    if (node && node.href) {
                        const parts = node.href.split('?')[0].split('/shorts/');
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
                console.log(`🛑 Limit of ${SCRAPER_CONFIG.MAX_REELS_PER_PLATFORM} shorts reached.`);
                break;
            }

            await page.evaluate(() => {
                window.scrollBy(0, document.documentElement.scrollHeight);
            });
            await sleep(SCRAPER_CONFIG.SCROLL_PAUSE);

            // Small "wiggle" to trigger lazy loading if stuck
            await page.evaluate(() => {
                window.scrollBy(0, -10);
                window.scrollBy(0, 10);
            });

            const newHeight = await page.evaluate(() => document.documentElement.scrollHeight || document.body.scrollHeight);
            if (newHeight === lastHeight) {
                sameHeightCount++;
                if (sameHeightCount >= SCRAPER_CONFIG.MAX_SAME_HEIGHT) {
                    break;
                }
            } else {
                sameHeightCount = 0;
            }
            lastHeight = newHeight;
            console.log(`⬇️ Scrolling YouTube... collected ${uniqueLinks.size} shorts.`);
        }

        return { uniqueLinks: Array.from(uniqueLinks) };

    } catch (error) {
        console.error("❌ YouTube scraping error:", error);
        return null;
    }
}