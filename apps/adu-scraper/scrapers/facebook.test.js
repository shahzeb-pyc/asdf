import assert from 'node:assert/strict';
import test from 'node:test';
import { SCRAPER_CONFIG } from '../config.js';
import * as facebookModule from './facebook.js';
import {
  checkFacebookSessionState,
  extractReelId,
  scrapeFacebookProfile,
  scrapeFacebookProfileFromPage,
} from './facebook.js';

// Fake Puppeteer page: the ONLY mocked boundary. It dispatches each
// page.evaluate call by the in-page function's source (the production
// functions carry distinctive markers), and records every scroll,
// session probe, grid wait, and wheel nudge so the tests can pin
// exactly how the run behaved. The system under test is never mocked.
class FakePage {
  constructor({
    hrefsPerCollect = [[]],
    gridRenders = true,
    sessionState = 'ok',
    probeThrows = false,
    redirectAway = false,
    wwwUrl = false,
    checkpointAfterScrolls = null,
  } = {}) {
    this.hrefsPerCollect = hrefsPerCollect;
    this.gridRenders = gridRenders;
    this.sessionState = sessionState;
    this.probeThrows = probeThrows;
    this.redirectAway = redirectAway;
    this.wwwUrl = wwwUrl;
    this.checkpointAfterScrolls = checkpointAfterScrolls;
    this.collectCalls = 0;
    this.sessionProbes = 0;
    this.gridWaits = 0;
    this.scrolls = 0;
    this.wheelNudges = 0;
    this.gotoUrls = [];
    this.currentUrl = 'about:blank';
  }

  url() {
    return this.currentUrl;
  }

  async goto(url) {
    this.gotoUrls.push(url);
    if (this.redirectAway) {
      this.currentUrl = 'https://www.facebook.com/';
    } else if (this.wwwUrl) {
      this.currentUrl = url.replace('https://facebook.com/', 'https://www.facebook.com/');
    } else {
      this.currentUrl = url;
    }
  }

  async waitForTimeout() {}

  async waitForSelector() {
    this.gridWaits += 1;
    if (!this.gridRenders) {
      throw new Error('waiting for selector `a[href*="/reel/"]` failed: timeout 30000ms exceeded');
    }
  }

  mouse = {
    wheel: async () => {
      this.wheelNudges += 1;
    },
  };

  async evaluate(fn) {
    const src = Function.prototype.toString.call(fn);
    if (src.includes('scrollTo(0, document.body.scrollHeight)')) {
      this.scrolls += 1;
      return undefined;
    }
    if (src.includes('facebookSessionState')) {
      this.sessionProbes += 1;
      if (this.probeThrows) {
        throw new Error('Evaluation failed: session probe crashed');
      }
      if (
        this.checkpointAfterScrolls !== null &&
        this.scrolls >= this.checkpointAfterScrolls
      ) {
        return 'checkpoint';
      }
      return this.sessionState;
    }
    if (src.includes('querySelectorAll') && src.includes('/reel/')) {
      const batch = this.hrefsPerCollect[Math.min(this.collectCalls, this.hrefsPerCollect.length - 1)];
      this.collectCalls += 1;
      return [...batch];
    }
    throw new Error(`FakePage: unexpected evaluate: ${src.slice(0, 120)}`);
  }
}

const reelHref = (id) => `https://www.facebook.com/reel/${id}/`;

test('extractReelId reads the numeric ID from a /reel/ href', () => {
  assert.equal(extractReelId('https://www.facebook.com/reel/123456789/'), '123456789');
  assert.equal(extractReelId('/reel/42/'), '42');
});

test('extractReelId ignores non-numeric /reel/ hrefs', () => {
  assert.equal(extractReelId('https://www.facebook.com/reel/abc/'), null);
  assert.equal(extractReelId(''), null);
  assert.equal(extractReelId(null), null);
  // The spike's /reel/(\d+)/ takes the leading digits, so a href like
  // /reel/12x/ yields '12' — that is the ported behaviour, pinned here.
  assert.equal(extractReelId('https://www.facebook.com/reel/12x/'), '12');
});

test('module is logged-in only: no login function, scrape takes the shared page', () => {
  assert.equal('loginToFacebook' in facebookModule, false);
  assert.equal(typeof scrapeFacebookProfile, 'function');
  assert.equal(typeof scrapeFacebookProfileFromPage, 'function');
  assert.equal(typeof checkFacebookSessionState, 'function');
  // scrapeFacebookProfile(page, username): the shared page is passed
  // in — the route never launches its own browser.
  assert.equal(scrapeFacebookProfile.length, 2);
});

test('scrapeFacebookProfile uses the given page, no second browser', async () => {
  const page = new FakePage({ hrefsPerCollect: [[reelHref('111')]] });
  const result = await scrapeFacebookProfile(page, 'cnn');
  assert.equal(page.gotoUrls[0], 'https://facebook.com/cnn/reels');
  assert.deepEqual(result.uniqueLinks, ['111']);
});

test('username is normalised exactly as before (slashes stripped)', async () => {
  const page = new FakePage({ hrefsPerCollect: [[reelHref('111')]] });
  const result = await scrapeFacebookProfileFromPage(page, '///cnn///');
  assert.equal(page.gotoUrls[0], 'https://facebook.com/cnn/reels');
  assert.deepEqual(result.uniqueLinks, ['111']);
});

test('duplicate IDs collapse to one, in first-seen order', async () => {
  const page = new FakePage({
    hrefsPerCollect: [
      [reelHref('111'), reelHref('222'), reelHref('111')],
      [reelHref('222'), reelHref('333')],
    ],
  });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.deepEqual(result.uniqueLinks, ['111', '222', '333']);
});

test('non-numeric /reel/ hrefs are ignored during collection', async () => {
  const page = new FakePage({
    hrefsPerCollect: [[
      reelHref('abc'),
      reelHref('123'),
      'https://www.facebook.com/reel/456/?ref=x',
    ]],
  });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.deepEqual(result.uniqueLinks, ['123', '456']);
});

test('scrolling stops after exactly 5 consecutive scrolls with no new reels', async () => {
  const page = new FakePage({ hrefsPerCollect: [[reelHref('111'), reelHref('222'), reelHref('333')]] });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.deepEqual(result.uniqueLinks, ['111', '222', '333']);
  assert.equal(page.scrolls, 5);
  assert.equal(page.wheelNudges, 5);
});

test('session is re-gated after every scroll (1 initial + 1 per scroll)', async () => {
  const page = new FakePage({ hrefsPerCollect: [[reelHref('111')]] });
  await scrapeFacebookProfileFromPage(page, 'cnn');
  // 1 gate before the grid wait + 1 after each of the 5 stall scrolls.
  assert.equal(page.scrolls, 5);
  assert.equal(page.sessionProbes, 1 + 5);
});

test('collection truncates to exactly MAX_REELS_PER_PLATFORM', async () => {
  const cap = SCRAPER_CONFIG.MAX_REELS_PER_PLATFORM;
  assert.ok(cap > 0, 'cap must be a positive number');
  const batch = (count) => Array.from({ length: count }, (_, i) => reelHref(String(i + 1)));
  const page = new FakePage({
    hrefsPerCollect: [batch(300), batch(600), batch(900), batch(1200)],
  });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.equal(result.uniqueLinks.length, cap);
  assert.equal(result.uniqueLinks[0], '1');
  assert.equal(result.uniqueLinks[cap - 1], String(cap));
  assert.equal(new Set(result.uniqueLinks).size, cap);
  assert.equal(page.scrolls, 3);
});

test('grid never rendered returns null', async () => {
  const page = new FakePage({ gridRenders: false });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.equal(result, null);
  assert.equal(page.gotoUrls[0], 'https://facebook.com/cnn/reels');
});

test('grid rendered but 0 reels ever collected returns null', async () => {
  const page = new FakePage({ hrefsPerCollect: [[]] });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.equal(result, null);
  assert.equal(page.scrolls, 5);
});

test('session gate: checkpoint fails loud before any scrolling', async () => {
  const page = new FakePage({
    hrefsPerCollect: [[reelHref('111')]],
    sessionState: 'checkpoint',
  });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.equal(result, null);
  assert.equal(page.scrolls, 0);
  assert.equal(page.gridWaits, 0);
  assert.equal(page.sessionProbes, 1);
});

test('session gate: login wall fails loud before any scrolling', async () => {
  const page = new FakePage({
    hrefsPerCollect: [[reelHref('111')]],
    sessionState: 'loginwall',
  });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.equal(result, null);
  assert.equal(page.scrolls, 0);
  assert.equal(page.gridWaits, 0);
});

test('session gate: unavailable page fails loud (dead source)', async () => {
  const page = new FakePage({
    hrefsPerCollect: [[reelHref('111')]],
    sessionState: 'unavailable',
  });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.equal(result, null);
  assert.equal(page.scrolls, 0);
});

test('session gate: an unverifiable session fails loud, never a silent empty success', async () => {
  const page = new FakePage({
    hrefsPerCollect: [[reelHref('111')]],
    probeThrows: true,
  });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.equal(result, null);
  assert.equal(page.scrolls, 0);
});

test('session gate: redirect away from the reels page fails loud', async () => {
  const page = new FakePage({
    hrefsPerCollect: [[reelHref('111')]],
    redirectAway: true,
  });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.equal(result, null);
  assert.equal(page.scrolls, 0);
});

test('www. reels URL is accepted (no false redirect failure)', async () => {
  const page = new FakePage({
    hrefsPerCollect: [[reelHref('111')]],
    wwwUrl: true,
  });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.deepEqual(result.uniqueLinks, ['111']);
});

test('checkpoint appearing mid-scroll aborts the run and discards the partial batch', async () => {
  const page = new FakePage({
    hrefsPerCollect: [
      [reelHref('111'), reelHref('222')],
      [reelHref('333')],
    ],
    checkpointAfterScrolls: 2,
  });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.equal(result, null);
  assert.equal(page.scrolls, 2);
});

test('checkFacebookSessionState returns each state verbatim', async () => {
  for (const state of ['ok', 'checkpoint', 'loginwall', 'unavailable']) {
    const page = new FakePage({ sessionState: state });
    assert.equal(await checkFacebookSessionState(page), state);
  }
  const throwingPage = new FakePage({ probeThrows: true });
  assert.equal(await checkFacebookSessionState(throwingPage), 'unknown');
});
