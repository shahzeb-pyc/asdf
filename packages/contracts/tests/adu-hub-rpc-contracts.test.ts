import { describe, expect, it } from 'vitest';
import {
  AduHubListRowSchema,
  AduHubStatsRowSchema,
} from '../src/domain/adu.js';

/**
 * Unified hub RPC row schemas (ADU optimization F21): the list row is
 * the Facebook superset shape every platform's hub returns, and the
 * stats row is the one-row stats shape. Both are validated at the RPC
 * boundary in the three hub list routes — these tests pin the shape
 * the routes trust, including the lenient id fields (short ids in
 * the route-test fakes, per the AduConfigCountsSchema precedent).
 */
function listRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    workspace_id: 'ws-1',
    destination_id: 'dest-c1',
    source_platform: 'facebook',
    source_username: 'source-c1',
    timezone: 'UTC',
    posts_per_day: 2,
    schedule_type: 'dailyrandom',
    posting_times: ['09:00'],
    status: 'active',
    sync_status: 'synced',
    starting_followers: 10,
    current_followers: 100,
    followers_updated_at: null,
    display_name: null,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    total_count: 2,
    ...overrides,
  };
}

describe('AduHubListRowSchema (F21 unified hub list row)', () => {
  it('parses a full Facebook-superset row', () => {
    const parsed = AduHubListRowSchema.safeParse(listRow());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.total_count).toBe(2);
      expect(parsed.data.followers_updated_at).toBeNull();
    }
  });

  it('parses a Threads row (no followers_updated_at stamp, same shape)', () => {
    const parsed = AduHubListRowSchema.safeParse(
      listRow({ source_platform: 'tiktok', followers_updated_at: '2026-11-10T22:00:00.000Z' }),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects a row missing total_count', () => {
    const { total_count: _dropped, ...row } = listRow();
    expect(AduHubListRowSchema.safeParse(row).success).toBe(false);
  });

  it('rejects a wrong-typed followers count', () => {
    expect(
      AduHubListRowSchema.safeParse(listRow({ current_followers: '100' })).success,
    ).toBe(false);
  });

  it('rejects an unknown status value', () => {
    expect(AduHubListRowSchema.safeParse(listRow({ status: 'inactive' })).success).toBe(
      false,
    );
  });

  it('rejects a negative total_count', () => {
    expect(AduHubListRowSchema.safeParse(listRow({ total_count: -1 })).success).toBe(
      false,
    );
  });

  it('passes unknown extra columns through (forward-compatible rows)', () => {
    const parsed = AduHubListRowSchema.safeParse(listRow({ future_column: 'x' }));
    expect(parsed.success).toBe(true);
  });
});

describe('AduHubStatsRowSchema (F21 unified hub stats row)', () => {
  it('parses a stats row', () => {
    const parsed = AduHubStatsRowSchema.safeParse({
      total_count: 2,
      total_followers_sum: 400,
      net_gained_sum: 380,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.total_followers_sum).toBe(400);
  });

  it('rejects a missing sum', () => {
    expect(
      AduHubStatsRowSchema.safeParse({ total_count: 2, total_followers_sum: 400 })
        .success,
    ).toBe(false);
  });

  it('rejects a negative sum', () => {
    expect(
      AduHubStatsRowSchema.safeParse({
        total_count: 2,
        total_followers_sum: -1,
        net_gained_sum: 0,
      }).success,
    ).toBe(false);
  });
});
