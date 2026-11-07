import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverReelIdsWithYtdlp } from './ytdlp.js';

// Dummy proxy value (TEST-NET addresses, not a real credential). The module
// must never log it; the fake yt-dlp below records it only in its own argv
// log file, which is test instrumentation in a temp dir.
const FAKE_PROXY = 'http://proxyuser:proxypass@203.0.113.7:8080';
const PROFILE_IDS = ['7675699705355177218', '7633716305220078871'];
const SECUID_IDS = ['7700323970007960854', '7699944216415243542'];
const SEC_UID = 'MS4wLjABAAAAtestsecuidvalue';
const PROFILE_URL = 'https://www.tiktok.com/@courtroom62';

// Fake yt-dlp binary (CommonJS: the file has no extension, so Node loads it
// as CJS). It records every invocation's argv, then either fails or prints
// flat-playlist JSON, depending on FAKE_YTDLP_MODE:
//   profile-ok   - every attempt succeeds
//   profile-fail - the profile-URL attempt fails, the tiktokuser: attempt succeeds
//   all-fail     - every attempt fails
const FAKE_YTDLP_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const logFile = process.env.FAKE_YTDLP_LOG;
const mode = process.env.FAKE_YTDLP_MODE || 'profile-ok';
const args = process.argv.slice(2);
fs.appendFileSync(logFile, JSON.stringify(args) + String.fromCharCode(10));
const target = args[args.length - 1];
const fail = (msg) => {
  process.stderr.write(msg + String.fromCharCode(10));
  process.exit(1);
};
if (mode === 'all-fail') fail('fake yt-dlp: simulated failure');
if (mode === 'profile-fail' && target.startsWith('https://www.tiktok.com/')) {
  fail('fake yt-dlp: simulated profile failure');
}
const ids = target.startsWith('tiktokuser:') ? ${JSON.stringify(SECUID_IDS)} : ${JSON.stringify(PROFILE_IDS)};
process.stdout.write(JSON.stringify({ entries: ids.map((id) => ({ id })) }));
`;

const ENV_KEYS = [
  'PATH',
  'COUNTIK_PROXY_URL',
  'DATACENTER_PROXY',
  'PROXY_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'YTDLP_BIN',
  'YTDLP_TIMEOUT_MS',
  'FAKE_YTDLP_MODE',
  'FAKE_YTDLP_LOG',
];

async function setupFakeYtdlp({ mode, proxy }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ytdlp-'));
  const binPath = path.join(dir, 'yt-dlp');
  fs.writeFileSync(binPath, FAKE_YTDLP_SCRIPT, { mode: 0o755 });
  const logFile = path.join(dir, 'invocations.log');
  fs.writeFileSync(logFile, '');

  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }
  // Clear every proxy env var so only the explicit COUNTIK_PROXY_URL can
  // appear in argv (the sandbox itself sets https_proxy for egress).
  for (const key of ['DATACENTER_PROXY', 'PROXY_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'YTDLP_BIN']) {
    delete process.env[key];
  }
  process.env.PATH = `${dir}:${saved.PATH || ''}`;
  process.env.YTDLP_TIMEOUT_MS = '10000';
  process.env.FAKE_YTDLP_LOG = logFile;
  process.env.FAKE_YTDLP_MODE = mode;
  if (proxy === undefined) {
    delete process.env.COUNTIK_PROXY_URL;
  } else {
    process.env.COUNTIK_PROXY_URL = proxy;
  }

  const restore = () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { logFile, restore };
}

function readInvocations(logFile) {
  const content = fs.readFileSync(logFile, 'utf8').trim();
  if (!content) {
    return [];
  }
  return content.split('\n').map((line) => JSON.parse(line));
}

function makeResolverStub(secUid) {
  let calls = 0;
  const stub = async () => {
    calls += 1;
    return secUid;
  };
  stub.calls = () => calls;
  return stub;
}

async function withCapturedConsole(fn) {
  const lines = [];
  const originals = {};
  for (const method of ['log', 'warn', 'error']) {
    originals[method] = console[method];
    console[method] = (...args) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    };
  }
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    for (const method of ['log', 'warn', 'error']) {
      console[method] = originals[method];
    }
  }
}

function assertProxyValueNeverLogged(lines) {
  assert.ok(
    lines.every((line) => !line.includes(FAKE_PROXY) && !line.includes('proxypass')),
    `proxy value leaked into logs: ${lines.join(' | ')}`,
  );
}

test('profile URL attempt runs first through the proxy and Countik is never called', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'profile-ok', proxy: FAKE_PROXY });
  try {
    const resolver = makeResolverStub(SEC_UID);
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, { resolveSecUid: resolver }),
    );
    assert.deepEqual(result, { ok: true, ids: PROFILE_IDS });
    assert.equal(resolver.calls(), 0);

    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 1);
    const [argv] = invocations;
    assert.equal(argv.at(-1), PROFILE_URL);
    const proxyIndex = argv.indexOf('--proxy');
    assert.ok(proxyIndex >= 0, 'profile attempt must pass --proxy');
    assert.equal(argv[proxyIndex + 1], FAKE_PROXY);
    assert.ok(argv.includes('--flat-playlist'));
    assert.ok(argv.includes('-J'));
    assertProxyValueNeverLogged(lines);
  } finally {
    restore();
  }
});

test('profile failure falls back to Countik sec_uid and tiktokuser: stays direct', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'profile-fail', proxy: FAKE_PROXY });
  try {
    const resolver = makeResolverStub(SEC_UID);
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, { resolveSecUid: resolver }),
    );
    assert.deepEqual(result, { ok: true, ids: SECUID_IDS });
    assert.equal(resolver.calls(), 1);

    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 2);
    const [first, second] = invocations;
    assert.equal(first.at(-1), PROFILE_URL);
    const proxyIndex = first.indexOf('--proxy');
    assert.ok(proxyIndex >= 0, 'profile attempt must pass --proxy');
    assert.equal(first[proxyIndex + 1], FAKE_PROXY);
    assert.equal(second.at(-1), `tiktokuser:${SEC_UID}`);
    assert.ok(!second.includes('--proxy'), 'tiktokuser: attempt must not pass --proxy');
    assertProxyValueNeverLogged(lines);
  } finally {
    restore();
  }
});

test('both paths failing returns error with the last failure detail', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'all-fail', proxy: FAKE_PROXY });
  try {
    const resolver = makeResolverStub(SEC_UID);
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, { resolveSecUid: resolver }),
    );
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
    assert.equal(resolver.calls(), 1);

    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 2);
    assert.equal(invocations[0].at(-1), PROFILE_URL);
    assert.equal(invocations[1].at(-1), `tiktokuser:${SEC_UID}`);
    assert.ok(!invocations[1].includes('--proxy'));
    assertProxyValueNeverLogged(lines);
  } finally {
    restore();
  }
});

test('sec_uid resolution failing after profile failure returns the profile failure', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'all-fail', proxy: FAKE_PROXY });
  try {
    const resolver = makeResolverStub(null);
    const { result } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, { resolveSecUid: resolver }),
    );
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
    assert.equal(resolver.calls(), 1);

    // No tiktokuser: attempt without a sec_uid: only the profile attempt ran.
    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].at(-1), PROFILE_URL);
  } finally {
    restore();
  }
});

test('without COUNTIK_PROXY_URL the profile attempt still runs first, without --proxy', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'profile-ok', proxy: undefined });
  try {
    const resolver = makeResolverStub(SEC_UID);
    const result = await discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, {
      resolveSecUid: resolver,
    });
    assert.deepEqual(result, { ok: true, ids: PROFILE_IDS });
    assert.equal(resolver.calls(), 0);

    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].at(-1), PROFILE_URL);
    assert.ok(!invocations[0].includes('--proxy'));
  } finally {
    restore();
  }
});

test('non-TikTok platform is rejected without invoking yt-dlp', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'profile-ok', proxy: FAKE_PROXY });
  try {
    const resolver = makeResolverStub(SEC_UID);
    const result = await discoverReelIdsWithYtdlp('instagram', 'someuser', 10, {
      resolveSecUid: resolver,
    });
    assert.deepEqual(result, { ok: false, reason: 'platform_not_supported' });
    assert.equal(resolver.calls(), 0);
    assert.deepEqual(readInvocations(logFile), []);
  } finally {
    restore();
  }
});
