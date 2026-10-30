import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { handleListPages } from '../../src/app/api/tenant/[subdomain]/pages/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Pages list card queue counts', () => {
  const userId = '11111111-1111-4111-a111-111111111111';
  const accountId = '22222222-2222-4222-a222-222222222222';
  const pageAId = '33333333-3333-4333-a333-333333333333';
  const pageBId = '44444444-4444-4444-a444-444444444444';
  let validSessionCookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const token = await signSessionToken(
      {
        userId,
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

  it('returns one grouped counts query for the whole slice, with per-page queued/posted/failed and zeros where a page has no queue rows', async () => {
    const executedQueries: string[] = [];
    const mockDb = {
      query: vi.fn().mockImplementation((sql: string) => {
        executedQueries.push(sql);
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (sql.includes('FROM queue_items')) {
          // Only page A has queue rows. `posted` here is the
          // published total; a publishing row is not a fourth
          // bucket in this grouped shape at all.
          return Promise.resolve([
            { destination_id: pageAId, queued: 2, posted: 5, failed: 1 },
          ]);
        }
        if (sql.includes('FROM destinations')) {
          return Promise.resolve([
            {
              id: pageAId,
              facebook_account_id: accountId,
              account_display_name: 'Alex Marketing',
              fb_page_id: 'page_a',
              page_name: 'Counted Page',
              profile_picture_url: null,
              category: 'Community',
              starting_followers: 1000,
              current_followers: 1000,
              status: 'active',
              tasks: ['CREATE_CONTENT'],
              created_at: '2026-10-09T10:00:00.000Z',
              updated_at: '2026-10-09T10:00:00.000Z',
            },
            {
              id: pageBId,
              facebook_account_id: accountId,
              account_display_name: 'Alex Marketing',
              fb_page_id: 'page_b',
              page_name: 'Empty Page',
              profile_picture_url: null,
              category: 'Community',
              starting_followers: 500,
              current_followers: 500,
              status: 'paused',
              tasks: ['CREATE_CONTENT'],
              created_at: '2026-10-08T10:00:00.000Z',
              updated_at: '2026-10-08T10:00:00.000Z',
            },
          ]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest('http://localhost:3000/api/tenant/acme/pages', {
      headers: { cookie: validSessionCookie },
    });
    const res = await handleListPages(req, 'acme', mockDb);
    expect(res.status).toBe(200);
    const json = await res.json();

    // Exactly one queue_items query for the whole slice — not one
    // per page, and grouped by destination, not per status.
    const queueQueries = executedQueries.filter((sql) =>
      sql.includes('FROM queue_items')
    );
    expect(queueQueries).toHaveLength(1);
    expect(queueQueries[0]).toContain('GROUP BY destination_id');
    expect(queueQueries[0]).toContain("status = 'queued'");
    expect(queueQueries[0]).toContain("status = 'published'");
    expect(queueQueries[0]).toContain("status = 'failed'");
    expect(queueQueries[0]).not.toContain("status = 'publishing'");

    type CardCounts = {
      queued: number;
      posted: number;
      failed: number;
    };
    const byName = new Map<string, CardCounts>(
      json.pages.map(
        (p: { pageName: string; queueCounts: CardCounts }) =>
          [p.pageName, p.queueCounts] as [string, CardCounts]
      )
    );

    // Wrong/missing counts must fail this test: page A carries its
    // grouped totals exactly, page B is present with zeros, not
    // with the row omitted.
    expect(byName.get('Counted Page')).toEqual({
      queued: 2,
      posted: 5,
      failed: 1,
    });
    expect(byName.get('Empty Page')).toEqual({
      queued: 0,
      posted: 0,
      failed: 0,
    });
  });

  it('flags a counts failure instead of rendering fake zeros (R6)', async () => {
    const mockDb = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (sql.includes('FROM queue_items')) {
          return Promise.reject(new Error('counts boom'));
        }
        if (sql.includes('FROM destinations')) {
          return Promise.resolve([
            {
              id: pageAId,
              facebook_account_id: accountId,
              account_display_name: 'Alex Marketing',
              fb_page_id: 'page_a',
              page_name: 'Counted Page',
              profile_picture_url: null,
              category: 'Community',
              starting_followers: 1000,
              current_followers: 1000,
              status: 'active',
              tasks: ['CREATE_CONTENT'],
              created_at: '2026-10-09T10:00:00.000Z',
              updated_at: '2026-10-09T10:00:00.000Z',
            },
          ]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;

    const req = new NextRequest('http://localhost:3000/api/tenant/acme/pages', {
      headers: { cookie: validSessionCookie },
    });
    const res = await handleListPages(req, 'acme', mockDb);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.pages).toHaveLength(1);
    // No numbers at all, plus the error flag — a page with a
    // failed counts query must be distinguishable from a page
    // that genuinely has zero queued/posted/failed posts.
    expect(json.pages[0].queueCounts).toBeUndefined();
    expect(json.pages[0].queueCountsError).toBe(true);
  });
});
