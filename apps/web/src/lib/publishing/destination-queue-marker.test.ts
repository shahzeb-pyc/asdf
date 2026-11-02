/**
 * Destination queue helper: the publish-now marker (20261102140000).
 *
 * updateDestinationQueueItem writes publish_now_requested_at only
 * when the caller provides it; callers that omit it (retry) leave the
 * stored marker untouched, so a retried publish-now item re-enters
 * the immediate path.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/route-auth', () => ({
  isLegacyClient: vi.fn(() => true),
  getRouteSupabase: vi.fn(() => null),
}));

import { updateDestinationQueueItem } from './destination-queue';

const baseState = {
  caption: 'c',
  title: null,
  firstComment: null,
  linkUrl: null,
  kind: 'text',
  platformFormat: 'text',
  platformOptions: {},
  scheduledTime: new Date().toISOString(),
  slotId: null,
  status: 'queued',
  claimedAt: null,
  retryCount: 0,
};

describe('updateDestinationQueueItem publish-now marker', () => {
  it('writes the marker when provided, with shifted positional params', async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        seen.push({ sql, params });
        return [];
      }),
    };
    await updateDestinationQueueItem(
      client as never,
      'ws-1',
      'dest-1',
      'item-1',
      { ...baseState, publishNowRequestedAt: '2026-11-02T08:00:00.000Z' }
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sql).toContain('publish_now_requested_at = $13');
    expect(seen[0]!.sql).toContain('WHERE id = $14 AND workspace_id = $15 AND destination_id = $16');
    expect(seen[0]!.params[12]).toBe('2026-11-02T08:00:00.000Z');
    expect(seen[0]!.params[13]).toBe('item-1');
  });

  it('leaves the marker untouched when omitted', async () => {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        seen.push({ sql, params });
        return [];
      }),
    };
    await updateDestinationQueueItem(client as never, 'ws-1', 'dest-1', 'item-1', baseState);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sql).not.toContain('publish_now_requested_at');
    expect(seen[0]!.sql).toContain('WHERE id = $13 AND workspace_id = $14 AND destination_id = $15');
  });
});
