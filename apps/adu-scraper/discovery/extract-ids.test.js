import assert from 'node:assert/strict';
import test from 'node:test';
import { extractIdsFromYtdlpJson } from './extract-ids.js';

test('extractIdsFromYtdlpJson reads entries[].id', () => {
  const payload = {
    entries: [{ id: 'abc123' }, { id: 'def456' }],
  };
  assert.deepEqual(extractIdsFromYtdlpJson(payload, 'tiktok', 1000), ['abc123', 'def456']);
});

test('extractIdsFromYtdlpJson falls back to video URL for tiktok', () => {
  const payload = {
    entries: [{ url: 'https://www.tiktok.com/@user/video/999888777' }],
  };
  assert.deepEqual(extractIdsFromYtdlpJson(payload, 'tiktok', 1000), ['999888777']);
});

test('extractIdsFromYtdlpJson falls back to shorts URL for youtube', () => {
  const payload = {
    entries: [{ webpage_url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' }],
  };
  assert.deepEqual(extractIdsFromYtdlpJson(payload, 'youtube', 1000), ['dQw4w9WgXcQ']);
});

test('extractIdsFromYtdlpJson handles single-entry payload', () => {
  const payload = { id: 'solo-id', url: 'https://www.tiktok.com/@u/video/solo-id' };
  assert.deepEqual(extractIdsFromYtdlpJson(payload, 'tiktok', 1000), ['solo-id']);
});

test('extractIdsFromYtdlpJson respects maxCount', () => {
  const payload = {
    entries: [{ id: '1' }, { id: '2' }, { id: '3' }],
  };
  assert.deepEqual(extractIdsFromYtdlpJson(payload, 'youtube', 2), ['1', '2']);
});

test('extractIdsFromYtdlpJson filters out internal ByteDance asset IDs for tiktok', () => {
  const payload = {
    entries: [
      { id: 'vid:v12044gd0000abc123' },
      { id: '7675239682837466390' },
      { id: 'v09044g40000abcdefghij' },
    ],
  };
  assert.deepEqual(extractIdsFromYtdlpJson(payload, 'tiktok', 1000), ['7675239682837466390']);
});
