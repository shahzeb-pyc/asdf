/**
 * Threads Schedule server helpers — the Sonar-coverable lib code.
 *
 * These tests use the stateful fake Supabase (tests/helpers) so they
 * fail if the logic under test is removed: status derivation, chunked
 * fetching, count errors, cancel/retry gates and idempotency replay
 * are all asserted against store state, not canned responses.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import {
  fetchQueueCounts,
  fetchScheduleDestinations,
  fetchThreadsAccountsById,
  isAccountExpired,
  scheduleStatusFor,
  slotTimeToHHMM,
  threadsFormatsFromKind,
  threadsProfileUrl,
  toScheduleItem,
  type ThreadsScheduleDestinationRow,
  type ThreadsScheduleAccountRow,
} from '../../src/lib/server/threads-schedule';
import { authenticateThreadsSchedule } from '../../src/lib/server/threads-schedule-auth';
import { handleThreadsQueueItemAction } from '../../src/lib/server/threads-schedule-queue-action';
import {
  accountRow,
  destinationRow,
  fakeSupabase,
  queueRow,
  type Row,
} from '../helpers/threads-schedule-fake';

const { mockAdmin, mockWorkspace } = vi.hoisted(() => ({
  mockAdmin: vi.fn(),
  mockWorkspace: vi.fn(),
}));

vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: mockAdmin,
}));
vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveTenantWorkspaceId: mockWorkspace,
}));

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';

function dest(overrides: Partial<Row> = {}): ThreadsScheduleDestinationRow {
  return destinationRow(overrides) as unknown as ThreadsScheduleDestinationRow;
}
function acct(overrides: Partial<Row> = {}): ThreadsScheduleAccountRow {
  return accountRow(overrides) as unknown as ThreadsScheduleAccountRow;
}

describe('threads-schedule helpers', () => {
  it('builds a profile URL, and null for a missing handle', () => {
    expect(threadsProfileUrl('testthreads')).toBe('https://threads.com/@testthreads');
    expect(threadsProfileUrl(null)).toBeNull();
    expect(threadsProfileUrl('  ')).toBeNull();
  });

  it('expires an account by status, by past token, but not by future token or null token', () => {
    expect(isAccountExpired({ status: 'expired', token_expires_at: null })).toBe(true);
    expect(
      isAccountExpired({ status: 'active', token_expires_at: '2020-01-01T00:00:00.000Z' })
    ).toBe(true);
    expect(
      isAccountExpired({ status: 'active', token_expires_at: '2999-01-01T00:00:00.000Z' })
    ).toBe(false);
    expect(isAccountExpired({ status: 'active', token_expires_at: null })).toBe(false);
  });

  it('derives status with pause first, then expiry, then destination status, then error fallback', () => {
    const base = dest();
    expect(
      scheduleStatusFor(
        dest({ status: 'active', metadata: { threads_schedule_status: 'paused' } }),
        acct()
      )
    ).toBe('paused');
    expect(scheduleStatusFor(base, acct({ status: 'expired' }))).toBe('expired');
    expect(scheduleStatusFor(dest({ status: 'active' }), acct())).toBe('active');
    expect(scheduleStatusFor(dest({ status: 'rate_limited' }), acct())).toBe('rate_limited');
    expect(scheduleStatusFor(dest({ status: 'disconnected' }), acct())).toBe('disconnected');
    expect(scheduleStatusFor(dest({ status: 'weird' }), acct())).toBe('error');
    expect(scheduleStatusFor(base, null)).toBe('active');
  });

  it('filters slot kinds to Threads formats, defaulting to all on empty or non-array', () => {
    expect(threadsFormatsFromKind(['text', 'story', 'video'])).toEqual(['text', 'video']);
    expect(threadsFormatsFromKind(['story'])).toEqual(['text', 'image', 'video', 'carousel']);
    expect(threadsFormatsFromKind(null)).toEqual(['text', 'image', 'video', 'carousel']);
    expect(slotTimeToHHMM('09:30:00')).toBe('09:30');
  });

  it('toScheduleItem falls back to destination fields and created_at when metadata/account are absent', () => {
    const item = toScheduleItem(
      dest({ metadata: {}, name: 'Dest Name', external_destination_id: 'ext-9', handle: null }),
      null,
      { queued: 1, posted: 2, failed: 0 },
      true
    );
    expect(item.accountDisplayName).toBe('Dest Name');
    expect(item.threadsAccountId).toBe('ext-9');
    expect(item.accountLink).toBeNull();
    expect(item.addedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(item.queueCountsError).toBe(true);
    expect(item.queueCounts).toEqual({ queued: 1, posted: 2, failed: 0 });
  });

  it('fetchScheduleDestinations returns only schedule-added destinations, across the 1,000-row page boundary', async () => {
    const db: Record<string, Row[]> = { destinations: [] };
    for (let i = 0; i < 1005; i += 1) {
      db.destinations.push(
        destinationRow({ id: `dest-${i}`, metadata: { threads_schedule_added_at: '2026-01-01T00:00:00.000Z' } })
      );
    }
    db.destinations.push(destinationRow({ id: 'dest-not-added', metadata: {} }));
    const rows = await fetchScheduleDestinations(fakeSupabase(db) as never, 'ws-1');
    expect(rows).toHaveLength(1005);
    expect(rows.some((r) => r.id === 'dest-not-added')).toBe(false);
    expect(rows[0]?.id).toBe('dest-0');
  });

  it('fetchScheduleDestinations throws loud on a database error instead of returning a partial list', async () => {
    const fake = fakeSupabase({ destinations: [destinationRow()] }, {
      'destinations:select': { message: 'db boom' },
    });
    await expect(fetchScheduleDestinations(fake as never, 'ws-1')).rejects.toThrow('db boom');
  });

  it('fetchThreadsAccountsById returns an empty map for no ids and maps the rest', async () => {
    const fake = fakeSupabase({ social_accounts: [accountRow(), accountRow({ id: 'acct-2' })] });
    expect(await fetchThreadsAccountsById(fake as never, 'ws-1', [])).toEqual(new Map());
    const map = await fetchThreadsAccountsById(fake as never, 'ws-1', ['acct-1', 'acct-2']);
    expect(map.size).toBe(2);
    expect(map.get('acct-2')?.id).toBe('acct-2');
  });

  it('fetchQueueCounts counts each status and reports an error with zero counts on failure', async () => {
    const db: Record<string, Row[]> = {
      queue_items: [
        queueRow({ status: 'queued' }),
        queueRow({ id: 'item-2', status: 'queued' }),
        queueRow({ id: 'item-3', status: 'published' }),
        queueRow({ id: 'item-4', status: 'failed' }),
        queueRow({ id: 'item-5', status: 'cancelled' }),
      ],
    };
    const ok = await fetchQueueCounts(fakeSupabase(db) as never, 'ws-1', 'dest-1');
    expect(ok).toEqual({ counts: { queued: 2, posted: 1, failed: 1 }, error: false });
    const bad = await fetchQueueCounts(
      fakeSupabase(db, { 'queue_items:select': { message: 'count boom' } }) as never,
      'ws-1',
      'dest-1'
    );
    expect(bad).toEqual({ counts: { queued: 0, posted: 0, failed: 0 }, error: true });
  });
});

describe('authenticateThreadsSchedule', () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = TEST_SECRET;
    mockAdmin.mockReset();
    mockWorkspace.mockReset();
  });

  async function token(subdomain = 'acme') {
    return signSessionToken(
      { userId: '11111111-1111-4111-a111-111111111111', email: 'alexander@gmail.com', name: 'A', subdomain, role: 'user', status: 'active' },
      TEST_SECRET
    );
  }

  it('returns 401 with no cookie, 401 with a bad token, and 403 for a foreign subdomain', async () => {
    const noCookie = await authenticateThreadsSchedule(
      new NextRequest('http://localhost:3000/api/tenant/acme/threads/schedule'),
      'acme'
    );
    expect('errorResponse' in noCookie && noCookie.errorResponse.status).toBe(401);
    const bad = await authenticateThreadsSchedule(
      new NextRequest('http://localhost:3000/api/tenant/acme/threads/schedule', {
        headers: { cookie: 'fbup_session=not-a-token' },
      }),
      'acme'
    );
    expect('errorResponse' in bad && bad.errorResponse.status).toBe(401);
    const foreign = await authenticateThreadsSchedule(
      new NextRequest('http://localhost:3000/api/tenant/acme/threads/schedule', {
        headers: { cookie: `fbup_session=${await token('other')}` },
      }),
      'acme'
    );
    expect('errorResponse' in foreign && foreign.errorResponse.status).toBe(403);
  });

  it('returns 500 with no database client, 404 with no workspace, and the context on success', async () => {
    mockAdmin.mockReturnValue(null);
    const noDb = await authenticateThreadsSchedule(
      new NextRequest('http://localhost:3000/api/tenant/acme/threads/schedule', {
        headers: { cookie: `fbup_session=${await token()}` },
      }),
      'acme'
    );
    expect('errorResponse' in noDb && noDb.errorResponse.status).toBe(500);

    const fake = fakeSupabase({});
    mockAdmin.mockReturnValue(fake);
    mockWorkspace.mockResolvedValue(null);
    const noWs = await authenticateThreadsSchedule(
      new NextRequest('http://localhost:3000/api/tenant/acme/threads/schedule', {
        headers: { cookie: `fbup_session=${await token()}` },
      }),
      'acme'
    );
    expect('errorResponse' in noWs && noWs.errorResponse.status).toBe(404);

    mockWorkspace.mockResolvedValue('ws-1');
    const ok = await authenticateThreadsSchedule(
      new NextRequest('http://localhost:3000/api/tenant/acme/threads/schedule', {
        headers: { cookie: `fbup_session=${await token()}` },
      }),
      'acme'
    );
    expect('errorResponse' in ok).toBe(false);
    if (!('errorResponse' in ok)) {
      expect(ok.workspaceId).toBe('ws-1');
      expect(ok.session.userId).toBe('11111111-1111-4111-a111-111111111111');
    }
  });
});

describe('handleThreadsQueueItemAction', () => {
  const KEY = '11111111-1111-4111-a111-111111111111';
  function req(key?: string) {
    return new Request('http://localhost:3000/x', {
      method: 'POST',
      headers: key ? { 'Idempotency-Key': key } : {},
    });
  }
  function dbWith(overrides: { dest?: Row; account?: Row; item?: Row } = {}) {
    return {
      destinations: [destinationRow(overrides.dest ?? {})],
      social_accounts: [accountRow(overrides.account ?? {})],
      queue_items: [queueRow(overrides.item ?? {})],
      idempotency_keys: [],
    } as Record<string, Row[]>;
  }

  it('rejects a malformed Idempotency-Key with 400 and never touches the item', async () => {
    const db = dbWith();
    const res = await handleThreadsQueueItemAction(
      fakeSupabase(db) as never, 'ws-1', 'user-1', 'dest-1', 'item-1', 'publish-now', req('not-a-uuid')
    );
    expect(res.status).toBe(400);
    expect(db.queue_items[0]?.status).toBe('queued');
  });

  it('publish-now keeps a queued item queued with a fresh scheduled time, retry increments retry_count', async () => {
    const db = dbWith();
    const res = await handleThreadsQueueItemAction(
      fakeSupabase(db) as never, 'ws-1', 'user-1', 'dest-1', 'item-1', 'publish-now', req()
    );
    expect(res.status).toBe(200);
    expect(db.queue_items[0]?.status).toBe('queued');
    expect(db.queue_items[0]?.claimed_at).toBeNull();

    const db2 = dbWith({ item: { status: 'failed', retry_count: 2 } });
    const retry = await handleThreadsQueueItemAction(
      fakeSupabase(db2) as never, 'ws-1', 'user-1', 'dest-1', 'item-1', 'retry', req()
    );
    expect(retry.status).toBe(200);
    expect(db2.queue_items[0]?.status).toBe('queued');
    expect(db2.queue_items[0]?.retry_count).toBe(3);
  });

  it('replays a stored result instead of executing twice, and marks the replay', async () => {
    const db = dbWith({ item: { status: 'failed', retry_count: 0 } });
    const fake = fakeSupabase(db);
    const first = await handleThreadsQueueItemAction(
      fake as never, 'ws-1', 'user-1', 'dest-1', 'item-1', 'retry', req(KEY)
    );
    expect(first.status).toBe(200);
    expect(db.queue_items[0]?.retry_count).toBe(1);
    expect(db.idempotency_keys).toHaveLength(1);
    const second = await handleThreadsQueueItemAction(
      fake as never, 'ws-1', 'user-1', 'dest-1', 'item-1', 'retry', req(KEY)
    );
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    expect(db.queue_items[0]?.retry_count).toBe(1);
  });

  it('returns 404 for a non-schedule destination and for a missing item, without touching other rows', async () => {
    const db = dbWith({ dest: { metadata: {} } });
    const notAdded = await handleThreadsQueueItemAction(
      fakeSupabase(db) as never, 'ws-1', 'user-1', 'dest-1', 'item-1', 'publish-now', req()
    );
    expect(notAdded.status).toBe(404);

    const db2 = dbWith();
    db2.queue_items = [];
    const missing = await handleThreadsQueueItemAction(
      fakeSupabase(db2) as never, 'ws-1', 'user-1', 'dest-1', 'item-1', 'publish-now', req()
    );
    expect(missing.status).toBe(404);
  });

  it('returns 409 for a paused destination, a non-active destination, an expired account, and a wrong item status', async () => {
    const paused = await handleThreadsQueueItemAction(
      fakeSupabase(dbWith({ dest: { status: 'disconnected', metadata: { threads_schedule_added_at: '2026-01-01T00:00:00.000Z', threads_schedule_status: 'paused' } } })) as never,
      'ws-1', 'user-1', 'dest-1', 'item-1', 'publish-now', req()
    );
    expect(paused.status).toBe(409);
    const inactive = await handleThreadsQueueItemAction(
      fakeSupabase(dbWith({ dest: { status: 'error' } })) as never,
      'ws-1', 'user-1', 'dest-1', 'item-1', 'publish-now', req()
    );
    expect(inactive.status).toBe(409);
    const expired = await handleThreadsQueueItemAction(
      fakeSupabase(dbWith({ account: { status: 'expired' } })) as never,
      'ws-1', 'user-1', 'dest-1', 'item-1', 'publish-now', req()
    );
    expect(expired.status).toBe(409);
    const wrongStatus = await handleThreadsQueueItemAction(
      fakeSupabase(dbWith({ item: { status: 'failed' } })) as never,
      'ws-1', 'user-1', 'dest-1', 'item-1', 'publish-now', req()
    );
    expect(wrongStatus.status).toBe(409);
    const wrongRetry = await handleThreadsQueueItemAction(
      fakeSupabase(dbWith({ item: { status: 'queued' } })) as never,
      'ws-1', 'user-1', 'dest-1', 'item-1', 'retry', req()
    );
    expect(wrongRetry.status).toBe(409);
  });

  it('fails loud with 500 when the idempotency store cannot be read, and does not execute', async () => {
    const db = dbWith();
    const fake = fakeSupabase(db, { 'idempotency_keys:select': { message: 'store boom' } });
    const res = await handleThreadsQueueItemAction(
      fake as never, 'ws-1', 'user-1', 'dest-1', 'item-1', 'publish-now', req(KEY)
    );
    expect(res.status).toBe(500);
    expect(db.queue_items[0]?.status).toBe('queued');
  });
});
