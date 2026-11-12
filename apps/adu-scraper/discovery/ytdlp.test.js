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
const FAKE_TIKWM_KEY = 'test-fake-key-alpha-001';
const FAKE_SECUID = 'MS4wLjABAAAA-FAKE-SECUID-VALUE-USED-ONLY-IN-THIS-TEST-0123456789abcdef';
const PROFILE_IDS = ['7675699705355177218', '7633716305220078871'];
const DIRECT_IDS = ['7675699705355177219', '7633716305220078872'];
const PROFILE_URL = 'https://www.tiktok.com/@courtroom62';

// Fake yt-dlp binary (CommonJS: the file has no extension, so Node loads it
// as CJS). It records every invocation's argv, then either fails or prints
// flat-playlist JSON, depending on FAKE_YTDLP_MODE:
//   profile-ok       - every attempt succeeds
//   all-fail         - every attempt fails with a stderr message
//   empty-stderr-fail - every attempt exits 1 with no stderr output
//   hang-profile     - the FIRST attempt hangs (execFile timeout kill),
//                      later attempts exit 1 with no stderr output
//   fail-first-n     - the first FAKE_YTDLP_FAIL_FIRST invocations fail
//                      with a stderr message, then attempts succeed
//   fail-profile-direct-ok - the profile-URL attempt always fails, but a
//                      `tiktokuser:` direct attempt succeeds (the TikWM
//                      primary path: lookup resolves, direct feed
//                      returns DIRECT_IDS)
//   fail-direct-profile-ok - the `tiktokuser:` direct attempt always
//                      fails, but the profile-URL attempt succeeds
//                      (paid path fails at the direct attempt, the
//                      profile backup runs and recovers)
//   partial-ids        - every attempt exits 1 but writes valid-IDs
//                      JSON to stdout first (partial-results recovery)
//   partial-direct-only - the `tiktokuser:` direct attempt exits 1
//                      with valid-IDs JSON on stdout; profile attempts
//                      fail (partial recovery on the direct attempt)
//   partial-zero-ids   - every attempt exits 1 with JSON holding zero
//                      valid IDs (an internal ByteDance asset ID only)
//   partial-unparseable - every attempt exits 1 with non-JSON stdout
const FAKE_YTDLP_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const logFile = process.env.FAKE_YTDLP_LOG;
const mode = process.env.FAKE_YTDLP_MODE || 'profile-ok';
const args = process.argv.slice(2);
fs.appendFileSync(logFile, JSON.stringify(args) + String.fromCharCode(10));
// 1-based number of this invocation (the log line above is already counted).
const invocationNumber = fs.readFileSync(logFile, 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).length;
const fail = (msg) => {
  process.stderr.write(msg + String.fromCharCode(10));
  process.exit(1);
};
// Hang only the FIRST attempt: execFile's timeout kills the process, the
// same empty-stderr shape as a timeout kill in production. Later attempts
// fail fast with empty stderr, so the retry loop still runs 5 attempts.
let hanging = false;
if (mode === 'hang-profile' && invocationNumber === 1) {
  setTimeout(() => {}, 60000);
  hanging = true;
}
if (!hanging) {
  if (mode === 'all-fail') fail('fake yt-dlp: simulated failure');
  if (mode === 'empty-stderr-fail') process.exit(1);
  if (mode === 'hang-profile') process.exit(1);
  if (mode === 'fail-profile-direct-ok') {
    const target = args[args.length - 1] || '';
    if (String(target).indexOf('tiktokuser:') === 0) {
      const ids = ${JSON.stringify(DIRECT_IDS)};
      process.stdout.write(JSON.stringify({ entries: ids.map((id) => ({ id })) }));
      process.exit(0);
    }
    fail('fake yt-dlp: simulated profile failure');
  }
  if (mode === 'fail-direct-profile-ok') {
    const target = args[args.length - 1] || '';
    if (String(target).indexOf('tiktokuser:') === 0) {
      fail('fake yt-dlp: simulated direct failure');
    }
  }
  if (mode === 'partial-ids') {
    const ids = ${JSON.stringify(PROFILE_IDS)};
    process.stdout.write(JSON.stringify({ entries: ids.map((id) => ({ id })) }));
    process.exit(1);
  }
  if (mode === 'partial-direct-only') {
    const target = args[args.length - 1] || '';
    if (String(target).indexOf('tiktokuser:') === 0) {
      const ids = ${JSON.stringify(DIRECT_IDS)};
      process.stdout.write(JSON.stringify({ entries: ids.map((id) => ({ id })) }));
      process.exit(1);
    }
    fail('fake yt-dlp: simulated profile failure');
  }
  if (mode === 'partial-zero-ids') {
    process.stdout.write(JSON.stringify({ entries: [{ id: 'vid:v12044123456789012' }] }));
    process.exit(1);
  }
  if (mode === 'partial-unparseable') {
    process.stdout.write('not json{{{');
    process.exit(1);
  }
  if (mode === 'fail-first-n') {
    const failFirst = Number(process.env.FAKE_YTDLP_FAIL_FIRST || '2');
    if (invocationNumber <= failFirst) fail('fake yt-dlp: simulated profile failure');
  }
  const ids = ${JSON.stringify(PROFILE_IDS)};
  process.stdout.write(JSON.stringify({ entries: ids.map((id) => ({ id })) }));
}
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
  'TIKWMAPI_KEYS_SCRAPER',
  'FAKE_YTDLP_MODE',
  'FAKE_YTDLP_FAIL_FIRST',
  'FAKE_YTDLP_LOG',
];

async function setupFakeYtdlp({ mode, proxy, failFirst }) {
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
  // Also clear TIKWMAPI_KEYS_SCRAPER so the TikWM fallback is off unless
  // a test opts in by passing tikwmKeys explicitly.
  for (const key of ['DATACENTER_PROXY', 'PROXY_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'YTDLP_BIN', 'TIKWMAPI_KEYS_SCRAPER']) {
    delete process.env[key];
  }
  process.env.PATH = `${dir}:${saved.PATH || ''}`;
  process.env.YTDLP_TIMEOUT_MS = '10000';
  process.env.FAKE_YTDLP_LOG = logFile;
  process.env.FAKE_YTDLP_MODE = mode;
  if (failFirst === undefined) {
    delete process.env.FAKE_YTDLP_FAIL_FIRST;
  } else {
    process.env.FAKE_YTDLP_FAIL_FIRST = String(failFirst);
  }
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

test('profile attempt succeeds on the 3rd attempt after 2 failures — exactly 3 invocations', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'fail-first-n', failFirst: 2, proxy: FAKE_PROXY });
  try {
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10),
    );
    assert.deepEqual(result, { ok: true, ids: PROFILE_IDS });

    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 3);
    for (const argv of invocations) {
      assert.equal(argv.at(-1), PROFILE_URL);
      const proxyIndex = argv.indexOf('--proxy');
      assert.ok(proxyIndex >= 0, 'every profile attempt must pass --proxy');
      assert.equal(argv[proxyIndex + 1], FAKE_PROXY);
      assert.ok(argv.includes('--flat-playlist'));
      assert.ok(argv.includes('-J'));
    }
    assertProxyValueNeverLogged(lines);
  } finally {
    restore();
  }
});

test('all 5 profile attempts failing returns error — exactly 5 invocations', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'all-fail', proxy: FAKE_PROXY });
  try {
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10),
    );
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);

    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 5);
    for (const argv of invocations) {
      assert.equal(argv.at(-1), PROFILE_URL);
    }
    assertProxyValueNeverLogged(lines);
  } finally {
    restore();
  }
});

test('without COUNTIK_PROXY_URL the profile attempt still runs, without --proxy', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'profile-ok', proxy: undefined });
  try {
    const result = await discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10);
    assert.deepEqual(result, { ok: true, ids: PROFILE_IDS });

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
    const result = await discoverReelIdsWithYtdlp('instagram', 'someuser', 10);
    assert.deepEqual(result, { ok: false, reason: 'platform_not_supported' });
    assert.deepEqual(readInvocations(logFile), []);
  } finally {
    restore();
  }
});

test('empty-stderr failure on retry attempts still redacts the proxy value', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'empty-stderr-fail', proxy: FAKE_PROXY });
  try {
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10),
    );
    assert.equal(result.ok, false);
    // Every attempt's detail came from err.message
    // (`Command failed: <binary> <full argv>`) because stderr was empty:
    // the returned reason is the last attempt's detail — redacted, never verbatim.
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
    assert.ok(result.reason.includes('Command failed'), `reason should keep the failure detail: ${result.reason}`);
    assert.ok(result.reason.includes('[proxy]'), `reason should show the redacted proxy: ${result.reason}`);
    assert.ok(!result.reason.includes(FAKE_PROXY) && !result.reason.includes('proxypass'));
    assertProxyValueNeverLogged(lines);
    assert.ok(
      lines.some((line) => line.includes('[proxy]')),
      `expected a redacted proxy in the logs: ${lines.join(' | ')}`,
    );

    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 5);
    for (const argv of invocations) {
      assert.equal(argv.at(-1), PROFILE_URL);
    }
  } finally {
    restore();
  }
});

test('timeout-killed first attempt never leaks the proxy value into logs or the returned reason', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'hang-profile', proxy: FAKE_PROXY });
  try {
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10),
    );
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
    assert.ok(result.reason.includes('[proxy]'), `reason should show the redacted proxy: ${result.reason}`);
    assert.ok(!result.reason.includes(FAKE_PROXY) && !result.reason.includes('proxypass'));
    assertProxyValueNeverLogged(lines);
    // The killed first attempt's detail came from err.message and must
    // appear redacted in its log line.
    assert.ok(
      lines.some((line) => line.includes('[proxy]')),
      `expected a redacted proxy in the logs: ${lines.join(' | ')}`,
    );

    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 5);
    for (const argv of invocations) {
      assert.equal(argv.at(-1), PROFILE_URL);
    }
  } finally {
    restore();
  }
});

// --- TikWM PRIMARY integration (spec scraper-tikwm-first-concurrency) ---
//
// The paid path runs FIRST on every TikTok claim: TikWM lookup, then
// ONE `tiktokuser:` direct attempt. The 5 profile-URL attempts run
// ONLY as backup, when the whole paid path fails.
// Fake fetch answers from a queue, one entry per call: { status, body }
// or an Error to throw. It records every call so tests can assert the
// TikWM lookup happened (or did not) and with which key header.

function stubTikwmFetch(queue) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, headers: { ...(init?.headers ?? {}) } });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    const status = next?.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => next?.body,
    };
  };
  return { fetchFn, calls };
}

function tikwmUserInfoBody(overrides = {}) {
  return {
    code: 0,
    msg: 'success',
    data: {
      user: {
        unique_id: 'courtroom62',
        uniqueId: 'courtroom62',
        nickname: 'Courtroom 62',
        secUid: FAKE_SECUID,
        id: 123456789,
        ...overrides,
      },
    },
  };
}

function assertTikwmKeyNeverLogged(lines) {
  assert.ok(
    lines.every((line) => !line.includes(FAKE_TIKWM_KEY)),
    `TikWM key leaked into logs: ${lines.join(' | ')}`,
  );
}

test('TikWM first: paid path succeeds → tiktokuser: runs first, zero profile attempts, exactly 1 invocation', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'fail-profile-direct-ok', proxy: FAKE_PROXY });
  try {
    const { fetchFn, calls } = stubTikwmFetch([{ status: 200, body: tikwmUserInfoBody() }]);
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, {
        tikwmKeys: [FAKE_TIKWM_KEY],
        fetchFn,
      }),
    );
    assert.deepEqual(result, { ok: true, ids: DIRECT_IDS });

    // Exactly 1 yt-dlp invocation total, and it is the direct attempt.
    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].at(-1), `tiktokuser:${FAKE_SECUID}`);
    // The direct attempt carries no --proxy (it runs direct, like the
    // old Countik path).
    assert.ok(!invocations[0].includes('--proxy'));

    // Exactly one TikWM call, keyed, for the profile username — and it
    // happened before any yt-dlp invocation (it is the first step).
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/user/info?unique_id=courtroom62'));
    assert.equal(calls[0].headers['x-tikwmapi-key'], FAKE_TIKWM_KEY);
    assertTikwmKeyNeverLogged(lines);
    assertProxyValueNeverLogged(lines);
  } finally {
    restore();
  }
});

test('paid path fails at lookup → the 5 profile attempts run as backup', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'fail-first-n', failFirst: 2, proxy: FAKE_PROXY });
  try {
    const { fetchFn, calls } = stubTikwmFetch([
      { status: 200, body: { code: 10401, msg: 'invalid key' } },
    ]);
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, {
        tikwmKeys: [FAKE_TIKWM_KEY],
        fetchFn,
      }),
    );
    assert.deepEqual(result, { ok: true, ids: PROFILE_IDS });

    // No direct attempt (the lookup never resolved a secUid); the
    // backup ran and succeeded on its 3rd attempt.
    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 3);
    assert.ok(invocations.every((argv) => argv.at(-1) === PROFILE_URL));
    assert.equal(calls.length, 1);
    assert.ok(result.ok);
    assertTikwmKeyNeverLogged(lines);
  } finally {
    restore();
  }
});

test('paid path fails at the direct attempt → the profile backup runs and recovers', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'fail-direct-profile-ok', proxy: FAKE_PROXY });
  try {
    const { fetchFn, calls } = stubTikwmFetch([{ status: 200, body: tikwmUserInfoBody() }]);
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, {
        tikwmKeys: [FAKE_TIKWM_KEY],
        fetchFn,
      }),
    );
    assert.deepEqual(result, { ok: true, ids: PROFILE_IDS });

    // 1 direct attempt (failed) + 1 profile backup attempt (succeeded).
    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 2);
    assert.equal(invocations[0].at(-1), `tiktokuser:${FAKE_SECUID}`);
    assert.equal(invocations[1].at(-1), PROFILE_URL);
    assert.equal(calls.length, 1);
    assertTikwmKeyNeverLogged(lines);
  } finally {
    restore();
  }
});

test('paid path fails entirely (lookup ok, direct fails, backup fails) → error recording both failures', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'all-fail', proxy: FAKE_PROXY });
  try {
    const { fetchFn, calls } = stubTikwmFetch([{ status: 200, body: tikwmUserInfoBody() }]);
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, {
        tikwmKeys: [FAKE_TIKWM_KEY],
        fetchFn,
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('tikwm direct attempt failed'));
    assert.ok(result.reason.includes('profile backup failed'));
    // 1 direct attempt + 5 profile backup attempts.
    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 6);
    assert.equal(invocations[0].at(-1), `tiktokuser:${FAKE_SECUID}`);
    assert.ok(invocations.slice(1).every((argv) => argv.at(-1) === PROFILE_URL));
    assert.equal(calls.length, 1);
    assertTikwmKeyNeverLogged(lines);
  } finally {
    restore();
  }
});

test('TikWM response with snake_case sec_uid only → lookup failure, backup runs, no direct attempt', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'all-fail', proxy: FAKE_PROXY });
  try {
    const { fetchFn, calls } = stubTikwmFetch([
      {
        status: 200,
        body: { code: 0, data: { user: { unique_id: 'courtroom62', sec_uid: FAKE_SECUID } } },
      },
    ]);
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, {
        tikwmKeys: [FAKE_TIKWM_KEY],
        fetchFn,
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('tikwm lookup failed (tikwm_missing_sec_uid)'));
    assert.ok(result.reason.includes('profile backup failed'));
    // Exactly 5 invocations, all profile backup: the direct attempt
    // never ran (no secUid was resolved).
    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 5);
    assert.ok(invocations.every((argv) => argv.at(-1) === PROFILE_URL));
    assert.equal(calls.length, 1);
    assertTikwmKeyNeverLogged(lines);
  } finally {
    restore();
  }
});

test('TikWM non-zero code → lookup failure, backup runs, no direct attempt, no crash', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'all-fail', proxy: FAKE_PROXY });
  try {
    const { fetchFn, calls } = stubTikwmFetch([
      { status: 200, body: { code: 10401, msg: 'invalid key' } },
    ]);
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, {
        tikwmKeys: [FAKE_TIKWM_KEY],
        fetchFn,
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('tikwm lookup failed (tikwm_nonzero_code)'));
    assert.ok(result.reason.includes('profile backup failed'));
    assert.equal(readInvocations(logFile).length, 5);
    assert.equal(calls.length, 1);
    assertTikwmKeyNeverLogged(lines);
  } finally {
    restore();
  }
});

test('TikWM timeout → lookup failure, backup runs, no key in the logged error', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'all-fail', proxy: FAKE_PROXY });
  try {
    const { fetchFn, calls } = stubTikwmFetch([
      new Error(`request timed out after 30000ms for key ${FAKE_TIKWM_KEY}`),
    ]);
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, {
        tikwmKeys: [FAKE_TIKWM_KEY],
        fetchFn,
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('tikwm lookup failed (tikwm_unreachable)'));
    assert.ok(result.reason.includes('profile backup failed'));
    assert.equal(readInvocations(logFile).length, 5);
    assert.equal(calls.length, 1);
    assertTikwmKeyNeverLogged(lines);
  } finally {
    restore();
  }
});

test('no TikWM keys configured → backup-only with a per-claim warning; TikWM never called; discovery still succeeds via backup', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'profile-ok', proxy: FAKE_PROXY });
  try {
    const { fetchFn, calls } = stubTikwmFetch([{ status: 200, body: tikwmUserInfoBody() }]);
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, { fetchFn }),
    );
    assert.deepEqual(result, { ok: true, ids: PROFILE_IDS });
    assert.ok(!result.reason, `backup success should carry no reason`);
    assert.equal(calls.length, 0);
    assert.equal(readInvocations(logFile).length, 1);
    assert.ok(
      lines.some((line) => line.includes('TikWM primary unavailable')),
      `expected a per-claim no-keys warning: ${lines.join(' | ')}`,
    );
    assertTikwmKeyNeverLogged(lines);
  } finally {
    restore();
  }
});

// --- Partial-results recovery (spec scraper-tikwm-first-concurrency §2) ---
//
// A yt-dlp attempt that exits non-zero can still carry usable IDs on
// stdout. Those IDs are recovered; zero valid IDs or unparseable
// stdout take the existing failure path.

test('partial results: exit 1 with valid-IDs JSON on stdout → IDs returned, job succeeds', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'partial-ids', proxy: FAKE_PROXY });
  try {
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10),
    );
    assert.deepEqual(result, { ok: true, ids: PROFILE_IDS });
    // Recovered on the FIRST backup attempt — no retries.
    assert.equal(readInvocations(logFile).length, 1);
    assert.ok(
      lines.some((line) => line.includes('recovered') && line.includes('partial ID')),
      `expected a partial-recovery log line: ${lines.join(' | ')}`,
    );
    assertProxyValueNeverLogged(lines);
  } finally {
    restore();
  }
});

test('partial results on the direct attempt: exit 1 with valid-IDs JSON → IDs returned, backup never runs', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'partial-direct-only', proxy: FAKE_PROXY });
  try {
    const { fetchFn, calls } = stubTikwmFetch([{ status: 200, body: tikwmUserInfoBody() }]);
    const { result } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, {
        tikwmKeys: [FAKE_TIKWM_KEY],
        fetchFn,
      }),
    );
    assert.deepEqual(result, { ok: true, ids: DIRECT_IDS });
    assert.equal(readInvocations(logFile).length, 1);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('partial results: exit 1 with JSON holding zero valid IDs → failure, existing reason', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'partial-zero-ids', proxy: FAKE_PROXY });
  try {
    const { result } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10),
    );
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
    // No recovery: all 5 backup attempts ran and failed.
    assert.equal(readInvocations(logFile).length, 5);
  } finally {
    restore();
  }
});

test('partial results: exit 1 with unparseable stdout → failure, existing reason', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'partial-unparseable', proxy: FAKE_PROXY });
  try {
    const { result } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10),
    );
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
    assert.equal(readInvocations(logFile).length, 5);
  } finally {
    restore();
  }
});
