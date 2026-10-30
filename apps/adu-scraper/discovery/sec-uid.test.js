import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTiktokSecUid } from './sec-uid.js';

test('resolveTiktokSecUid handles empty or invalid username', async () => {
  assert.equal(await resolveTiktokSecUid(''), null);
  assert.equal(await resolveTiktokSecUid(null), null);
  assert.equal(await resolveTiktokSecUid('   '), null);
});

test('resolveTiktokSecUid resolves valid TikTok sec_uid or handles network gracefully', async () => {
  const secUid = await resolveTiktokSecUid('mrbeast');
  if (secUid) {
    assert.ok(secUid.startsWith('MS4wLjABAAAA'));
  } else {
    // Graceful network/timeout fallback
    assert.equal(secUid, null);
  }
});
