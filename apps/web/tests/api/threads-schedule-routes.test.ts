/**
 * Threads Schedule API routes, exercised end-to-end through the
 * route handlers with only the auth boundary mocked — the auth
 * mock returns the stateful fake Supabase, so every assertion below
 * reads real store state after the handler ran. A handler that
 * stops cancelling, stops rolling back, or stops gating resume
 * fails here.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { GET as listGet, POST as listPost } from '../../src/app/api/tenant/[subdomain]/threads/schedule/route';
import {
  GET as detailGet,
  PATCH as detailPatch,
  DELETE as detailDelete,
} from '../../src/app/api/tenant/[subdomain]/threads/schedule/[scheduleId]/route';
import { GET as candidatesGet } from '../../src/app/api/tenant/[subdomain]/threads/schedule/candidates/route';
import {
  GET as slotsGet,
  POST as slotsPost,
} from '../../src/app/api/tenant/[subdomain]/threads/schedule/[scheduleId]/slots/route';
import { DELETE as slotDelete } from '../../src/app/api/tenant/[subdomain]/threads/schedule/[scheduleId]/slots/[slotId]/route';
import { GET as queueGet } from '../../src/app/api/tenant/[subdomain]/threads/schedule/[scheduleId]/queue/route';
import { GET as insightsGet } from '../../src/app/api/tenant/[subdomain]/threads/schedule/[scheduleId]/insights/route';
import {
  POST as queuePublishNow,
  GET as queuePublishNowGet,
} from '../../src/app/api/tenant/[subdomain]/threads/schedule/[scheduleId]/queue/[itemId]/publish-now/route';
import { POST as queueRetry } from '../../src/app/api/tenant/[subdomain]/threads/schedule/[scheduleId]/queue/[itemId]/retry/route';
import {
  accountRow,
  destinationRow,
  fakeSupabase,
  queueRow,
  type FakeSupabase,
  type Row,
} from '../helpers/threads-schedule-fake';

const state = vi.hoisted(() => ({ fake: null as FakeSupabase | null }));
const { mockAdmin, mockWorkspace, mockRefresh } = vi.hoisted(() => ({
  mockAdmin: vi.fn(),
  mockWorkspace: vi.fn(),
  mockRefresh: vi.fn(async () => undefined),
}));

vi.mock('@/lib/server/threads-schedule-auth', () => ({
  authenticateThreadsSchedule: vi.fn(async () => ({
    session: { userId: '11111111-1111-4111-a111-111111111111' },
    workspaceId: 'ws-1',
    supabase: state.fake,
  })),
}));
vi.mock('@/lib/auth/clients', () => ({ getSupabaseAdminClient: mockAdmin }));
vi.mock('@/lib/server/workspace-resolver', () => ({
  resolveTenantWorkspaceId: mockWorkspace,
}));
vi.mock('@/lib/server/unmatched-flag', () => ({
  refreshDestinationUnmatchedFlag: mockRefresh,
}));

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const DEST = 'dest-1';
const ADD_DEST = '44444444-4444-4444-a444-444444444444';
const EXP_DEST = '55555555-5555-4555-a555-555555555555';
const DISC_DEST = '66666666-6666-4666-a666-666666666666';
const ACCT = 'acct-1';

function params(subdomain = 'acme', extra: Record<string, string> = {}) {
  return { params: Promise.resolve({ subdomain, ...extra }) };
}

function req(url: string, init?: RequestInit) {
  return new NextRequest(url, init);
}

function baseDb(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    destinations: [destinationRow()],
    social_accounts: [accountRow()],
    posting_slots: [
      { id: 'slot-1', destination_id: DEST, time_of_day: '09:00', is_active: true, kind: ['text'], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    ],
    queue_items: [queueRow()],
    publish_logs: [],
    idempotency_keys: [],
    ...overrides,
  };
}

function useFake(db: Record<string, Row[]>, errors: Record<string, { message: string; code?: string; once?: boolean }> = {}) {
  const fake = fakeSupabase(db, errors);
  state.fake = fake;
  mockAdmin.mockReturnValue(fake);
  mockWorkspace.mockResolvedValue('ws-1');
  return fake;
}

beforeEach(() => {
  process.env.SESSION_SECRET = TEST_SECRET;
  mockRefresh.mockClear();
});

async function sessionCookie() {
  const token = await signSessionToken(
    { userId: '11111111-1111-4111-a111-111111111111', email: 'alexander@gmail.com', name: 'A', subdomain: 'acme', role: 'user', status: 'active' },
    TEST_SECRET
  );
  return `fbup_session=${token}`;
}

describe('Threads Schedule list + add', () => {
  it('lists added accounts with queue counts, and filters by search, status and account', async () => {
    const db = baseDb({
      destinations: [
        destinationRow(),
        destinationRow({ id: 'dest-2', account_id: 'acct-2', name: 'Second Threads', handle: 'second' }),
      ],
      social_accounts: [accountRow(), accountRow({ id: 'acct-2', external_account_id: 'threads-2', display_name: 'Second Account' })],
      queue_items: [queueRow(), queueRow({ id: 'item-2', destination_id: 'dest-2', status: 'published' })],
    });
    useFake(db);
    const all = await listGet(req('http://localhost:3000/api/tenant/acme/threads/schedule'), params());
    expect(all.status).toBe(200);
    const allJson = await all.json();
    expect(allJson.total).toBe(2);
    expect(allJson.items[0].queueCounts.queued).toBe(1);

    const searched = await listGet(
      req('http://localhost:3000/api/tenant/acme/threads/schedule?search=second'),
      params()
    );
    const searchedJson = await searched.json();
    expect(searchedJson.total).toBe(1);
    expect(searchedJson.items[0].name).toBe('Second Threads');

    const byAccount = await listGet(
      req('http://localhost:3000/api/tenant/acme/threads/schedule?account=acct-2'),
      params()
    );
    expect((await byAccount.json()).total).toBe(1);
  });

  it('still lists an account when its queue counts fail, flagged as an error', async () => {
    const db = baseDb();
    useFake(db, { 'queue_items:select': { message: 'count boom' } });
    const res = await listGet(req('http://localhost:3000/api/tenant/acme/threads/schedule'), params());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items[0].queueCountsError).toBe(true);
    expect(json.items[0].queueCounts).toEqual({ queued: 0, posted: 0, failed: 0 });
  });

  it('adds an account with slots, and rejects duplicates, expired and disconnected accounts', async () => {
    const db = baseDb({
      destinations: [destinationRow({ id: ADD_DEST, metadata: {} })],
      posting_slots: [],
    });
    useFake(db);
    const added = await listPost(
      req('http://localhost:3000/api/tenant/acme/threads/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationId: ADD_DEST, timezone: 'Asia/Karachi', postingTimes: [{ time: '09:00', formats: ['text'] }] }),
      }),
      params()
    );
    expect(added.status).toBe(201);
    const addedJson = await added.json();
    expect(addedJson.item.timezone).toBe('Asia/Karachi');
    expect(db.destinations[0]?.status).toBe('active');
    expect(db.posting_slots).toHaveLength(1);
    expect(mockRefresh).toHaveBeenCalled();

    const duplicate = await listPost(
      req('http://localhost:3000/api/tenant/acme/threads/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationId: ADD_DEST, timezone: 'UTC', postingTimes: [{ time: '10:00', formats: ['text'] }] }),
      }),
      params()
    );
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error).toBe('ALREADY_ADDED');

    const db2 = baseDb({
      destinations: [destinationRow({ id: EXP_DEST, metadata: {} })],
      social_accounts: [accountRow({ id: 'acct-1', status: 'expired' })],
    });
    useFake(db2);
    const expired = await listPost(
      req('http://localhost:3000/api/tenant/acme/threads/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationId: EXP_DEST, timezone: 'UTC', postingTimes: [{ time: '10:00', formats: ['text'] }] }),
      }),
      params()
    );
    expect(expired.status).toBe(409);
    expect((await expired.json()).error).toBe('ACCOUNT_EXPIRED');

    const db3 = baseDb({
      destinations: [destinationRow({ id: DISC_DEST, metadata: {}, status: 'disconnected' })],
    });
    useFake(db3);
    const disconnected = await listPost(
      req('http://localhost:3000/api/tenant/acme/threads/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationId: DISC_DEST, timezone: 'UTC', postingTimes: [{ time: '10:00', formats: ['text'] }] }),
      }),
      params()
    );
    expect(disconnected.status).toBe(409);
    expect((await disconnected.json()).error).toBe('ACCOUNT_DISCONNECTED');
  });

  it('rejects invalid add bodies and duplicate posting times before touching the store', async () => {
    const db = baseDb({ destinations: [destinationRow({ id: ADD_DEST, metadata: {} })], posting_slots: [] });
    useFake(db);
    const invalid = await listPost(
      req('http://localhost:3000/api/tenant/acme/threads/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationId: ADD_DEST, timezone: 'UTC', postingTimes: [] }),
      }),
      params()
    );
    expect(invalid.status).toBe(400);
    const dupTimes = await listPost(
      req('http://localhost:3000/api/tenant/acme/threads/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationId: ADD_DEST, timezone: 'UTC', postingTimes: [{ time: '09:00', formats: ['text'] }, { time: '09:00', formats: ['image'] }] }),
      }),
      params()
    );
    expect(dupTimes.status).toBe(400);
    expect(db.posting_slots).toHaveLength(0);
    expect(db.destinations[0]?.metadata).toEqual({});
  });

  it('rolls back flag, timezone, status AND pre-existing slots when the slot insert fails', async () => {
    const oldSlot = { id: 'slot-old', destination_id: ADD_DEST, time_of_day: '08:00', is_active: true, kind: ['text'], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
    const db = baseDb({
      destinations: [destinationRow({ id: ADD_DEST, metadata: {}, timezone: 'UTC', status: 'rate_limited' })],
      posting_slots: [oldSlot],
    });
    // Fail the new-slot insert exactly once: the rollback re-insert
    // then succeeds, so the assertion below proves the old slot was
    // actually put back, not just that the destination was restored.
    useFake(db, { 'posting_slots:insert': { message: 'slot boom', once: true } });
    const res = await listPost(
      req('http://localhost:3000/api/tenant/acme/threads/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ destinationId: ADD_DEST, timezone: 'Asia/Karachi', postingTimes: [{ time: '09:00', formats: ['text'] }] }),
      }),
      params()
    );
    expect(res.status).toBe(500);
    expect(db.destinations[0]?.metadata).toEqual({});
    expect(db.destinations[0]?.timezone).toBe('UTC');
    expect(db.destinations[0]?.status).toBe('rate_limited');
    expect(db.posting_slots.map((s) => s.time_of_day)).toEqual(['08:00']);
  });
});

describe('Threads Schedule detail, pause/resume/remove', () => {
  it('returns detail with slots, and 404 for a never-added destination', async () => {
    useFake(baseDb());
    const ok = await detailGet(req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1'), params('acme', { scheduleId: DEST }));
    expect(ok.status).toBe(200);
    const json = await ok.json();
    expect(json.item.slots).toHaveLength(1);
    expect(json.item.slots[0].slotTime).toBe('09:00');

    useFake(baseDb({ destinations: [destinationRow({ metadata: {} })] }));
    const missing = await detailGet(req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1'), params('acme', { scheduleId: DEST }));
    expect(missing.status).toBe(404);
  });

  it('pauses to disconnected+marker, resumes a paused destination, and updates timezone', async () => {
    const db = baseDb();
    useFake(db);
    const paused = await detailPatch(
      req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'paused' }),
      }),
      params('acme', { scheduleId: DEST })
    );
    expect(paused.status).toBe(200);
    expect((await paused.json()).item.status).toBe('paused');
    expect(db.destinations[0]?.status).toBe('disconnected');
    expect((db.destinations[0]?.metadata as Record<string, unknown>)?.threads_schedule_status).toBe('paused');

    const resumed = await detailPatch(
      req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'active', timezone: 'Asia/Karachi' }),
      }),
      params('acme', { scheduleId: DEST })
    );
    expect(resumed.status).toBe(200);
    expect(db.destinations[0]?.status).toBe('active');
    expect(db.destinations[0]?.timezone).toBe('Asia/Karachi');
    expect((db.destinations[0]?.metadata as Record<string, unknown>)?.threads_schedule_status).toBeUndefined();
  });

  it('refuses to resume a plain-disconnected or error destination, and an expired account', async () => {
    const plain = baseDb({ destinations: [destinationRow({ status: 'disconnected', metadata: { threads_schedule_added_at: '2026-01-01T00:00:00.000Z' } })] });
    useFake(plain);
    const plainRes = await detailPatch(
      req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'active' }),
      }),
      params('acme', { scheduleId: DEST })
    );
    expect(plainRes.status).toBe(409);
    expect((await plainRes.json()).error).toBe('ACCOUNT_DISCONNECTED');
    expect(plain.destinations[0]?.status).toBe('disconnected');

    const errDb = baseDb({ destinations: [destinationRow({ status: 'error' })] });
    useFake(errDb);
    const errRes = await detailPatch(
      req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'active' }),
      }),
      params('acme', { scheduleId: DEST })
    );
    expect(errRes.status).toBe(409);
    expect(errDb.destinations[0]?.status).toBe('error');

    const expDb = baseDb({
      destinations: [destinationRow({ status: 'disconnected', metadata: { threads_schedule_added_at: '2026-01-01T00:00:00.000Z', threads_schedule_status: 'paused' } })],
      social_accounts: [accountRow({ status: 'expired' })],
    });
    useFake(expDb);
    const expRes = await detailPatch(
      req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'active' }),
      }),
      params('acme', { scheduleId: DEST })
    );
    expect(expRes.status).toBe(409);
    expect((await expRes.json()).error).toBe('ACCOUNT_EXPIRED');
  });

  it('removes cancel-first: queued items are cancelled, others untouched, and a paused account returns to active', async () => {
    const db = baseDb({
      destinations: [destinationRow({ status: 'disconnected', metadata: { threads_schedule_added_at: '2026-01-01T00:00:00.000Z', threads_schedule_status: 'paused' } })],
      queue_items: [
        queueRow({ status: 'queued' }),
        queueRow({ id: 'item-2', status: 'published' }),
        queueRow({ id: 'item-3', status: 'failed' }),
      ],
    });
    useFake(db);
    const res = await detailDelete(req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1', { method: 'DELETE' }), params('acme', { scheduleId: DEST }));
    expect(res.status).toBe(200);
    expect(db.queue_items.find((i) => i.id === 'item-1')?.status).toBe('cancelled');
    expect(db.queue_items.find((i) => i.id === 'item-2')?.status).toBe('published');
    expect(db.queue_items.find((i) => i.id === 'item-3')?.status).toBe('failed');
    expect((db.destinations[0]?.metadata as Record<string, unknown>)?.threads_schedule_added_at).toBeUndefined();
    expect(db.destinations[0]?.status).toBe('active');
  });

  it('remove fails loud and leaves flag and queued items untouched when the cancel fails', async () => {
    const db = baseDb();
    const fake = useFake(db, { 'queue_items:update': { message: 'cancel boom' } });
    const res = await detailDelete(req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1', { method: 'DELETE' }), params('acme', { scheduleId: DEST }));
    expect(res.status).toBe(500);
    expect((db.destinations[0]?.metadata as Record<string, unknown>)?.threads_schedule_added_at).toBe('2026-01-01T00:00:00.000Z');
    expect(db.queue_items[0]?.status).toBe('queued');
    // Cancel-first ordering: no destination flag update was attempted.
    expect(fake.calls.some((c) => c.table === 'destinations' && c.mode === 'update')).toBe(false);
  });
});

describe('Threads Schedule candidates, slots, queue, insights', () => {
  it('candidates list flags added destinations and nulls accounts without one', async () => {
    const db = baseDb({
      social_accounts: [
        accountRow(),
        accountRow({ id: 'acct-2', external_account_id: 'threads-2', display_name: 'No Destination' }),
        accountRow({ id: 'acct-3', external_account_id: 'threads-3', display_name: 'Expired One', status: 'expired' }),
      ],
      destinations: [
        destinationRow(),
        destinationRow({ id: 'dest-3', account_id: 'acct-3', external_destination_id: 'threads-3', name: 'Expired Dest' }),
      ],
    });
    useFake(db);
    const res = await candidatesGet(
      req('http://localhost:3000/api/tenant/acme/threads/schedule/candidates', {
        headers: { cookie: await sessionCookie() },
      }),
      params()
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const byName = new Map(json.candidates.map((c: { displayName: string }) => [c.displayName, c]));
    expect((byName.get('Test Account') as { scheduleAdded: boolean }).scheduleAdded).toBe(true);
    expect((byName.get('No Destination') as { destinationId: unknown }).destinationId).toBeNull();
    expect((byName.get('Expired One') as { accountStatus: string }).accountStatus).toBe('expired');
  });

  it('slots CRUD: lists, creates, rejects a duplicate time with 409, deletes, and 404s for a missing slot', async () => {
    const db = baseDb();
    useFake(db);
    const listed = await slotsGet(req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1/slots'), params('acme', { scheduleId: DEST }));
    expect(listed.status).toBe(200);
    expect((await listed.json()).slots).toHaveLength(1);

    const created = await slotsPost(
      req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1/slots', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ time: '12:00', formats: ['image', 'video'] }),
      }),
      params('acme', { scheduleId: DEST })
    );
    expect(created.status).toBe(201);
    expect(db.posting_slots).toHaveLength(2);
    expect(mockRefresh).toHaveBeenCalled();

    const fake = useFake(db, { 'posting_slots:insert': { message: 'duplicate key', code: '23505' } });
    void fake;
    const dup = await slotsPost(
      req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1/slots', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ time: '12:00', formats: ['text'] }),
      }),
      params('acme', { scheduleId: DEST })
    );
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe('SLOT_ALREADY_EXISTS');

    useFake(db);
    const deleted = await slotDelete(req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1/slots/slot-1', { method: 'DELETE' }), params('acme', { scheduleId: DEST, slotId: 'slot-1' }));
    expect(deleted.status).toBe(200);
    expect(db.posting_slots.some((s) => s.id === 'slot-1')).toBe(false);
    const missing = await slotDelete(req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1/slots/nope', { method: 'DELETE' }), params('acme', { scheduleId: DEST, slotId: 'nope' }));
    expect(missing.status).toBe(404);
  });

  it('queue lists with counts, filters legacy kinds out, and normalises the media join', async () => {
    const db = baseDb({
      queue_items: [
        queueRow({ media: { name: 'photo.jpg', thumbnail_url: 'https://example.com/thumb.jpg' } }),
        queueRow({ id: 'item-arr', media: [{ name: 'first.jpg', thumbnail_url: null }, { name: 'second.jpg', thumbnail_url: null }] }),
        queueRow({ id: 'item-legacy', kind: 'story' }),
        queueRow({ id: 'item-failed', status: 'failed', kind: 'video' }),
      ],
    });
    useFake(db);
    const res = await queueGet(req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1/queue'), params('acme', { scheduleId: DEST }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.counts).toEqual({ queued: 3, publishing: 0, published: 0, failed: 1, cancelled: 0 });
    // Legacy kind is counted but not listed.
    expect(json.items.some((i: { id: string }) => i.id === 'item-legacy')).toBe(false);
    const first = json.items.find((i: { id: string }) => i.id === 'item-1');
    expect(first.mediaName).toBe('photo.jpg');
    expect(first.mediaThumbnailUrl).toBe('https://example.com/thumb.jpg');
    const arr = json.items.find((i: { id: string }) => i.id === 'item-arr');
    expect(arr.mediaName).toBe('first.jpg');

    const failedOnly = await queueGet(req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1/queue?status=failed'), params('acme', { scheduleId: DEST }));
    const failedJson = await failedOnly.json();
    expect(failedJson.items.map((i: { id: string }) => i.id)).toEqual(['item-failed']);
  });

  it('insights derive totals, byKind and a 14-day byDay series from queue and logs', async () => {
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const db = baseDb({
      queue_items: [
        queueRow({ status: 'published', kind: 'text' }),
        queueRow({ id: 'item-2', status: 'failed', kind: 'video' }),
        queueRow({ id: 'item-3', status: 'queued', kind: 'image' }),
      ],
      publish_logs: [
        { id: 'log-1', destination_id: DEST, platform: 'threads', result: 'success', created_at: today.toISOString() },
        { id: 'log-2', destination_id: DEST, platform: 'threads', result: 'failure', created_at: yesterday.toISOString() },
        { id: 'log-3', destination_id: 'other', platform: 'threads', result: 'success', created_at: today.toISOString() },
      ],
    });
    useFake(db);
    const res = await insightsGet(req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1/insights'), params('acme', { scheduleId: DEST }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.totals).toEqual({ posted: 1, failed: 1, queued: 1 });
    expect(json.byKind.find((k: { kind: string }) => k.kind === 'text')).toEqual({ kind: 'text', posted: 1, failed: 0 });
    expect(json.byDay).toHaveLength(14);
    const todayRow = json.byDay.find((d: { date: string }) => d.date === today.toISOString().slice(0, 10));
    expect(todayRow.posted).toBe(1);
    const yesterdayRow = json.byDay.find((d: { date: string }) => d.date === yesterday.toISOString().slice(0, 10));
    expect(yesterdayRow.failed).toBe(1);
  });

  it('queue publish-now and retry work through the routes, with idempotency replay and 405 on GET', async () => {
    const db = baseDb();
    useFake(db);
    const now = await queuePublishNow(
      req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1/queue/item-1/publish-now', {
        method: 'POST',
        headers: { 'Idempotency-Key': '22222222-2222-4222-a222-222222222222' },
      }),
      params('acme', { scheduleId: DEST, itemId: 'item-1' })
    );
    expect(now.status).toBe(200);
    const replay = await queuePublishNow(
      req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1/queue/item-1/publish-now', {
        method: 'POST',
        headers: { 'Idempotency-Key': '22222222-2222-4222-a222-222222222222' },
      }),
      params('acme', { scheduleId: DEST, itemId: 'item-1' })
    );
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');

    const get405 = await queuePublishNowGet();
    expect(get405.status).toBe(405);

    const db2 = baseDb({ queue_items: [queueRow({ status: 'failed', retry_count: 1 })] });
    useFake(db2);
    const retried = await queueRetry(
      req('http://localhost:3000/api/tenant/acme/threads/schedule/dest-1/queue/item-1/retry', { method: 'POST' }),
      params('acme', { scheduleId: DEST, itemId: 'item-1' })
    );
    expect(retried.status).toBe(200);
    expect(db2.queue_items[0]?.status).toBe('queued');
    expect(db2.queue_items[0]?.retry_count).toBe(2);
  });
});
