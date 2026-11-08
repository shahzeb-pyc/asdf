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
//                      fallback path: profile fails 5x, secUid resolves,
//                      direct feed returns DIRECT_IDS)
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

// --- TikWM secUid fallback integration (spec scraper-tikwm-fallback) ---
//
// The fallback runs ONLY after all 5 yt-dlp profile attempts fail.
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

test('yt-dlp success never calls the TikWM lookup', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'profile-ok', proxy: FAKE_PROXY });
  try {
    const { fetchFn, calls } = stubTikwmFetch([{ status: 200, body: tikwmUserInfoBody() }]);
    const { result } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, {
        tikwmKeys: [FAKE_TIKWM_KEY],
        fetchFn,
      }),
    );
    assert.deepEqual(result, { ok: true, ids: PROFILE_IDS });
    assert.equal(calls.length, 0);
    assert.equal(readInvocations(logFile).length, 1);
  } finally {
    restore();
  }
});

test('all 5 profile attempts fail + TikWM secUid success → tiktokuser: direct attempt happens', async () => {
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

    // 5 profile attempts + exactly 1 direct attempt.
    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 6);
    assert.equal(invocations.slice(0, 5).every((argv) => argv.at(-1) === PROFILE_URL), true);
    assert.equal(invocations[5].at(-1), `tiktokuser:${FAKE_SECUID}`);
    // The direct attempt carries no --proxy (it runs direct, like the
    // old Countik path).
    assert.ok(!invocations[5].includes('--proxy'));

    // Exactly one TikWM call, keyed, for the profile username.
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('/user/info?unique_id=courtroom62'));
    assert.equal(calls[0].headers['x-tikwmapi-key'], FAKE_TIKWM_KEY);
    assertTikwmKeyNeverLogged(lines);
    assertProxyValueNeverLogged(lines);
  } finally {
    restore();
  }
});

test('all 5 profile attempts fail + TikWM success but direct attempt fails → error, no crash', async () => {
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
    assert.ok(result.reason.includes('tikwm fallback direct attempt failed'));
    // 5 profile attempts + 1 direct attempt (which also fails).
    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 6);
    assert.equal(invocations[5].at(-1), `tiktokuser:${FAKE_SECUID}`);
    assert.equal(calls.length, 1);
    assertTikwmKeyNeverLogged(lines);
  } finally {
    restore();
  }
});

test('TikWM response with snake_case sec_uid only → lookup failure, no direct attempt', async () => {
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
    assert.ok(result.reason.includes('tikwm fallback failed (tikwm_missing_sec_uid)'));
    // Exactly 5 invocations: the direct attempt never ran.
    const invocations = readInvocations(logFile);
    assert.equal(invocations.length, 5);
    assert.ok(invocations.every((argv) => argv.at(-1) === PROFILE_URL));
    assert.equal(calls.length, 1);
    assertTikwmKeyNeverLogged(lines);
  } finally {
    restore();
  }
});

test('TikWM non-zero code → config errors as before, no direct attempt, no crash', async () => {
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
    assert.ok(result.reason.includes('tikwm fallback failed (tikwm_nonzero_code)'));
    assert.equal(readInvocations(logFile).length, 5);
    assert.equal(calls.length, 1);
    assertTikwmKeyNeverLogged(lines);
  } finally {
    restore();
  }
});

test('TikWM timeout → config errors as before, no key in the logged error', async () => {
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
    assert.ok(result.reason.includes('tikwm fallback failed (tikwm_unreachable)'));
    assert.equal(readInvocations(logFile).length, 5);
    assert.equal(calls.length, 1);
    assertTikwmKeyNeverLogged(lines);
  } finally {
    restore();
  }
});

test('no TikWM keys configured → fallback skipped silently, reason is the yt-dlp detail alone', async () => {
  const { logFile, restore } = await setupFakeYtdlp({ mode: 'all-fail', proxy: FAKE_PROXY });
  try {
    const { fetchFn, calls } = stubTikwmFetch([{ status: 200, body: tikwmUserInfoBody() }]);
    const { result, lines } = await withCapturedConsole(() =>
      discoverReelIdsWithYtdlp('tiktok', 'courtroom62', 10, { fetchFn }),
    );
    assert.equal(result.ok, false);
    assert.ok(!result.reason.includes('tikwm'), `fallback ran without keys: ${result.reason}`);
    assert.ok(result.reason.includes('fake yt-dlp: simulated failure'));
    assert.equal(calls.length, 0);
    assert.equal(readInvocations(logFile).length, 5);
    assertTikwmKeyNeverLogged(lines);
  } finally {
    restore();
  }
});
