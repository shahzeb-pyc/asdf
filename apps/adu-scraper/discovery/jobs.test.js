// Tests for the shared upsert helpers (spec 203).
//
// jobs.js imports db.js, which calls process.exit(1) when the
// Supabase env vars are missing — so dummy values are set BEFORE
// the dynamic import. The upsert itself is exercised against a
// fake client (4th param), never a real database.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ??= 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-role-key';

const { buildReelInsertRows, upsertReelsAndMarkSynced } = await import('../jobs.js');

const CONFIG_ID = '11111111-2222-3333-4444-555555555555';
const JOB = { id: CONFIG_ID, source_handle: 'courtroom62', platform: 'tiktok' };

function fakeClient({ upsertError = null, updateError = null } = {}) {
  const recorded = { upserts: [], updates: [] };
  return {
    recorded,
    from(table) {
      return {
        upsert(rows, options) {
          recorded.upserts.push({ table, rows, options });
          return Promise.resolve({ error: upsertError });
        },
        update(patch) {
          return {
            eq(column, value) {
              recorded.updates.push({ table, patch, column, value });
              return Promise.resolve({ error: updateError });
            },
          };
        },
      };
    },
  };
}

test('buildReelInsertRows: plain string ids rank by position, view_count null', () => {
  assert.deepEqual(buildReelInsertRows(CONFIG_ID, ['a', 'b', 'c']), [
    { config_id: CONFIG_ID, source_reel_id: 'a', status: 'pending', discovery_rank: 1, view_count: null },
    { config_id: CONFIG_ID, source_reel_id: 'b', status: 'pending', discovery_rank: 2, view_count: null },
    { config_id: CONFIG_ID, source_reel_id: 'c', status: 'pending', discovery_rank: 3, view_count: null },
  ]);
});

test('buildReelInsertRows: entry objects carry their view_count, rank is position', () => {
  assert.deepEqual(
    buildReelInsertRows(CONFIG_ID, [
      { id: 'top', view_count: 9999 },
      { id: 'second', view_count: 100 },
      { id: 'unmeasured', view_count: null },
    ]),
    [
      { config_id: CONFIG_ID, source_reel_id: 'top', status: 'pending', discovery_rank: 1, view_count: 9999 },
      { config_id: CONFIG_ID, source_reel_id: 'second', status: 'pending', discovery_rank: 2, view_count: 100 },
      { config_id: CONFIG_ID, source_reel_id: 'unmeasured', status: 'pending', discovery_rank: 3, view_count: null },
    ],
  );
});

test('buildReelInsertRows: empty input produces no rows', () => {
  assert.deepEqual(buildReelInsertRows(CONFIG_ID, []), []);
  assert.deepEqual(buildReelInsertRows(CONFIG_ID, undefined), []);
});

test('upsertReelsAndMarkSynced: upserts ranked rows with ignoreDuplicates, then marks synced', async () => {
  const client = fakeClient();
  await upsertReelsAndMarkSynced(
    JOB,
    'tiktok',
    [
      { id: 'top', view_count: 9999 },
      { id: 'second', view_count: 100 },
    ],
    client,
  );

  assert.equal(client.recorded.upserts.length, 1);
  const [upsert] = client.recorded.upserts;
  assert.equal(upsert.table, 'adu_reels');
  assert.deepEqual(upsert.rows, [
    { config_id: CONFIG_ID, source_reel_id: 'top', status: 'pending', discovery_rank: 1, view_count: 9999 },
    { config_id: CONFIG_ID, source_reel_id: 'second', status: 'pending', discovery_rank: 2, view_count: 100 },
  ]);
  // The conflict rule is what makes re-ranks impossible: already-known
  // rows are silently skipped and keep their old rank / NULL.
  assert.deepEqual(upsert.options, {
    onConflict: 'config_id,source_reel_id',
    ignoreDuplicates: true,
  });

  assert.equal(client.recorded.updates.length, 1);
  assert.deepEqual(client.recorded.updates[0], {
    table: 'adu_configs',
    patch: { sync_status: 'synced' },
    column: 'id',
    value: CONFIG_ID,
  });
});

test('upsertReelsAndMarkSynced: plain string ids (other platforms) rank by position', async () => {
  const client = fakeClient();
  await upsertReelsAndMarkSynced(JOB, 'instagram', ['x', 'y'], client);
  assert.deepEqual(client.recorded.upserts[0].rows, [
    { config_id: CONFIG_ID, source_reel_id: 'x', status: 'pending', discovery_rank: 1, view_count: null },
    { config_id: CONFIG_ID, source_reel_id: 'y', status: 'pending', discovery_rank: 2, view_count: null },
  ]);
  assert.equal(client.recorded.updates.length, 1);
});

test('upsertReelsAndMarkSynced: insert failure throws and never marks synced', async () => {
  const client = fakeClient({ upsertError: new Error('insert boom') });
  await assert.rejects(
    () => upsertReelsAndMarkSynced(JOB, 'tiktok', [{ id: 'a', view_count: 1 }], client),
    /insert boom/,
  );
  assert.equal(client.recorded.updates.length, 0);
});

test('upsertReelsAndMarkSynced: mark-synced failure throws', async () => {
  const client = fakeClient({ updateError: new Error('update boom') });
  await assert.rejects(
    () => upsertReelsAndMarkSynced(JOB, 'tiktok', [{ id: 'a', view_count: 1 }], client),
    /update boom/,
  );
  assert.equal(client.recorded.upserts.length, 1);
});
