import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PENDING_PLATFORM_ORDER, PLATFORM_ORDER } from './claim-rotation.js';

// Block lifted (spec scraper-ig-residential-proxies): Instagram
// discovery runs again, through the dedicated Instagram browser
// behind the single residential proxy. The claim loop in index.js
// only ever claims platforms in these two arrays, so Instagram
// being back in both is what re-enables it.
describe('claim rotation (Instagram back in the rotation)', () => {
  it('includes instagram in the browser_pending rotation', () => {
    assert.ok(PLATFORM_ORDER.includes('instagram'));
  });

  it('includes instagram in the pending rotation', () => {
    assert.ok(PENDING_PLATFORM_ORDER.includes('instagram'));
  });

  it('keeps the full browser_pending rotation for the other platforms', () => {
    assert.deepEqual(PLATFORM_ORDER, ['instagram', 'tiktok', 'youtube', 'facebook']);
  });

  it('keeps the pending rotation for the other platforms (TikTok stays with its pool)', () => {
    assert.deepEqual(PENDING_PLATFORM_ORDER, ['instagram', 'youtube', 'facebook']);
  });
});
