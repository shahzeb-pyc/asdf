import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTiktokYtdlpArgs, DEFAULT_MOBILE_UA, TIKTOK_YTDLP_USER_AGENT } from './ytdlp-args.js';

const PROFILE_URL = 'https://www.tiktok.com/@user';
const SEC_UID_TARGET = 'tiktokuser:MS4wLjABAAAAtest';

test('buildTiktokYtdlpArgs matches flat-playlist flags', () => {
  const args = buildTiktokYtdlpArgs(PROFILE_URL, 500);
  assert.ok(args.includes('--flat-playlist'));
  assert.ok(args.includes('-J'));
  assert.ok(args.includes('--quiet'));
  assert.ok(args.includes('--no-check-certificates'));
  assert.equal(args.at(-1), PROFILE_URL);
});

test('buildTiktokYtdlpArgs sets playlist-items, mobile user-agent, headers and retries', () => {
  const args = buildTiktokYtdlpArgs(SEC_UID_TARGET, 250);
  assert.ok(args.includes('--playlist-items'));
  assert.ok(args.includes('1:250'));
  assert.ok(args.includes('--user-agent'));
  assert.ok(args.includes(DEFAULT_MOBILE_UA));
  assert.ok(args.includes('--add-header'));
  assert.ok(args.includes('Sec-Fetch-Dest: document'));
  assert.ok(args.includes('--retries'));
  assert.ok(args.includes('5'));
  assert.ok(args.includes('--extractor-retries'));
  assert.ok(args.includes('10'));
  assert.ok(args.includes('--socket-timeout'));
  assert.ok(args.includes('30'));
  assert.equal(args.at(-1), SEC_UID_TARGET);
});

test('buildTiktokYtdlpArgs includes proxy when provided in options', () => {
  const args = buildTiktokYtdlpArgs(PROFILE_URL, 100, { proxy: 'http://user:pass@1.2.3.4:8080' });
  assert.ok(args.includes('--proxy'));
  assert.ok(args.includes('http://user:pass@1.2.3.4:8080'));
});
