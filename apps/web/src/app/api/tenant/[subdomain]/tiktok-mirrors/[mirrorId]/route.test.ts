/**
 * Mirror detail loader — spec 155 SEND BACK (PR #199, B1).
 *
 * `loadMirror` must select the mirror's own Facebook detail
 * (`fb_status`, `fb_rate_limited_at`) in BOTH paths — the detail
 * header, the Resume lock (B2) and the tick's own-anchor skip (B3)
 * all read it, and the original spec 155 build selected the old
 * column list here (a comment-only diff). The assertions below pin
 * the SELECT text itself, so removing either column from either
 * path fails the test — verified by hand: deleting both columns
 * from both SELECTs fails all four assertions, restoring them
 * passes again.
 */
import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isLegacyClient: vi.fn(),
}));

vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(),
  getRouteSupabase: vi.fn(() => null),
  isLegacyClient: mocks.isLegacyClient,
}));
vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveTenantWorkspaceId: vi.fn(),
}));
vi.mock('@/lib/billing/route-helpers', () => ({
  getBillingAdminClient: vi.fn(),
  subscriptionGateResponse: vi.fn(),
}));
vi.mock('@/lib/billing/entitlement', () => ({
  assertFeatureAddWithinCap: vi.fn(),
  getEntitlement: vi.fn(),
  registerUsage: vi.fn(),
  releaseUsageForFeature: vi.fn(),
  SubscriptionGateError: class SubscriptionGateError extends Error {},
}));
vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));
vi.mock('@/lib/server/pagination', () => ({
  paginateMeta: vi.fn(),
  parsePaginationParams: vi.fn(),
}));

import { loadMirror } from './route';

const MIRROR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKSPACE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const MIRROR_ROW = {
  id: MIRROR_ID,
  workspace_id: WORKSPACE_ID,
  source_platform: 'tiktok',
  source_username: 'creator',
  source_display_name: 'Creator',
  source_avatar_url: null,
  target_platform: 'facebook',
  target_external_id: '123456',
  target_display_name: 'Page',
  target_avatar_url: null,
  status: 'error',
  catch_up_pending: false,
  last_posted_source_id: null,
  last_posted_create_time: null,
  last_checked_at: null,
  next_check_at: null,
  last_error: 'boom',
  fb_status: 'fb_rate_limited',
  fb_rate_limited_at: '2026-11-01T00:00:00.000Z',
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
};

describe('loadMirror (spec 155 B1)', () => {
  it('selects fb_status and fb_rate_limited_at in the legacy SQL path', async () => {
    mocks.isLegacyClient.mockReturnValue(true);
    const query = vi.fn(async () => [MIRROR_ROW]);
    const mirror = await loadMirror({ query } as never, WORKSPACE_ID, MIRROR_ID);
    expect(query).toHaveBeenCalledTimes(1);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('fb_status');
    expect(sql).toContain('fb_rate_limited_at');
    expect(mirror?.fb_status).toBe('fb_rate_limited');
    expect(mirror?.fb_rate_limited_at).toBe('2026-11-01T00:00:00.000Z');
  });

  it('selects fb_status and fb_rate_limited_at in the Supabase path', async () => {
    mocks.isLegacyClient.mockReturnValue(false);
    let selectArg = '';
    const maybeSingle = vi.fn(async () => ({ data: MIRROR_ROW, error: null }));
    const eq = vi.fn(() => ({ eq, maybeSingle }));
    const select = vi.fn((arg: string) => {
      selectArg = arg;
      return { eq };
    });
    const from = vi.fn(() => ({ select }));
    const mirror = await loadMirror({ from } as never, WORKSPACE_ID, MIRROR_ID);
    expect(from).toHaveBeenCalledWith('mirrors');
    expect(selectArg).toContain('fb_status');
    expect(selectArg).toContain('fb_rate_limited_at');
    expect(mirror?.fb_status).toBe('fb_rate_limited');
    expect(mirror?.fb_rate_limited_at).toBe('2026-11-01T00:00:00.000Z');
  });
});
