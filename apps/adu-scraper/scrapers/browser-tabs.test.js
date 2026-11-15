import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_TABS, acquireWorkerTab, releaseWorkerTab } from '../browser-tabs.js';

// Fake Puppeteer browser: the ONLY mocked boundary. Tabs record
// closes and navigations; pages() hides closed tabs, like the real
// browser.
class FakeTab {
  constructor(url = 'about:blank', { closeFails = false, gotoFails = false } = {}) {
    this._url = url;
    this.closeFails = closeFails;
    this.gotoFails = gotoFails;
    this.closed = false;
    this.gotoUrls = [];
  }

  url() {
    return this._url;
  }

  isClosed() {
    return this.closed;
  }

  async goto(url) {
    this.gotoUrls.push(url);
    if (this.gotoFails) {
      throw new Error('tab refused to navigate');
    }
    this._url = url;
  }

  async close() {
    if (this.closeFails) {
      throw new Error('tab refused to close');
    }
    this.closed = true;
  }
}

class FakeBrowser {
  constructor(tabs = []) {
    this.tabs = [...tabs];
  }

  async pages() {
    return this.tabs.filter((tab) => !tab.closed);
  }

  async newPage() {
    const tab = new FakeTab('about:blank');
    this.tabs.push(tab);
    return tab;
  }
}

class FakeBrowserWithDeadList extends FakeBrowser {
  async pages() {
    throw new Error('DevTools unreachable');
  }
}

function capturingLogger() {
  const entries = { logs: [], warns: [], errors: [] };
  return {
    entries,
    log: (...args) => entries.logs.push(args.join(' ')),
    warn: (...args) => entries.warns.push(args.join(' ')),
    error: (...args) => entries.errors.push(args.join(' ')),
  };
}

test('acquire opens the anchor first, then a worker tab (2 tabs total)', async () => {
  const browser = new FakeBrowser();
  const log = capturingLogger();
  const worker = await acquireWorkerTab(browser, log);
  assert.ok(worker, 'a worker tab must be returned');
  const pages = await browser.pages();
  assert.equal(pages.length, 2);
  // Both tabs are blank at this point — the worker is fresh and has
  // not navigated anywhere yet — so the anchor is identified by
  // identity, not by counting blanks.
  const anchor = pages.find((tab) => tab !== worker);
  assert.equal(anchor.url(), 'about:blank');
  assert.ok(pages.includes(worker));
  assert.ok(log.entries.logs.some((line) => line.includes('anchor tab')));
});

test('acquire reclaims an extra tab as the worker instead of opening a new one', async () => {
  const anchor = new FakeTab('about:blank');
  const stray = new FakeTab('https://www.facebook.com/cnn/reels');
  const browser = new FakeBrowser([anchor, stray]);
  const log = capturingLogger();
  const worker = await acquireWorkerTab(browser, log);
  assert.equal(worker, stray, 'the extra tab is reused as the worker tab');
  assert.equal(stray.url(), 'about:blank', 'reclaim blanks the tab first');
  assert.equal((await browser.pages()).length, 2, 'no new tab is opened');
  assert.ok(log.entries.errors.some((line) => line.includes('reclaimed extra tab')));
});

test('acquire reclaims one extra and closes the rest', async () => {
  const anchor = new FakeTab('about:blank');
  const stray1 = new FakeTab('https://www.facebook.com/cnn/reels');
  const stray2 = new FakeTab('https://www.instagram.com/');
  const browser = new FakeBrowser([anchor, stray1, stray2]);
  const log = capturingLogger();
  const worker = await acquireWorkerTab(browser, log);
  assert.ok(worker === stray1 || worker === stray2, 'one extra is reclaimed as the worker');
  const other = worker === stray1 ? stray2 : stray1;
  assert.equal(other.closed, true, 'the remaining extra is closed');
  assert.equal(anchor.closed, false);
  assert.equal((await browser.pages()).length, 2);
});

test('an extra tab that refuses to close is blanked and reused, job still runs', async () => {
  const anchor = new FakeTab('about:blank');
  const stuck = new FakeTab('https://example.com/1', { closeFails: true });
  const browser = new FakeBrowser([anchor, stuck]);
  const log = capturingLogger();
  const worker = await acquireWorkerTab(browser, log);
  assert.equal(worker, stuck, 'the unclosable tab is reclaimed, not skipped');
  assert.equal(stuck.url(), 'about:blank');
  assert.equal((await browser.pages()).length, 2);
  assert.ok(log.entries.errors.some((line) => line.includes('reclaimed extra tab')));
});

test('a tab that refuses both blank and close does not block the job', async () => {
  const anchor = new FakeTab('about:blank');
  const stuck = new FakeTab('https://example.com/1', { closeFails: true, gotoFails: true });
  const browser = new FakeBrowser([anchor, stuck]);
  const log = capturingLogger();
  const worker = await acquireWorkerTab(browser, log);
  assert.ok(worker, 'the job is never skipped because of tabs');
  assert.notEqual(worker, stuck, 'the broken tab cannot be reclaimed, so a fresh tab opens');
  assert.equal((await browser.pages()).length, 3, 'count stays above the limit, loudly logged, job still runs');
  assert.ok(log.entries.errors.some((line) => line.includes('opening a fresh worker tab anyway')));
});

test('a previous worker left behind is reused on the next acquire', async () => {
  const browser = new FakeBrowser();
  const log = capturingLogger();
  const first = await acquireWorkerTab(browser, log);
  assert.ok(first);
  // The release close fails: the tab is blanked for reuse instead.
  first.closeFails = true;
  await releaseWorkerTab(first, log);
  assert.equal(first.closed, false);
  assert.equal(first.url(), 'about:blank');
  const second = await acquireWorkerTab(browser, log);
  assert.equal(second, first, 'the blanked worker tab is reclaimed, not replaced');
  assert.equal((await browser.pages()).length, 2);
});

test('release closes the worker tab and leaves the anchor open', async () => {
  const browser = new FakeBrowser();
  const log = capturingLogger();
  const worker = await acquireWorkerTab(browser, log);
  await releaseWorkerTab(worker, log);
  assert.equal(worker.closed, true);
  const pages = await browser.pages();
  assert.equal(pages.length, 1);
  assert.equal(pages[0].url(), 'about:blank');
});

test('release of a null tab is a no-op', async () => {
  const log = capturingLogger();
  await releaseWorkerTab(null, log);
  await releaseWorkerTab(undefined, log);
  assert.equal(log.entries.errors.length, 0);
});

test('release failure blanks the tab for reuse and only warns', async () => {
  const browser = new FakeBrowser();
  const log = capturingLogger();
  const worker = await acquireWorkerTab(browser, log);
  worker.closeFails = true;
  await releaseWorkerTab(worker, log);
  assert.equal(worker.closed, false);
  assert.equal(worker.url(), 'about:blank');
  assert.equal(log.entries.warns.length, 1);
  assert.equal(log.entries.errors.length, 0);
});

test('release failure AND blank failure only warns, never throws', async () => {
  const browser = new FakeBrowser();
  const log = capturingLogger();
  const worker = await acquireWorkerTab(browser, log);
  // Simulate a used worker tab: it holds a reels page, and both the
  // close and the blank navigation refuse.
  worker._url = 'https://www.facebook.com/cnn/reels';
  worker.closeFails = true;
  worker.gotoFails = true;
  await releaseWorkerTab(worker, log);
  assert.equal(worker.closed, false);
  assert.equal(worker.url(), 'https://www.facebook.com/cnn/reels', 'nothing could free it — the next acquire reclaims it');
  assert.equal(log.entries.warns.length, 2, 'one warn for the close, one for the failed blank');
  assert.equal(log.entries.errors.length, 0);
});

test('a browser with no anchor gets one opened, the stray is reclaimed as the worker', async () => {
  const stray = new FakeTab('https://www.facebook.com/');
  const browser = new FakeBrowser([stray]);
  const log = capturingLogger();
  const worker = await acquireWorkerTab(browser, log);
  assert.equal(worker, stray, 'the stray is reclaimed, not closed');
  assert.equal(stray.url(), 'about:blank');
  const pages = await browser.pages();
  assert.equal(pages.length, 2);
  // Both tabs are blank now — the reclaimed worker was blanked, and
  // the anchor opened fresh — so the anchor is identified by
  // identity, not by counting blanks.
  const anchor = pages.find((tab) => tab !== worker);
  assert.equal(anchor.url(), 'about:blank');
  assert.equal(anchor.gotoUrls.length, 0, 'the anchor is never navigated');
  assert.ok(log.entries.logs.some((line) => line.includes('anchor tab')));
});

test('the anchor keeps its identity when a blanked worker sits beside it', async () => {
  const stray = new FakeTab('https://www.facebook.com/');
  const browser = new FakeBrowser([stray]);
  const log = capturingLogger();
  const first = await acquireWorkerTab(browser, log);
  assert.equal(first, stray);
  // A second acquire before any job navigation: the blanked worker
  // must be reclaimed again — the true anchor (opened after the
  // stray, so it sits behind the worker in tab order) must never be
  // mistaken for a worker tab.
  const anchor = (await browser.pages()).find((tab) => tab !== first);
  const second = await acquireWorkerTab(browser, log);
  assert.equal(second, first, 'the same worker tab is reclaimed again');
  assert.equal(anchor.closed, false, 'the anchor is never closed');
  assert.equal(anchor.gotoUrls.length, 0, 'the anchor is never navigated');
  assert.equal((await browser.pages()).length, 2);
});

test('a browser that cannot list tabs fails loud and returns null', async () => {
  const browser = new FakeBrowserWithDeadList();
  const log = capturingLogger();
  const worker = await acquireWorkerTab(browser, log);
  assert.equal(worker, null, 'only a dead browser returns null — never the tab count');
  assert.equal(log.entries.errors.length, 1);
});

test('MAX_TABS is 2 (blank anchor + one worker)', () => {
  assert.equal(MAX_TABS, 2);
});
