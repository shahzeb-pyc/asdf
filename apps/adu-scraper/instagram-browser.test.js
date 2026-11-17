import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INSTAGRAM_MAX_ATTEMPTS,
  InstagramBrowserManager,
  buildInstagramLaunchOptions,
  isProxyFailure,
  parseInstagramProxyPool,
  redactInstagramProxyCredentials,
  runInstagramJobWithRetries,
} from './instagram-browser.js';

// Spec scraper-ig-residential-proxies (owner corrections 2026-11-17):
// Instagram uses ONE proxy — the FIRST entry of INSTAGRAM_PROXIES —
// in a persistent dedicated browser. No rotation, no fallback to
// other pool entries, never the rotating proxy, never direct.
const POOL = 'proxy-a.example.com:10001:alice:s3cret-one,proxy-b.example.com:10002:bob:s3cret-two,proxy-c.example.com:10003:carol:s3cret-three';
const FIRST = { host: 'proxy-a.example.com', port: 10001, username: 'alice', password: 's3cret-one' };

function fakeBrowser() {
  return {
    connected: true,
    closed: false,
    isConnected() {
      return this.connected;
    },
    async close() {
      this.closed = true;
    },
  };
}

describe('parseInstagramProxyPool (single proxy: first entry only)', () => {
  it('returns the FIRST entry of a multi-entry pool', () => {
    assert.deepEqual(parseInstagramProxyPool(POOL), { ok: true, proxy: FIRST });
  });

  it('returns the same first entry on every parse (no rotation)', () => {
    assert.deepEqual(parseInstagramProxyPool(POOL).proxy, parseInstagramProxyPool(POOL).proxy);
  });

  it('ignores later entries even when they differ', () => {
    const parsed = parseInstagramProxyPool('proxy-a.example.com:10001:alice:s3cret-one,other.example.com:9999:x:y');
    assert.deepEqual(parsed.proxy, FIRST);
  });

  it('does not fall back to a later entry when the first is malformed', () => {
    const parsed = parseInstagramProxyPool('not-a-proxy,proxy-b.example.com:10002:bob:s3cret-two');
    assert.equal(parsed.ok, false);
  });

  it('accepts a single valid entry', () => {
    assert.deepEqual(parseInstagramProxyPool('proxy-a.example.com:10001:alice:s3cret-one'), { ok: true, proxy: FIRST });
  });

  it('keeps a password containing a colon intact', () => {
    const parsed = parseInstagramProxyPool('proxy-a.example.com:10001:alice:s3cret:with:colons');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.proxy.password, 's3cret:with:colons');
  });

  it('fails loud when the pool is missing', () => {
    const parsed = parseInstagramProxyPool(undefined);
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason, /INSTAGRAM_PROXIES/);
  });

  it('fails loud when the pool is empty or whitespace-only', () => {
    assert.equal(parseInstagramProxyPool('').ok, false);
    assert.equal(parseInstagramProxyPool('   ').ok, false);
    assert.equal(parseInstagramProxyPool(',,,').ok, false);
  });

  it('fails loud when the first entry is malformed', () => {
    assert.equal(parseInstagramProxyPool('proxy-a.example.com:10001:alice').ok, false);
    assert.equal(parseInstagramProxyPool('proxy-a.example.com:notaport:alice:s3cret-one').ok, false);
    assert.equal(parseInstagramProxyPool(':10001:alice:s3cret-one').ok, false);
  });

  it('never puts the raw pool value in the failure reason (it carries credentials)', () => {
    const parsed = parseInstagramProxyPool('proxy-a.example.com:10001:alice:s3cret-one');
    assert.equal(parsed.ok, true);
    const bad = parseInstagramProxyPool('bad-entry');
    assert.equal(bad.reason.includes('bad-entry'), false);
  });
});

describe('buildInstagramLaunchOptions', () => {
  it('puts the single proxy on --proxy-server and the IG profile dir on userDataDir', () => {
    const options = buildInstagramLaunchOptions({ userDataDir: '.browser-profile-ig', proxy: FIRST });
    assert.ok(options.args.includes('--proxy-server=http://proxy-a.example.com:10001'));
    assert.equal(options.userDataDir, '.browser-profile-ig');
    assert.equal(options.headless, false);
  });

  it('never puts proxy credentials in the launch options', () => {
    const options = buildInstagramLaunchOptions({ userDataDir: '.browser-profile-ig', proxy: FIRST });
    const text = JSON.stringify(options);
    assert.equal(text.includes('alice'), false);
    assert.equal(text.includes('s3cret-one'), false);
  });

  it('throws without a proxy (launching Instagram direct is never an option)', () => {
    assert.throws(() => buildInstagramLaunchOptions({ userDataDir: '.browser-profile-ig', proxy: null }), /needs a proxy/);
  });
});

describe('redactInstagramProxyCredentials', () => {
  it('redacts every credential-bearing form of the proxy', () => {
    const line = 'failed http://alice:s3cret-one@proxy-a.example.com:10001/x and raw proxy-a.example.com:10001:alice:s3cret-one and pass s3cret-one end';
    const redacted = redactInstagramProxyCredentials(line, FIRST);
    assert.equal(redacted.includes('alice'), false);
    assert.equal(redacted.includes('s3cret-one'), false);
    assert.equal(redacted.includes('[proxy]'), true);
    assert.equal(redacted.includes('failed'), true);
    assert.equal(redacted.includes('end'), true);
  });

  it('leaves text without credentials untouched', () => {
    assert.equal(redactInstagramProxyCredentials('plain log line', FIRST), 'plain log line');
  });

  it('is a no-op without a proxy', () => {
    assert.equal(redactInstagramProxyCredentials('alice:s3cret-one', null), 'alice:s3cret-one');
  });
});

describe('isProxyFailure', () => {
  it('classifies proxy connect/tunnel/timeout/429 failures', () => {
    assert.equal(isProxyFailure(new Error('net::ERR_PROXY_CONNECTION_FAILED')), true);
    assert.equal(isProxyFailure(new Error('net::ERR_TUNNEL_CONNECTION_FAILED')), true);
    assert.equal(isProxyFailure(new Error('Instagram returned HTTP 429')), true);
    assert.equal(isProxyFailure(new Error('Navigation timeout of 30000 ms exceeded')), true);
    assert.equal(isProxyFailure(new Error('net::ERR_CONNECTION_TIMED_OUT')), true);
  });

  it('trusts an explicitly marked proxy failure regardless of message', () => {
    const error = new Error('something odd happened');
    error.isProxyFailure = true;
    assert.equal(isProxyFailure(error), true);
  });

  it('does not classify ordinary failures as proxy failures', () => {
    assert.equal(isProxyFailure(new Error('Cannot read properties of null')), false);
    assert.equal(isProxyFailure(new Error('No items found')), false);
    assert.equal(isProxyFailure(null), false);
  });
});

describe('runInstagramJobWithRetries (same proxy, up to 3 attempts)', () => {
  const quietLog = { warn() {}, log() {}, error() {} };

  it('returns the attempt value when the first attempt succeeds', async () => {
    let calls = 0;
    const sleeps = [];
    const result = await runInstagramJobWithRetries(
      async () => { calls += 1; return ['a']; },
      { sleepFn: async (ms) => { sleeps.push(ms); }, log: quietLog },
    );
    assert.deepEqual(result, ['a']);
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  });

  it('retries a proxy failure and succeeds on the next attempt', async () => {
    let calls = 0;
    const sleeps = [];
    const result = await runInstagramJobWithRetries(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('net::ERR_PROXY_CONNECTION_FAILED');
        return ['a'];
      },
      { sleepFn: async (ms) => { sleeps.push(ms); }, log: quietLog },
    );
    assert.deepEqual(result, ['a']);
    assert.equal(calls, 2);
    assert.equal(sleeps.length, 1);
  });

  it('does not retry a non-proxy failure', async () => {
    let calls = 0;
    const sleeps = [];
    await assert.rejects(
      runInstagramJobWithRetries(
        async () => { calls += 1; throw new Error('Cannot read properties of null'); },
        { sleepFn: async (ms) => { sleeps.push(ms); }, log: quietLog },
      ),
      /Cannot read properties/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  });

  it(`throws after ${INSTAGRAM_MAX_ATTEMPTS} proxy failures`, async () => {
    let calls = 0;
    await assert.rejects(
      runInstagramJobWithRetries(
        async () => { calls += 1; throw new Error('net::ERR_PROXY_CONNECTION_FAILED'); },
        { sleepFn: async () => {}, log: quietLog },
      ),
      /ERR_PROXY_CONNECTION_FAILED/,
    );
    assert.equal(calls, INSTAGRAM_MAX_ATTEMPTS);
  });
});

describe('InstagramBrowserManager (persistent browser, no relaunch per job)', () => {
  it('launches once and returns the same browser across jobs', async () => {
    let launches = 0;
    const browser = fakeBrowser();
    const manager = new InstagramBrowserManager({ launch: async () => { launches += 1; return browser; } });
    assert.equal(await manager.getBrowser(), browser);
    assert.equal(await manager.getBrowser(), browser);
    manager.noteJobCompleted();
    assert.equal(await manager.getBrowser(), browser);
    assert.equal(launches, 1);
  });

  it('relaunches when the browser dies', async () => {
    let launches = 0;
    const first = fakeBrowser();
    const second = fakeBrowser();
    const manager = new InstagramBrowserManager({
      launch: async () => { launches += 1; return launches === 1 ? first : second; },
    });
    assert.equal(await manager.getBrowser(), first);
    first.connected = false;
    assert.equal(await manager.getBrowser(), second);
    assert.equal(launches, 2);
    assert.equal(first.closed, true);
  });

  it('relaunches after 500 jobs (same session discipline as the shared browser)', async () => {
    let launches = 0;
    const first = fakeBrowser();
    const second = fakeBrowser();
    const manager = new InstagramBrowserManager({
      launch: async () => { launches += 1; return launches === 1 ? first : second; },
    });
    assert.equal(await manager.getBrowser(), first);
    for (let i = 0; i < 500; i += 1) manager.noteJobCompleted();
    assert.equal(await manager.getBrowser(), second);
    assert.equal(launches, 2);
    assert.equal(first.closed, true);
  });

  it('requires a launch function', () => {
    assert.throws(() => new InstagramBrowserManager({}), /needs a launch function/);
  });
});
