import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PENDING_PLATFORM_ORDER, PLATFORM_ORDER } from './claim-rotation.js';

// Code-level block, owner order 2026-11-16 (temporary stop, not a
// removal): Instagram discovery must never run, even if an Instagram
// config is re-queued to `pending` / `browser_pending`. The claim loop
// in index.js only ever claims platforms in these two arrays, so
// Instagram being absent from both is what makes the block airtight.
describe('claim rotation (Instagram code-level block)', () => {
  it('does not include instagram in the browser_pending rotation', () => {
    assert.ok(!PLATFORM_ORDER.includes('instagram'));
  });

  it('does not include instagram in the pending rotation', () => {
    assert.ok(!PENDING_PLATFORM_ORDER.includes('instagram'));
  });

  it('keeps the full browser_pending rotation for the other platforms', () => {
    assert.deepEqual(PLATFORM_ORDER, ['tiktok', 'youtube', 'facebook']);
  });

  it('keeps the pending rotation for the other platforms (TikTok stays with its pool)', () => {
    assert.deepEqual(PENDING_PLATFORM_ORDER, ['youtube', 'facebook']);
  });
});
