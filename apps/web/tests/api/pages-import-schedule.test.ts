/**
 * Import route schedule tests (Add Page steps 3–4): the same
 * timezone + posting times are applied to every imported
 * destination, slot writes are idempotent upserts (so a retry
 * cannot duplicate a time), any schedule failure returns 500 with
 * no success payload, and the boundary rejects incomplete or
 * duplicate schedules.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  encryptToken,
  signSessionToken,
} from '@fbuploadpro/contracts';
import { handleImportPages } from '../../src/app/api/tenant/[subdomain]/pages/import/route';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const userId = '11111111-1111-4111-a111-111111111111';
const accountId = '22222222-2222-4222-a222-222222222222';
const pageUuids: Record<string, string> = {
  page_1001: '33333333-3333-4333-a333-333333333333',
  page_1002: '44444444-4444-4444-a444-444444444444',
};

describe('Import with timezone + posting times', () => {
  let validSessionCookie: string;
  let sampleEncryptedAccountToken: string;

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
    sampleEncryptedAccountToken = await encryptToken(
      'mock_long_lived_account_token',
      TEST_ENCRYPTION_KEY
    );
  });

  function mockGraphPages() {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'page_1001',
              name: 'Brand Flagship Page',
              category: 'Retail Company',
              followers_count: 52000,
              tasks: ['CREATE_CONTENT'],
              access_token: 'page_token_1001',
              picture: { data: { url: null } },
            },
            {
              id: 'page_1002',
              name: 'Creator Vlog Page',
              category: 'Digital Creator',
              followers_count: 14000,
              tasks: ['CREATE_CONTENT'],
              access_token: 'page_token_1002',
              picture: { data: { url: null } },
            },
          ],
        }),
        { status: 200 }
      )
    );
  }

  function makeMockDb(options?: { failTimezoneFor?: string }) {
    const timezoneUpdates: unknown[][] = [];
    const slotInserts: unknown[][] = [];
    const mockDb = {
      query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
        if (sql.includes('FROM workspaces')) {
          return Promise.resolve([{ id: 'ws_123' }]);
        }
        if (sql.includes('FROM social_accounts')) {
          return Promise.resolve([
            {
              id: accountId,
              encryptedAccessToken: sampleEncryptedAccountToken,
              status: 'active',
            },
          ]);
        }
        if (sql.includes('INSERT INTO destinations')) {
          const fbPageId = String(params[2]);
          return Promise.resolve([
            {
              id: pageUuids[fbPageId],
              fbPageId,
              pageName: params[3],
            },
          ]);
        }
        if (sql.includes('UPDATE destinations')) {
          timezoneUpdates.push(params);
          if (options?.failTimezoneFor === String(params[1])) {
            return Promise.resolve([]);
          }
          return Promise.resolve([{ id: params[1] }]);
        }
        if (sql.includes('INSERT INTO posting_slots')) {
          slotInserts.push(params);
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      }),
    } as unknown as DatabaseClient;
    return { mockDb, timezoneUpdates, slotInserts };
  }

  function importRequest(body: unknown) {
    return new NextRequest(
      'http://localhost:3000/api/tenant/acme/pages/import',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: validSessionCookie,
        },
        body: JSON.stringify(body),
      }
    );
  }

  const scheduleBody = {
    accountId,
    selectedPageIds: ['page_1001', 'page_1002'],
    timezone: 'Asia/Karachi',
    postingTimes: [
      {
        slotTime: '09:00',
        allowedFormats: ['reel', 'image', 'video', 'story', 'text'],
      },
      { slotTime: '17:30', allowedFormats: ['reel', 'text'] },
    ],
  };

  it('applies the same timezone and times to every imported page via idempotent slot upserts', async () => {
    mockGraphPages();
    const { mockDb, timezoneUpdates, slotInserts } = makeMockDb();

    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockDb
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.importedCount).toBe(2);

    // One timezone update per page, with the same timezone.
    expect(timezoneUpdates).toHaveLength(2);
    for (const params of timezoneUpdates) {
      expect(params[0]).toBe('Asia/Karachi');
    }
    expect(new Set(timezoneUpdates.map((params) => params[1]))).toEqual(
      new Set([pageUuids.page_1001, pageUuids.page_1002])
    );

    // Two times × two pages, each as an upsert keyed on
    // destination + time — never a plain insert that could duplicate.
    expect(slotInserts).toHaveLength(4);
    const slotCalls = (mockDb.query as unknown as { mock: { calls: Array<[string, unknown[]]> } }).mock.calls.filter(
      ([sql]) => sql.includes('INSERT INTO posting_slots')
    );
    for (const [sql] of slotCalls) {
      expect(sql).toContain('ON CONFLICT (destination_id, time_of_day)');
      expect(sql).toContain('DO UPDATE SET');
    }
    const timesByPage = new Map<string, string[]>();
    for (const params of slotInserts) {
      const pageId = String(params[0]);
      timesByPage.set(pageId, [
        ...(timesByPage.get(pageId) ?? []),
        String(params[1]),
      ]);
    }
    expect(timesByPage.get(pageUuids.page_1001)).toEqual(['09:00', '17:30']);
    expect(timesByPage.get(pageUuids.page_1002)).toEqual(['09:00', '17:30']);
  });

  it('a retry re-sends the same schedule and still succeeds via the slot upsert', async () => {
    const { mockDb, slotInserts } = makeMockDb();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      mockGraphPages();
      const res = await handleImportPages(
        importRequest(scheduleBody),
        'acme',
        mockDb
      );
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
    }
    // Two attempts, same 4 slot upserts each — the second attempt
    // updates the existing rows instead of creating duplicates.
    expect(slotInserts).toHaveLength(8);
  });

  it('a schedule failure returns 500 with no success payload', async () => {
    mockGraphPages();
    const { mockDb } = makeMockDb({
      failTimezoneFor: pageUuids.page_1002,
    });

    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockDb
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.success).toBeUndefined();
    expect(json.error).toContain("Couldn't add the selected pages.");
  });

  it('rejects a timezone without times, times without a timezone, duplicate times, and empty formats at the boundary', async () => {
    const { mockDb } = makeMockDb();
    const cases: unknown[] = [
      { ...scheduleBody, postingTimes: undefined },
      { ...scheduleBody, timezone: undefined },
      {
        ...scheduleBody,
        postingTimes: [
          { slotTime: '09:00', allowedFormats: ['reel'] },
          { slotTime: '09:00', allowedFormats: ['text'] },
        ],
      },
      {
        ...scheduleBody,
        postingTimes: [{ slotTime: '09:00', allowedFormats: [] }],
      },
    ];
    for (const body of cases) {
      const res = await handleImportPages(importRequest(body), 'acme', mockDb);
      expect(res.status).toBe(400);
    }
  });
});
