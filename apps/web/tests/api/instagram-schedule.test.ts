/**
 * Instagram Schedule API — list, add, slots, queue (SQL path).
 *
 * Guards pinned here: (1) the list only returns destinations whose
 * metadata carries scheduled=true and platform=instagram — an
 * unscheduled connected account never appears; (2) Add refuses an
 * expired account and refuses a second add of a scheduled account
 * (409) instead of duplicating slots; (3) slot creation refuses a
 * duplicate time (409); (4) queue rows keep their real kind, so a
 * carousel is labelled carousel, not image.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  handleListInstagramSchedule,
  handleAddInstagramSchedule,
} from '../../src/app/api/tenant/[subdomain]/instagram/schedule/route';
import { handleCreateInstagramScheduleSlot } from '../../src/app/api/tenant/[subdomain]/instagram/schedule/[destinationId]/slots/route';
import { handleListInstagramScheduleQueue } from '../../src/app/api/tenant/[subdomain]/instagram/schedule/[destinationId]/queue/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const USER_ID = '11111111-1111-4111-a111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-a222-222222222222';
const DEST_ID = '33333333-3333-4333-a333-333333333333';

let validSessionCookie: string;

const accountRow = {
  id: ACCOUNT_ID,
  display_name: 'Sunset Bakery',
  avatar_url: null,
  status: 'active',
  token_expires_at: '2027-01-01T00:00:00Z',
  external_account_id: 'ig-123',
};

const detailRow = {
  id: DEST_ID,
  account_id: ACCOUNT_ID,
  timezone: 'Asia/Karachi',
  status: 'active',
  metadata: { scheduled: true },
  name: 'Sunset Bakery',
  handle: 'sunset.bakery',
  avatar_url: null,
  created_at: '2026-10-12T00:00:00Z',
  updated_at: '2026-10-12T00:00:00Z',
  account_display_name: 'Sunset Bakery',
  account_avatar_url: null,
  account_status: 'active',
  account_token_expires_at: '2027-01-01T00:00:00Z',
  slot_count: 2,
  queued_count: 3,
  posted_count: 1,
  failed_count: 0,
};

function mockDb(
  capturedSql: string[],
  overrides: Record<string, unknown> = {}
) {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      capturedSql.push(sql);
      if (sql.includes('FROM workspaces')) {
        return Promise.resolve([{ id: 'ws_123' }]);
      }
      if (sql.includes('FROM social_accounts')) {
        return Promise.resolve(
          (overrides.accountRows as unknown[]) ?? [accountRow]
        );
      }
      if (sql.includes('INSERT INTO destinations')) {
        return Promise.resolve([{ id: DEST_ID }]);
      }
      if (sql.includes('INSERT INTO posting_slots')) {
        return Promise.resolve([
          {
            id: '44444444-4444-4444-a444-444444444444',
            destination_id: DEST_ID,
            time_of_day: '09:00',
            is_active: true,
            kind: ['image', 'reel', 'carousel'],
            created_at: '2026-10-12T00:00:00Z',
            updated_at: '2026-10-12T00:00:00Z',
          },
        ]);
      }
      // Destinations queries come first: the list/detail queries
      // contain posting_slots subqueries, so a posting_slots check
      // before this point would swallow the whole destination row.
      if (sql.includes('COUNT(*)::int AS total') && sql.includes('destinations')) {
        return Promise.resolve([
          { total: (overrides.countTotal as number) ?? 0 },
        ]);
      }
      if (sql.includes('SELECT metadata FROM destinations')) {
        return Promise.resolve([{ metadata: { scheduled: true } }]);
      }
      if (sql.includes('FROM destinations d')) {
        return Promise.resolve([detailRow]);
      }
      if (sql.includes('FROM destinations')) {
        return Promise.resolve((overrides.destRows as unknown[]) ?? []);
      }
      if (
        sql.includes('FROM posting_slots') &&
        sql.includes('time_of_day = $2')
      ) {
        return Promise.resolve((overrides.existingSlots as unknown[]) ?? []);
      }
      if (sql.includes('FROM posting_slots')) {
        return Promise.resolve((overrides.existingTimes as unknown[]) ?? []);
      }
      if (sql.includes('FROM queue_items qi') && sql.includes('LEFT JOIN')) {
        return Promise.resolve([
          {
            id: '55555555-5555-5555-a555-555555555555',
            destination_id: DEST_ID,
            slot_id: null,
            media_item_id: null,
            kind: 'carousel',
            platform_format: null,
            link_url: null,
            scheduled_time: '2026-11-02T09:00:00Z',
            caption: 'Weekend reel set',
            first_comment: null,
            status: 'queued',
            retry_count: 0,
            max_retries: 3,
            external_post_id: null,
            external_comment_id: null,
            created_at: '2026-10-31T00:00:00Z',
            updated_at: '2026-10-31T00:00:00Z',
            media_name: null,
          },
        ]);
      }
      if (sql.includes('COUNT(*)::int AS total')) {
        return Promise.resolve([{ total: 1 }]);
      }
      return Promise.resolve([]);
    }),
  } as unknown as DatabaseClient;
}

function request(
  url: string,
  init?: { method?: string; body?: unknown }
): NextRequest {
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: {
      cookie: validSessionCookie,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

describe('Instagram Schedule API', () => {
  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    const token = await signSessionToken(
      {
        userId: USER_ID,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    validSessionCookie = `fbup_session=${token}`;
  });

  it('lists only scheduled Instagram destinations, with queue counts', async () => {
    const capturedSql: string[] = [];
    const res = await handleListInstagramSchedule(
      request('http://localhost:3000/api/tenant/acme/instagram/schedule'),
      'acme',
      mockDb(capturedSql, { destRows: [], countTotal: 1 })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(1);
    expect(json.items[0].accountDisplayName).toBe('Sunset Bakery');
    expect(json.items[0].counts).toEqual({ queued: 3, posted: 1, failed: 0 });
    expect(json.items[0].slotCount).toBe(2);
    expect(
      capturedSql.some(
        (sql) =>
          sql.includes("platform = 'instagram'") &&
          sql.includes("metadata->>'scheduled' = 'true'")
      )
    ).toBe(true);
    expect(
      capturedSql.some((sql) => sql.includes("platform = 'facebook'"))
    ).toBe(false);
  });

  it('adds a new account to Schedule with timezone and slots', async () => {
    const capturedSql: string[] = [];
    const res = await handleAddInstagramSchedule(
      request('http://localhost:3000/api/tenant/acme/instagram/schedule', {
        method: 'POST',
        body: {
          accountId: ACCOUNT_ID,
          timezone: 'Asia/Karachi',
          postingTimes: [{ time: '09:00', formats: ['image', 'reel', 'carousel'] }],
        },
      }),
      'acme',
      mockDb(capturedSql)
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.destinationId).toBe(DEST_ID);
    expect(json.item.timezone).toBe('Asia/Karachi');
    expect(
      capturedSql.some((sql) => sql.includes('INSERT INTO posting_slots'))
    ).toBe(true);
  });

  it('refuses a second add of an already-scheduled account with 409', async () => {
    const capturedSql: string[] = [];
    const res = await handleAddInstagramSchedule(
      request('http://localhost:3000/api/tenant/acme/instagram/schedule', {
        method: 'POST',
        body: {
          accountId: ACCOUNT_ID,
          timezone: 'Asia/Karachi',
          postingTimes: [{ time: '09:00' }],
        },
      }),
      'acme',
      mockDb(capturedSql, { destRows: [detailRow] })
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/already in Schedule/);
    expect(
      capturedSql.some((sql) => sql.includes('INSERT INTO posting_slots'))
    ).toBe(false);
  });

  it('refuses an expired account with a reconnect message', async () => {
    const res = await handleAddInstagramSchedule(
      request('http://localhost:3000/api/tenant/acme/instagram/schedule', {
        method: 'POST',
        body: {
          accountId: ACCOUNT_ID,
          timezone: 'Asia/Karachi',
          postingTimes: [{ time: '09:00' }],
        },
      }),
      'acme',
      mockDb([], {
        accountRows: [{ ...accountRow, status: 'expired', token_expires_at: '2026-01-01T00:00:00Z' }],
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/reconnected/);
  });

  it('refuses a duplicate posting time with 409', async () => {
    const res = await handleCreateInstagramScheduleSlot(
      request(
        `http://localhost:3000/api/tenant/acme/instagram/schedule/${DEST_ID}/slots`,
        { method: 'POST', body: { time: '09:00', formats: ['image'] } }
      ),
      'acme',
      DEST_ID,
      mockDb([], {
        destRows: [
          {
            id: DEST_ID,
            timezone: 'Asia/Karachi',
            metadata: { scheduled: true },
          },
        ],
        existingSlots: [{ id: '44444444-4444-4444-a444-444444444444' }],
      })
    );
    expect(res.status).toBe(409);
  });

  it('keeps a carousel labelled carousel in the queue list', async () => {
    const res = await handleListInstagramScheduleQueue(
      request(
        `http://localhost:3000/api/tenant/acme/instagram/schedule/${DEST_ID}/queue`
      ),
      'acme',
      DEST_ID,
      mockDb([])
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(1);
    expect(json.items[0].kind).toBe('carousel');
    expect(json.items[0].displayFormat).toBe('carousel');
  });
});
