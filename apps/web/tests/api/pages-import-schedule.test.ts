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
  page_1003: '55555555-5555-4555-a555-555555555555',
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

  function makeMockDb(options?: {
    failTimezoneFor?: string;
    missingTimezoneRow?: boolean;
    preExistingFbIds?: string[];
    preExisting?: Array<{
      fbPageId: string;
      status: string;
      fbStatus?: string;
      name?: string;
      avatarUrl?: string | null;
      encryptedToken?: string;
      metadata?: Record<string, unknown>;
    }>;
    oldTimezone?: string;
    oldSlots?: Array<{
      time_of_day: string;
      kind: string[];
      is_active: boolean;
    }>;
  }) {
    const timezoneUpdates: unknown[][] = [];
    const restoreUpdates: unknown[][] = [];
    const slotInserts: unknown[][] = [];
    const upsertSqls: string[] = [];
    const deleteQueries: string[] = [];
    const deleteCalls: Array<[string, unknown[]]> = [];
    const preExistingEntries: Array<{
      fbPageId: string;
      status: string;
      fbStatus?: string;
      name?: string;
      avatarUrl?: string | null;
      encryptedToken?: string;
      metadata?: Record<string, unknown>;
    }> = [
      ...(options?.preExistingFbIds ?? []).map((fbPageId) => ({
        fbPageId,
        status: 'active',
      })),
      ...(options?.preExisting ?? []),
    ];
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
        if (sql.includes('SELECT external_destination_id')) {
          return Promise.resolve(
            preExistingEntries.map((entry) => ({
              external_destination_id: entry.fbPageId,
              status: entry.status,
              fb_status: entry.fbStatus ?? null,
              name: entry.name ?? 'Old Page Name',
              avatar_url: entry.avatarUrl ?? null,
              encrypted_destination_token:
                entry.encryptedToken ?? 'old_encrypted_token',
              metadata: entry.metadata ?? {
                category: 'Old',
                starting_followers: 100,
                current_followers: 200,
              },
            }))
          );
        }
        if (sql.includes('SELECT timezone FROM destinations')) {
          return Promise.resolve(
            options?.missingTimezoneRow
              ? []
              : [{ timezone: options?.oldTimezone ?? 'America/New_York' }]
          );
        }
        if (
          sql.startsWith('SELECT') &&
          sql.includes('FROM posting_slots')
        ) {
          return Promise.resolve(
            options?.oldSlots ?? [
              { time_of_day: '08:00', kind: ['reel'], is_active: true },
            ]
          );
        }
        if (sql.startsWith('DELETE FROM')) {
          deleteQueries.push(sql);
          deleteCalls.push([sql, params]);
          return Promise.resolve([]);
        }
        if (sql.includes('INSERT INTO destinations')) {
          upsertSqls.push(sql);
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
          if (sql.includes('SET status')) {
            restoreUpdates.push(params);
            return Promise.resolve([{ id: params[2] }]);
          }
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
    return {
      mockDb,
      timezoneUpdates,
      restoreUpdates,
      slotInserts,
      upsertSqls,
      deleteQueries,
      deleteCalls,
    };
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

    // Two pages, one batched multi-row upsert per page, each keyed
    // on destination + time — never a plain insert that could
    // duplicate, and never one query per time.
    expect(slotInserts).toHaveLength(2);
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
      // Batched params: [pageId, time, formats, time, formats, ...]
      const times: string[] = [];
      for (let i = 1; i < params.length; i += 2) {
        times.push(String(params[i]));
      }
      timesByPage.set(pageId, times);
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
    // Two attempts, one batched upsert per page each — the second
    // attempt updates the existing rows instead of creating
    // duplicates.
    expect(slotInserts).toHaveLength(4);
  });

  it('a schedule failure returns the distinct schedule error and rolls back the pages created in this call', async () => {
    mockGraphPages();
    const { mockDb, deleteQueries } = makeMockDb({
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
    expect(json.code).toBe('SCHEDULE_FAILED');
    expect(json.error).toContain(
      "Couldn't save the posting times — try again, your timezone and times are kept"
    );
    // Rollback: slots first, then the destinations created here.
    expect(
      deleteQueries.some((sql) => sql.startsWith('DELETE FROM posting_slots'))
    ).toBe(true);
    expect(
      deleteQueries.some((sql) => sql.startsWith('DELETE FROM destinations'))
    ).toBe(true);
  });

  it('a failed schedule followed by a retry completes all pages', async () => {
    mockGraphPages();
    const failing = makeMockDb({
      failTimezoneFor: pageUuids.page_1002,
    });
    const failed = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      failing.mockDb
    );
    expect(failed.status).toBe(500);

    mockGraphPages();
    const succeeding = makeMockDb();
    const retried = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      succeeding.mockDb
    );
    expect(retried.status).toBe(200);
    expect((await retried.json()).success).toBe(true);
    expect(succeeding.timezoneUpdates).toHaveLength(2);
    expect(succeeding.slotInserts).toHaveLength(2);
  });

  it('a schedule is applied only to newly created pages, never to a pre-existing one', async () => {
    mockGraphPages();
    const { mockDb, timezoneUpdates, slotInserts } = makeMockDb({
      preExistingFbIds: ['page_1001'],
    });

    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockDb
    );
    expect(res.status).toBe(200);
    expect((await res.json()).importedCount).toBe(2);
    // Only page_1002 is new, so only it gets a timezone and slots.
    expect(timezoneUpdates).toHaveLength(1);
    expect(timezoneUpdates[0]?.[1]).toBe(pageUuids.page_1002);
    expect(slotInserts).toHaveLength(1);
    expect(slotInserts[0]?.[0]).toBe(pageUuids.page_1002);
  });

  it('a reactivated disconnected page gets the new timezone and exactly the new slots', async () => {
    mockGraphPages();
    const { mockDb, timezoneUpdates, slotInserts, deleteCalls } = makeMockDb({
      preExisting: [{ fbPageId: 'page_1001', status: 'disconnected' }],
    });

    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockDb
    );
    expect(res.status).toBe(200);
    expect((await res.json()).importedCount).toBe(2);
    // Both the reactivated page and the new page get the schedule.
    expect(timezoneUpdates).toHaveLength(2);
    expect(new Set(timezoneUpdates.map((params) => params[1]))).toEqual(
      new Set([pageUuids.page_1001, pageUuids.page_1002])
    );
    expect(timezoneUpdates.every((params) => params[0] === 'Asia/Karachi')).toBe(
      true
    );
    // The reactivated page's old slots are deleted before the new
    // schedule is inserted, so the final slots are exactly the new
    // times — the old 08:00 time never appears in its schedule.
    const reactivatedDelete = deleteCalls.find(
      ([sql, params]) =>
        sql === 'DELETE FROM posting_slots WHERE destination_id = $1' &&
        params[0] === pageUuids.page_1001
    );
    expect(reactivatedDelete).toBeDefined();
    const scheduleInsert = slotInserts.find(
      (params) => params[0] === pageUuids.page_1001
    );
    expect(scheduleInsert).toBeDefined();
    const times: string[] = [];
    for (let i = 1; scheduleInsert && i < scheduleInsert.length; i += 2) {
      times.push(String(scheduleInsert[i]));
    }
    expect(times).toEqual(['09:00', '17:30']);
  });

  it('a schedule failure after reactivation restores disconnected status, old timezone and old slots without deleting the destination', async () => {
    mockGraphPages();
    const { mockDb, restoreUpdates, slotInserts, deleteCalls } = makeMockDb({
      preExisting: [{ fbPageId: 'page_1001', status: 'disconnected' }],
      failTimezoneFor: pageUuids.page_1002,
    });

    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockDb
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.code).toBe('SCHEDULE_FAILED');
    // The newly created page is deleted; the reactivated page is
    // never in a destinations delete.
    const destinationDeletes = deleteCalls.filter(
      ([sql]) => sql.startsWith('DELETE FROM destinations')
    );
    expect(destinationDeletes).toHaveLength(1);
    expect(destinationDeletes[0]?.[1]?.[0]).toEqual([pageUuids.page_1002]);
    // The reactivated page is restored to disconnected with its
    // old timezone, and its old 08:00 slot is re-inserted.
    expect(restoreUpdates).toHaveLength(1);
    expect(restoreUpdates[0]?.slice(0, 3)).toEqual([
      'disconnected',
      'America/New_York',
      pageUuids.page_1001,
    ]);
    expect(
      slotInserts.some((params) => params.includes('08:00'))
    ).toBe(true);
  });

  it('a missing Postgres snapshot row aborts the schedule and restores status only, without touching timezone or slots', async () => {
    mockGraphPages();
    const { mockDb, restoreUpdates, timezoneUpdates, deleteCalls } =
      makeMockDb({
        preExisting: [{ fbPageId: 'page_1001', status: 'disconnected' }],
        missingTimezoneRow: true,
      });

    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockDb
    );
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('SCHEDULE_FAILED');
    // No schedule write at all, and the reactivated page is
    // restored to disconnected only: the status-only rollback
    // carries ['disconnected', pageId, workspaceId], never a
    // fabricated timezone.
    expect(timezoneUpdates).toHaveLength(0);
    expect(restoreUpdates).toHaveLength(1);
    expect(restoreUpdates[0]).toEqual([
      'disconnected',
      pageUuids.page_1001,
      'ws_123',
    ]);
    expect(
      deleteCalls.some(([, params]) =>
        JSON.stringify(params).includes(pageUuids.page_1001)
      )
    ).toBe(false);
  });

  it('a mixed batch failure deletes the new page, restores the reactivated page, and leaves the active page untouched', async () => {
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
            {
              id: 'page_1003',
              name: 'Third Page',
              category: 'Digital Creator',
              followers_count: 3000,
              tasks: ['CREATE_CONTENT'],
              access_token: 'page_token_1003',
              picture: { data: { url: null } },
            },
          ],
        }),
        { status: 200 }
      )
    );
    const { mockDb, timezoneUpdates, restoreUpdates, deleteCalls } =
      makeMockDb({
        preExisting: [
          { fbPageId: 'page_1001', status: 'disconnected' },
          { fbPageId: 'page_1002', status: 'active' },
        ],
        failTimezoneFor: pageUuids.page_1003,
      });

    const res = await handleImportPages(
      importRequest({
        ...scheduleBody,
        selectedPageIds: ['page_1001', 'page_1002', 'page_1003'],
      }),
      'acme',
      mockDb
    );
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('SCHEDULE_FAILED');
    // Schedule reached only the reactivated and the new page.
    expect(new Set(timezoneUpdates.map((params) => params[1]))).toEqual(
      new Set([pageUuids.page_1001, pageUuids.page_1003])
    );
    // Rollback deletes only the new page and restores only the
    // reactivated one; the active page appears in neither.
    const destinationDeletes = deleteCalls.filter(
      ([sql]) => sql.startsWith('DELETE FROM destinations')
    );
    expect(destinationDeletes).toHaveLength(1);
    expect(destinationDeletes[0]?.[1]?.[0]).toEqual([pageUuids.page_1003]);
    expect(restoreUpdates).toHaveLength(1);
    expect(restoreUpdates[0]?.slice(0, 3)).toEqual([
      'disconnected',
      'America/New_York',
      pageUuids.page_1001,
    ]);
  });

  it('when Graph returns fewer pages than selected, a scheduled import writes nothing and names the missing page (BG8)', async () => {
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
          ],
        }),
        { status: 200 }
      )
    );
    const { mockDb } = makeMockDb();
    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockDb
    );
    // BG8: loud, not silent — 422 naming the missing page, and
    // still nothing written.
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.code).toBe('PARTIAL_IMPORT');
    expect(json.error).toContain('page_1002');
    expect(json.skipped).toEqual([{ fbPageId: 'page_1002' }]);
    const destinationInserts = (
      mockDb.query as unknown as { mock: { calls: Array<[string, unknown[]]> } }
    ).mock.calls.filter(([sql]) => sql.includes('INSERT INTO destinations'));
    expect(destinationInserts).toHaveLength(0);
  });

  it('when Graph omits a page token, the import fails loud and never stores the user token as the page token (N4)', async () => {
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
              // No access_token: the old fallback stored the user
              // token here, which would read as connected and fail
              // only at publish time.
              picture: { data: { url: null } },
            },
          ],
        }),
        { status: 200 }
      )
    );
    const { mockDb } = makeMockDb();
    const res = await handleImportPages(
      importRequest({
        accountId,
        selectedPageIds: ['page_1001', 'page_1002'],
      }),
      'acme',
      mockDb
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.code).toBe('PARTIAL_IMPORT');
    expect(json.error).toContain('page_1002');
    expect(json.skipped).toEqual([{ fbPageId: 'page_1002' }]);
    const destinationInserts = (
      mockDb.query as unknown as { mock: { calls: Array<[string, unknown[]]> } }
    ).mock.calls.filter(([sql]) => sql.includes('INSERT INTO destinations'));
    expect(destinationInserts).toHaveLength(0);
  });

  it('re-importing a paused page refreshes its token but leaves it paused (BG8)', async () => {
    mockGraphPages();
    const { mockDb } = makeMockDb({
      preExisting: [
        {
          fbPageId: 'page_1001',
          status: 'disconnected',
          metadata: { fb_status: 'paused' },
        },
      ],
    });
    const res = await handleImportPages(
      importRequest({
        accountId,
        selectedPageIds: ['page_1001'],
      }),
      'acme',
      mockDb
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.importedCount).toBe(1);
    const upserts = (
      mockDb.query as unknown as { mock: { calls: Array<[string, unknown[]]> } }
    ).mock.calls.filter(([sql]) => sql.includes('INSERT INTO destinations'));
    expect(upserts).toHaveLength(1);
    // $10 = paused: the upsert keeps status 'disconnected' and
    // re-adds the fb_status marker instead of activating.
    expect(upserts[0][1][9]).toBe(true);
    expect(upserts[0][0]).toContain("WHEN $10 THEN 'disconnected'");
    expect(upserts[0][0]).toContain("jsonb_build_object('fb_status', 'paused')");
  });

  it('when Graph returns fewer pages than selected, a no-schedule import also fails loud instead of silently succeeding (BG8)', async () => {
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
          ],
        }),
        { status: 200 }
      )
    );
    const { mockDb } = makeMockDb();
    const res = await handleImportPages(
      importRequest({
        accountId,
        selectedPageIds: ['page_1001', 'page_1002'],
      }),
      'acme',
      mockDb
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.code).toBe('PARTIAL_IMPORT');
    expect(json.error).toContain('page_1002');
    const destinationInserts = (
      mockDb.query as unknown as { mock: { calls: Array<[string, unknown[]]> } }
    ).mock.calls.filter(([sql]) => sql.includes('INSERT INTO destinations'));
    expect(destinationInserts).toHaveLength(0);
  });

  it('duplicate selected page ids collapse to one import per page', async () => {
    mockGraphPages();
    const { mockDb, timezoneUpdates } = makeMockDb();
    const res = await handleImportPages(
      importRequest({
        ...scheduleBody,
        selectedPageIds: ['page_1001', 'page_1001', 'page_1002'],
      }),
      'acme',
      mockDb
    );
    expect(res.status).toBe(200);
    expect((await res.json()).importedCount).toBe(2);
    expect(timezoneUpdates).toHaveLength(2);
  });

  it('rejects a non-IANA timezone and more than 24 posting times at the boundary', async () => {
    const { mockDb } = makeMockDb();
    const badTimezone = await handleImportPages(
      importRequest({ ...scheduleBody, timezone: 'Not/AZone' }),
      'acme',
      mockDb
    );
    expect(badTimezone.status).toBe(400);
    const tooManyTimes = await handleImportPages(
      importRequest({
        ...scheduleBody,
        postingTimes: Array.from({ length: 25 }, (_, i) => ({
          slotTime: `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 === 0 ? '00' : '30'}`,
          allowedFormats: ['reel'],
        })),
      }),
      'acme',
      mockDb
    );
    expect(tooManyTimes.status).toBe(400);
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

  // Supabase path: the route's production path (no Postgres client
  // passed in). A chainable query-builder mock mirrors the real
  // Postgrest builder closely enough for the route's calls:
  // from().select().eq().in().maybeSingle()/single(), upsert/update/
  // delete awaited directly.
  function makeMockSupabase(options?: {
    existingFbIds?: string[];
    existing?: Array<{
      fbPageId: string;
      status: string;
      name?: string;
      avatarUrl?: string | null;
      encryptedToken?: string;
      metadata?: Record<string, unknown>;
    }>;
    failScheduleFor?: string;
    failSlotUpsert?: boolean;
    failExistingQuery?: boolean;
    failSnapshotTimezone?: boolean;
    failSnapshotSlots?: boolean;
    oldTimezone?: string;
    oldSlots?: Array<{
      time_of_day: string;
      kind: string[];
      is_active: boolean;
    }>;
  }) {
    const slotUpserts: unknown[] = [];
    const destinationUpserts: unknown[] = [];
    const deletes: Array<{ table: string; filters: Record<string, unknown> }> =
      [];
    const timezoneUpdates: unknown[] = [];
    const restoreUpdates: Array<Record<string, unknown>> = [];
    // Filters the existing-destinations load was issued with, so
    // tests can pin that it is account-scoped (K9).
    const existingLoadFilters: Array<Record<string, unknown>> = [];
    const existingEntries: Array<{
      fbPageId: string;
      status: string;
      name?: string;
      avatarUrl?: string | null;
      encryptedToken?: string;
      metadata?: Record<string, unknown>;
    }> = [
      ...(options?.existingFbIds ?? []).map((fbPageId) => ({
        fbPageId,
        status: 'active',
      })),
      ...(options?.existing ?? []),
    ];
    const defaultOldSlots = [
      { time_of_day: '08:00', kind: ['reel'], is_active: true },
    ];

    class MockQuery {
      table: string;
      op: 'select' | 'upsert' | 'update' | 'delete' = 'select';
      payload: unknown = undefined;
      filters: Record<string, unknown> = {};
      constructor(table: string) {
        this.table = table;
      }
      select() {
        return this;
      }
      eq(key: string, value: unknown) {
        this.filters[key] = value;
        return this;
      }
      in(key: string, value: unknown) {
        this.filters[key] = value;
        return this;
      }
      upsert(payload: unknown) {
        this.op = 'upsert';
        this.payload = payload;
        if (this.table === 'posting_slots') {
          slotUpserts.push(payload);
        }
        return this;
      }
      update(payload: unknown) {
        this.op = 'update';
        this.payload = payload;
        return this;
      }
      delete() {
        this.op = 'delete';
        return this;
      }
      async maybeSingle() {
        return this.resolveSingle();
      }
      async single() {
        return this.resolveSingle();
      }
      then(
        resolve: (value: unknown) => void,
        reject?: (reason: unknown) => void
      ) {
        try {
          resolve(this.resolveAwait());
        } catch (err) {
          reject?.(err);
        }
      }
      private resolveSingle(): { data: unknown; error: unknown } {
        if (this.table === 'workspaces') {
          return { data: { id: 'ws_123' }, error: null };
        }
        if (this.table === 'social_accounts') {
          return {
            data: { encrypted_access_token: sampleEncryptedAccountToken },
            error: null,
          };
        }
        if (this.table === 'destinations' && this.op === 'select') {
          if (options?.failSnapshotTimezone) {
            return { data: null, error: { message: 'tz boom' } };
          }
          return {
            data: {
              id: this.filters.id,
              timezone: options?.oldTimezone ?? 'America/New_York',
            },
            error: null,
          };
        }
        if (this.table === 'destinations' && this.op === 'upsert') {
          const payload = this.payload as Record<string, unknown>;
          destinationUpserts.push(payload);
          const fbPageId = String(payload.external_destination_id);
          return {
            data: {
              id: pageUuids[fbPageId],
              external_destination_id: fbPageId,
              name: payload.name,
            },
            error: null,
          };
        }
        if (this.table === 'destinations' && this.op === 'update') {
          const payload = this.payload as Record<string, unknown>;
          if (payload.status === 'disconnected') {
            restoreUpdates.push(payload);
          } else {
            timezoneUpdates.push(this.filters.id);
          }
          if (options?.failScheduleFor === String(this.filters.id)) {
            return { data: null, error: null };
          }
          return { data: { id: this.filters.id }, error: null };
        }
        return { data: null, error: null };
      }
      private resolveAwait(): { data: unknown; error: unknown } {
        if (this.table === 'destinations' && this.op === 'select') {
          if (options?.failExistingQuery) {
            return { data: null, error: { message: 'existing boom' } };
          }
          existingLoadFilters.push({ ...this.filters });
          return {
            data: existingEntries.map((entry) => ({
              external_destination_id: entry.fbPageId,
              status: entry.status,
              metadata: entry.metadata ?? { starting_followers: 100 },
              name: entry.name ?? 'Old Page Name',
              avatar_url: entry.avatarUrl ?? null,
              encrypted_destination_token:
                entry.encryptedToken ?? 'old_encrypted_token',
            })),
            error: null,
          };
        }
        if (this.table === 'destinations' && this.op === 'update') {
          const payload = this.payload as Record<string, unknown>;
          if (payload.status === 'disconnected') {
            restoreUpdates.push(payload);
          } else {
            timezoneUpdates.push(this.filters.id);
          }
          return { data: { id: this.filters.id }, error: null };
        }
        if (this.table === 'posting_slots' && this.op === 'select') {
          if (options?.failSnapshotSlots) {
            return { data: null, error: { message: 'slots boom' } };
          }
          return {
            data: options?.oldSlots ?? defaultOldSlots,
            error: null,
          };
        }
        if (this.table === 'posting_slots' && this.op === 'upsert') {
          if (options?.failSlotUpsert) {
            return { data: null, error: { message: 'slot boom' } };
          }
          return { data: this.payload, error: null };
        }
        if (this.op === 'delete') {
          deletes.push({ table: this.table, filters: { ...this.filters } });
          return { data: null, error: null };
        }
        return { data: null, error: null };
      }
    }

    const mockSupabase = {
      from: (table: string) => new MockQuery(table),
    };
    return {
      mockSupabase,
      slotUpserts,
      destinationUpserts,
      deletes,
      timezoneUpdates,
      restoreUpdates,
      existingLoadFilters,
    };
  }

  it('applies the schedule on the Supabase path and skips pre-existing pages', async () => {
    mockGraphPages();
    const { mockSupabase, slotUpserts, timezoneUpdates } = makeMockSupabase({
      existingFbIds: ['page_1001'],
    });
    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockSupabase as never
    );
    expect(res.status).toBe(200);
    expect((await res.json()).importedCount).toBe(2);
    // Only the new page gets a timezone update and a slot upsert.
    expect(timezoneUpdates).toEqual([pageUuids.page_1002]);
    expect(slotUpserts).toHaveLength(1);
    expect(
      (slotUpserts[0] as Array<Record<string, unknown>>).map(
        (row) => row.time_of_day
      )
    ).toEqual(['09:00', '17:30']);
  });

  it('a Supabase schedule failure returns the distinct error and deletes the created pages', async () => {
    mockGraphPages();
    const { mockSupabase, deletes } = makeMockSupabase({
      failScheduleFor: pageUuids.page_1002,
    });
    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockSupabase as never
    );
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.code).toBe('SCHEDULE_FAILED');
    expect(json.error).toContain("Couldn't save the posting times");
    expect(deletes.some((d) => d.table === 'posting_slots')).toBe(true);
    expect(deletes.some((d) => d.table === 'destinations')).toBe(true);
    expect(
      deletes
        .filter((d) => d.table === 'destinations')
        .flatMap((d) => d.filters.id as string[])
    ).toEqual(
      expect.arrayContaining([pageUuids.page_1001, pageUuids.page_1002])
    );
  });

  it('a Supabase reactivated disconnected page gets the new schedule and replaces old slots', async () => {
    mockGraphPages();
    const { mockSupabase, slotUpserts, timezoneUpdates, deletes } =
      makeMockSupabase({
        existing: [{ fbPageId: 'page_1001', status: 'disconnected' }],
      });
    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockSupabase as never
    );
    expect(res.status).toBe(200);
    expect((await res.json()).importedCount).toBe(2);
    // Both the reactivated page and the new page get the schedule.
    expect(new Set(timezoneUpdates)).toEqual(
      new Set([pageUuids.page_1001, pageUuids.page_1002])
    );
    // The reactivated page's old slots are deleted before its new
    // upsert, and its upsert carries exactly the new times.
    expect(
      deletes.some(
        (d) =>
          d.table === 'posting_slots' &&
          d.filters.destination_id === pageUuids.page_1001
      )
    ).toBe(true);
    expect(slotUpserts).toHaveLength(2);
    const reactivatedUpsert = slotUpserts.find(
      (rows) =>
        (rows as Array<Record<string, unknown>>)[0]?.destination_id ===
        pageUuids.page_1001
    ) as Array<Record<string, unknown>>;
    expect(reactivatedUpsert.map((row) => row.time_of_day)).toEqual([
      '09:00',
      '17:30',
    ]);
  });

  it('a Supabase schedule failure after reactivation restores the page instead of deleting it', async () => {
    mockGraphPages();
    const { mockSupabase, deletes, restoreUpdates } = makeMockSupabase({
      existing: [{ fbPageId: 'page_1001', status: 'disconnected' }],
      failScheduleFor: pageUuids.page_1002,
    });
    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockSupabase as never
    );
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('SCHEDULE_FAILED');
    // Only the newly created page is in a destinations delete.
    const destinationDeletes = deletes.filter(
      (d) => d.table === 'destinations'
    );
    expect(destinationDeletes).toHaveLength(1);
    expect(destinationDeletes[0]?.filters.id).toEqual([pageUuids.page_1002]);
    // The reactivated page is restored to disconnected with its
    // old timezone, and its old slot is re-upserted.
    expect(restoreUpdates).toHaveLength(1);
    expect(restoreUpdates[0]?.status).toBe('disconnected');
    expect(restoreUpdates[0]?.timezone).toBe('America/New_York');
  });

  it('a Supabase existing-pages query error aborts the import with no upsert and no schedule write', async () => {
    mockGraphPages();
    const {
      mockSupabase,
      destinationUpserts,
      slotUpserts,
      timezoneUpdates,
      deletes,
    } = makeMockSupabase({
      existing: [{ fbPageId: 'page_1001', status: 'active' }],
      failExistingQuery: true,
    });
    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockSupabase as never
    );
    expect(res.status).toBe(500);
    // An error is never read as "no pages exist": no destination
    // upsert, no timezone update, no slot write, no rollback
    // delete of any pre-existing page.
    expect(destinationUpserts).toHaveLength(0);
    expect(slotUpserts).toHaveLength(0);
    expect(timezoneUpdates).toHaveLength(0);
    expect(deletes).toHaveLength(0);
  });

  it('a Supabase snapshot query error restores the reactivated page to disconnected only, leaving its timezone and slots untouched', async () => {
    mockGraphPages();
    const { mockSupabase, deletes, restoreUpdates, timezoneUpdates } =
      makeMockSupabase({
        existing: [{ fbPageId: 'page_1001', status: 'disconnected' }],
        failSnapshotTimezone: true,
      });
    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockSupabase as never
    );
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('SCHEDULE_FAILED');
    // The schedule is aborted before any timezone write, and the
    // rollback restores status only — no timezone field on the
    // restore, no slot delete and no destination delete for the
    // reactivated page.
    expect(timezoneUpdates).toHaveLength(0);
    expect(restoreUpdates).toHaveLength(1);
    expect(restoreUpdates[0]?.status).toBe('disconnected');
    expect(restoreUpdates[0]?.timezone).toBeUndefined();
    expect(
      deletes.some(
        (d) =>
          d.table === 'posting_slots' &&
          JSON.stringify(d.filters).includes(pageUuids.page_1001)
      )
    ).toBe(false);
    expect(
      deletes.some(
        (d) =>
          d.table === 'destinations' &&
          JSON.stringify(d.filters).includes(pageUuids.page_1001)
      )
    ).toBe(false);
  });

  it('a Supabase snapshot slot query error also restores the reactivated page to disconnected only', async () => {
    mockGraphPages();
    const { mockSupabase, restoreUpdates, timezoneUpdates } =
      makeMockSupabase({
        existing: [{ fbPageId: 'page_1001', status: 'disconnected' }],
        failSnapshotSlots: true,
      });
    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockSupabase as never
    );
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('SCHEDULE_FAILED');
    expect(timezoneUpdates).toHaveLength(0);
    expect(restoreUpdates).toHaveLength(1);
    expect(restoreUpdates[0]?.status).toBe('disconnected');
    expect(restoreUpdates[0]?.timezone).toBeUndefined();
  });

  it('a Supabase mixed batch failure deletes the new page, restores the reactivated page, and leaves the active page untouched', async () => {
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
            {
              id: 'page_1003',
              name: 'Third Page',
              category: 'Digital Creator',
              followers_count: 3000,
              tasks: ['CREATE_CONTENT'],
              access_token: 'page_token_1003',
              picture: { data: { url: null } },
            },
          ],
        }),
        { status: 200 }
      )
    );
    const { mockSupabase, timezoneUpdates, restoreUpdates, deletes } =
      makeMockSupabase({
        existing: [
          { fbPageId: 'page_1001', status: 'disconnected' },
          { fbPageId: 'page_1002', status: 'active' },
        ],
        failScheduleFor: pageUuids.page_1003,
      });
    const res = await handleImportPages(
      importRequest({
        ...scheduleBody,
        selectedPageIds: ['page_1001', 'page_1002', 'page_1003'],
      }),
      'acme',
      mockSupabase as never
    );
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('SCHEDULE_FAILED');
    // Schedule reached only the reactivated and the new page.
    expect(new Set(timezoneUpdates)).toEqual(
      new Set([pageUuids.page_1001, pageUuids.page_1003])
    );
    const destinationDeletes = deletes.filter(
      (d) => d.table === 'destinations'
    );
    expect(destinationDeletes).toHaveLength(1);
    expect(destinationDeletes[0]?.filters.id).toEqual([pageUuids.page_1003]);
    expect(restoreUpdates).toHaveLength(1);
    expect(restoreUpdates[0]?.status).toBe('disconnected');
  });

  it('a Supabase retry after a slot failure succeeds without duplicating', async () => {
    mockGraphPages();
    const failing = makeMockSupabase({ failSlotUpsert: true });
    const failed = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      failing.mockSupabase as never
    );
    expect(failed.status).toBe(500);

    mockGraphPages();
    const succeeding = makeMockSupabase();
    const retried = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      succeeding.mockSupabase as never
    );
    expect(retried.status).toBe(200);
    expect(succeeding.slotUpserts).toHaveLength(2);
  });

  // ---- Area 3 (R16–R18, K9): paused re-import, rollback restore,
  // cross-account classification ----

  it('a paused page is not reactivated: no schedule, no slot deletion, upsert keeps it paused', async () => {
    mockGraphPages();
    const { mockDb, timezoneUpdates, slotInserts, upsertSqls, deleteCalls } =
      makeMockDb({
        preExisting: [
          { fbPageId: 'page_1001', status: 'disconnected', fbStatus: 'paused' },
        ],
      });

    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockDb
    );
    expect(res.status).toBe(200);
    expect((await res.json()).importedCount).toBe(2);
    // Only the genuinely new page gets a timezone and slots — the
    // paused page is not a schedule target.
    expect(timezoneUpdates).toHaveLength(1);
    expect(timezoneUpdates[0]?.[1]).toBe(pageUuids.page_1002);
    expect(slotInserts).toHaveLength(1);
    expect(slotInserts[0]?.[0]).toBe(pageUuids.page_1002);
    // Its old slots are never deleted either.
    expect(
      deleteCalls.some(
        ([, params]) => params[0] === pageUuids.page_1001
      )
    ).toBe(false);
    // And the upsert itself preserves the paused state instead of
    // flipping the row to active and stripping the marker.
    expect(upsertSqls).toHaveLength(2);
    expect(upsertSqls[0]).toContain("fb_status' = 'paused'");
  });

  it('a schedule failure after reactivation restores the pre-upsert name, avatar, token and metadata', async () => {
    mockGraphPages();
    const oldMetadata = {
      category: 'OldCat',
      starting_followers: 100,
      current_followers: 200,
      custom: 'keep',
    };
    const { mockDb, restoreUpdates } = makeMockDb({
      preExisting: [
        {
          fbPageId: 'page_1001',
          status: 'disconnected',
          name: 'Old Brand',
          avatarUrl: 'https://old.example/a.png',
          encryptedToken: 'old_enc_token',
          metadata: oldMetadata,
        },
      ],
      failTimezoneFor: pageUuids.page_1002,
    });

    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockDb
    );
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('SCHEDULE_FAILED');
    // Param order keeps [status, timezone, id] first; the restored
    // pre-upsert columns follow — never fabricated values.
    expect(restoreUpdates).toHaveLength(1);
    expect(restoreUpdates[0]).toEqual([
      'disconnected',
      'America/New_York',
      pageUuids.page_1001,
      'ws_123',
      'Old Brand',
      'https://old.example/a.png',
      'old_enc_token',
      JSON.stringify(oldMetadata),
    ]);
  });

  it('Supabase: a paused page keeps its status, marker and baseline on re-import', async () => {
    mockGraphPages();
    const { mockSupabase, destinationUpserts } = makeMockSupabase({
      existing: [
        {
          fbPageId: 'page_1001',
          status: 'disconnected',
          metadata: {
            fb_status: 'paused',
            starting_followers: 777,
            current_followers: 900,
          },
        },
      ],
    });
    const res = await handleImportPages(
      importRequest({
        accountId,
        selectedPageIds: ['page_1001'],
      }),
      'acme',
      mockSupabase as never
    );
    expect(res.status).toBe(200);
    expect(destinationUpserts).toHaveLength(1);
    const payload = destinationUpserts[0] as Record<string, unknown>;
    expect(payload.status).toBe('disconnected');
    const metadata = payload.metadata as Record<string, unknown>;
    expect(metadata.fb_status).toBe('paused');
    // The Graph followers (52000) must not overwrite the baseline
    // of a page that was never truly disconnected.
    expect(metadata.starting_followers).toBe(777);
    expect(metadata.current_followers).toBe(52000);
  });

  it('Supabase: a paused page gets no schedule on re-import', async () => {
    mockGraphPages();
    const { mockSupabase, slotUpserts, timezoneUpdates } = makeMockSupabase({
      existing: [
        {
          fbPageId: 'page_1001',
          status: 'disconnected',
          metadata: {
            fb_status: 'paused',
            starting_followers: 777,
          },
        },
      ],
    });
    const res = await handleImportPages(
      importRequest(scheduleBody),
      'acme',
      mockSupabase as never
    );
    expect(res.status).toBe(200);
    expect(timezoneUpdates).toEqual([pageUuids.page_1002]);
    expect(slotUpserts).toHaveLength(1);
    expect(
      (slotUpserts[0] as Array<Record<string, unknown>>)[0]?.destination_id
    ).toBe(pageUuids.page_1002);
  });

  it('Supabase: the existing-destinations load is scoped to the importing account', async () => {
    mockGraphPages();
    const { mockSupabase, existingLoadFilters } = makeMockSupabase();
    const res = await handleImportPages(
      importRequest({
        accountId,
        selectedPageIds: ['page_1001'],
      }),
      'acme',
      mockSupabase as never
    );
    expect(res.status).toBe(200);
    // The upsert key is (account_id, external_destination_id): a
    // workspace-only load would misclassify another account's row
    // for the same page as pre-existing under this account.
    expect(
      existingLoadFilters.some(
        (filters) => filters.account_id === accountId
      )
    ).toBe(true);
  });
});
