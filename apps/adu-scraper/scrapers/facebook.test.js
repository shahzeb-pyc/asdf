import assert from 'node:assert/strict';
import test from 'node:test';
import { SCRAPER_CONFIG } from '../config.js';
import * as facebookModule from './facebook.js';
import { extractReelId, scrapeFacebookProfile, scrapeFacebookProfileFromPage } from './facebook.js';

// Fake Patchright page: the ONLY mocked boundary. It dispatches each
// page.evaluate call by the in-page function's source (the production
// functions carry distinctive markers), and records every scroll,
// dialog probe, hide, click, and wheel nudge so the tests can pin
// exactly how often each ran. The system under test is never mocked.
class FakePage {
  constructor({
    hrefsPerCollect = [[]],
    gridRenders = true,
    dialogPresent = false,
    dialogHasClose = false,
  } = {}) {
    this.hrefsPerCollect = hrefsPerCollect;
    this.gridRenders = gridRenders;
    this.dialogPresent = dialogPresent;
    this.dialogHasClose = dialogHasClose;
    this.collectCalls = 0;
    this.detectProbes = 0;
    this.hideCalls = 0;
    this.scrolls = 0;
    this.wheelNudges = 0;
    this.clicks = [];
    this.gotoUrls = [];
  }

  async goto(url) {
    this.gotoUrls.push(url);
  }

  async waitForTimeout() {}

  async waitForSelector() {
    if (!this.gridRenders) {
      throw new Error('waiting for selector `a[href*="/reel/"]` failed: timeout 30000ms exceeded');
    }
  }

  async click(selector) {
    this.clicks.push(selector);
    // A real click on the dialog's Close control dismisses it.
    this.dialogPresent = false;
  }

  mouse = {
    wheel: async () => {
      this.wheelNudges += 1;
    },
  };

  keyboard = {
    press: async () => {},
  };

  async evaluate(fn) {
    const src = Function.prototype.toString.call(fn);
    if (src.includes('scrollTo(0, document.body.scrollHeight)')) {
      this.scrolls += 1;
      return undefined;
    }
    if (src.includes('pointerEvents')) {
      // hideTopOverlayDiv: hiding the overlay dismisses the dialog.
      this.hideCalls += 1;
      this.dialogPresent = false;
      return { hidden: 1, levelsClimbed: 1 };
    }
    if (src.includes('closeInDialog')) {
      this.detectProbes += 1;
      return { present: this.dialogPresent, closeInDialog: this.dialogHasClose };
    }
    if (src.includes('reelLinksInDom')) {
      return {
        dialogPresent: this.dialogPresent,
        reelLinksInDom: 0,
        scrollY: 0,
        scrollHeight: 0,
        innerHeight: 900,
      };
    }
    if (src.includes('querySelectorAll') && src.includes('/reel/')) {
      const batch = this.hrefsPerCollect[Math.min(this.collectCalls, this.hrefsPerCollect.length - 1)];
      this.collectCalls += 1;
      return [...batch];
    }
    if (src.includes('aria-label="Dismiss"')) {
      return null;
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

test('module exports no login function', () => {
  assert.equal('loginToFacebook' in facebookModule, false);
  assert.equal(typeof scrapeFacebookProfile, 'function');
  assert.equal(typeof scrapeFacebookProfileFromPage, 'function');
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

test('dialog dismiss is probed before AND after every scroll', async () => {
  const page = new FakePage({ hrefsPerCollect: [[reelHref('111')]] });
  await scrapeFacebookProfileFromPage(page, 'cnn');
  // 1 initial dismiss (before the grid wait) + 2 per scroll (pre- and
  // post-scroll) x 5 stall scrolls = 11 probes. A run that only
  // dismissed once at the start would show 1.
  assert.equal(page.scrolls, 5);
  assert.equal(page.detectProbes, 1 + 2 * 5);
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

test('dialog without a Close control is hidden and scrolling continues (variant B)', async () => {
  const page = new FakePage({
    hrefsPerCollect: [[reelHref('111'), reelHref('222')]],
    dialogPresent: true,
    dialogHasClose: false,
  });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.deepEqual(result.uniqueLinks, ['111', '222']);
  assert.ok(page.hideCalls >= 1, 'top-overlay hide must have run');
  assert.equal(page.scrolls, 5);
});

test('dialog with a Close control is clicked and scrolling continues (variant A)', async () => {
  const page = new FakePage({
    hrefsPerCollect: [[reelHref('111'), reelHref('222')]],
    dialogPresent: true,
    dialogHasClose: true,
  });
  const result = await scrapeFacebookProfileFromPage(page, 'cnn');
  assert.deepEqual(result.uniqueLinks, ['111', '222']);
  assert.ok(page.clicks.length >= 1, 'a real click on Close must have run');
  assert.equal(page.scrolls, 5);
});
