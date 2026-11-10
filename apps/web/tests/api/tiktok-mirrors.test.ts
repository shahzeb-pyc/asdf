/**
 * TikTok mirrors API (legacy DB path): auth, validation,
 * exact-duplicate block (same username + same page) with
 * same-username-different-page allowed, feed-verification failure
 * creating nothing, immediate latest-reel post on setup +
 * failure-recorded-as-failed, and existing-destination reuse without
 * touching its status.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { encryptToken, signSessionToken } from '@fbuploadpro/contracts';
import {
  asDestinationRow,
  asMirrorRow,
  buildMirrorFbStatusSqlCondition,
  handleCreateMirror,
  handleListMirrors,
  normalizeMirrorFbStatus,
  targetFbStatusFor,
  toMirrorListView,
  toMirrorView,
} from '../../src/app/api/tenant/[subdomain]/tiktok-mirrors/route';
import {
  handleGetMirror,
  handleUpdateMirror,
} from '../../src/app/api/tenant/[subdomain]/tiktok-mirrors/[mirrorId]/route';
import { handleRetryMirrorPost } from '../../src/app/api/tenant/[subdomain]/tiktok-mirrors/[mirrorId]/posts/[postId]/retry/route';
import { TikwmError } from '../../src/lib/server/tikwm';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'test-session-secret-32-chars-minimum!!';
const TEST_KEY = 'a'.repeat(64);

const userId = '11111111-1111-4111-a111-111111111111';
const accountId = '22222222-2222-4222-a222-222222222222';
const destId = '33333333-3333-4333-a333-333333333333';
const mirrorId = '44444444-4444-4444-a444-444444444444';
const postId = '55555555-5555-4555-a555-555555555555';
const fbPageId = '749557154917108';

let validSessionCookie: string;
let encAccountToken: string;
let encPageToken: string;

function createRequest(body: unknown, cookie = validSessionCookie): NextRequest {
  return new NextRequest('http://localhost:3000/api/tenant/acme/tiktok-mirrors', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { cookie, 'content-type': 'application/json' },
  });
}

function listRequest(cookie = validSessionCookie): NextRequest {
  return new NextRequest('http://localhost:3000/api/tenant/acme/tiktok-mirrors', {
    headers: { cookie },
  });
}

function mirrorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: mirrorId,
    workspace_id: 'ws_1',
    source_platform: 'tiktok',
    source_username: 'alice',
    source_display_name: 'Alice',
    source_avatar_url: 'https://example.com/a.jpg',
    target_platform: 'facebook',
    target_external_id: fbPageId,
    target_display_name: 'Test Page',
    target_avatar_url: null,
    status: 'active',
    catch_up_pending: false,
    last_posted_source_id: null,
    last_posted_create_time: null,
    last_checked_at: null,
    next_check_at: null,
    last_error: null,
    created_at: '2026-10-29T00:00:00.000Z',
    updated_at: '2026-10-29T00:00:00.000Z',
    ...overrides,
  };
}

function destRow(overrides: Record<string, unknown> = {}) {
  return {
    id: destId,
    account_id: accountId,
    external_destination_id: fbPageId,
    name: 'Test Page',
    avatar_url: null,
    encrypted_destination_token: encPageToken,
    status: 'paused',
    ...overrides,
  };
}

interface FakeDbOptions {
  existingDestination?: Record<string, unknown> | null;
  /** A destination row owned by ANOTHER workspace (for tenant-isolation tests). */
  foreignDestination?: Record<string, unknown> | null;
  duplicate?: boolean;
  mirrorRowOverride?: Record<string, unknown>;
  /** Full mirror set for pagination tests; the list branch slices it by LIMIT/OFFSET. */
  mirrorRows?: Record<string, unknown>[];
  /** Retry tests: the mirror row is missing (foreign workspace reads as not found). */
  mirrorMissing?: boolean;
  /** Retry tests: the post row is missing. */
  postMissing?: boolean;
  /** Retry tests: no destination row for the mirror target (missing token). */
  destinationMissing?: boolean;
  /** Retry tests: overrides for the pending post row. */
  postRowOverride?: Record<string, unknown>;
}

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: postId,
    mirror_id: mirrorId,
    source_post_id: 'v1',
    caption: 'My exact caption',
    video_url: 'https://example.com/v1.mp4',
    cover_url: null,
    source_created_at: '2026-10-29T10:00:00.000Z',
    status: 'pending',
    published_post_id: null,
    error: 'A previous failure',
    created_at: '2026-10-29T10:00:00.000Z',
    ...overrides,
  };
}

/** Legacy-path fake DB dispatching on SQL content. */
function fakeDb(options: FakeDbOptions = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const existing = options.existingDestination ?? null;
  const db: Partial<DatabaseClient> = {
    query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM workspaces')) return Promise.resolve([{ id: 'ws_1' }]);
      if (sql.includes('FROM social_accounts')) {
        return Promise.resolve([{ encrypted_access_token: encAccountToken }]);
      }
      if (sql.includes('FROM destinations WHERE account_id')) {
        return Promise.resolve(existing ? [existing] : []);
      }
      if (sql.includes('FROM destinations WHERE id = $1')) {
        // Models the destinations table holding a foreign-workspace row:
        // the unscoped (old) query finds it, the workspace-scoped (new)
        // query for ws_1 does not.
        if (!options.foreignDestination) return Promise.resolve([]);
        return Promise.resolve(params.includes('ws_1') ? [] : [options.foreignDestination]);
      }
      if (sql.includes('INSERT INTO destinations')) {
        return Promise.resolve([destRow({ status: 'active' })]);
      }
      if (sql.includes('SELECT 1 FROM mirrors')) {
        return Promise.resolve(options.duplicate ? [{ '1': 1 }] : []);
      }
      if (sql.includes('INSERT INTO mirrors')) {
        return Promise.resolve([mirrorRow()]);
      }
      if (sql.includes('INSERT INTO mirror_posts')) {
        return Promise.resolve([{ id: postId }]);
      }
      if (sql.includes('FROM mirrors WHERE id = $1')) {
        return Promise.resolve(
          options.mirrorMissing ? [] : [mirrorRow(options.mirrorRowOverride ?? {})]
        );
      }
      if (sql.includes('GROUP BY mirror_id')) {
        return Promise.resolve([{ mirror_id: mirrorId, posted: 2, failed: 1 }]);
      }
      if (sql.includes('COUNT(*)')) {
        const rows = options.mirrorRows ?? [mirrorRow()];
        return Promise.resolve([{ total: rows.length }]);
      }
      if (sql.includes('FROM mirrors WHERE workspace_id')) {
        const rows = options.mirrorRows ?? [mirrorRow()];
        const limit = typeof params[1] === 'number' ? params[1] : rows.length;
        const offset = typeof params[2] === 'number' ? params[2] : 0;
        return Promise.resolve(rows.slice(offset, offset + limit));
      }
      if (sql.includes('FROM destinations WHERE workspace_id')) {
        return Promise.resolve(options.destinationMissing ? [] : [destRow()]);
      }
      if (sql.includes('FROM mirror_posts WHERE id = $1')) {
        return Promise.resolve(
          options.postMissing ? [] : [postRow(options.postRowOverride ?? {})]
        );
      }
      if (sql.includes('LEFT JOIN social_accounts')) {
        return Promise.resolve([
          {
            id: destId,
            created_at: '2026-11-02T00:00:00.000Z',
            category: 'Digital creator',
            current_followers: 0,
            account_display_name: 'Shahzeb Malik',
          },
        ]);
      }
      if (sql.includes('FROM mirror_posts WHERE mirror_id = ANY')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }),
  };
  return { db: db as DatabaseClient, calls };
}

function feedVideo(overrides: Record<string, unknown> = {}) {
  return {
    video_id: 'v_latest',
    play: 'https://example.com/no-wm.mp4',
    wmplay: 'https://example.com/wm.mp4',
    title: 'My exact caption',
    cover: 'https://example.com/cover.jpg',
    create_time: 1700000000,
    author: { unique_id: 'alice', nickname: 'Alice', avatar: 'https://example.com/a.jpg' },
    ...overrides,
  };
}

const createDeps = (options: { publish?: unknown } = {}) => ({
  fetchGraphPages: vi.fn().mockResolvedValue({
    pages: [
      {
        id: fbPageId,
        name: 'Test Page',
        category: 'Test',
        access_token: 'page-token-plain',
        picture: { data: { url: 'https://example.com/pic.jpg' } },
      },
    ],
    truncated: false,
    partial: false,
  }),
  fetchTikwmPosts: vi.fn().mockResolvedValue([feedVideo()]),
  fetchTikwmInfo: vi.fn().mockResolvedValue({
    unique_id: 'alice',
    nickname: 'Alice',
    avatar: 'https://example.com/a.jpg',
  }),
  resolveTikwmVideo: vi.fn().mockResolvedValue({
    playUrl: 'https://example.com/no-wm.mp4',
    title: 'My exact caption',
  }),
  publishReel:
    options.publish ??
    vi.fn().mockResolvedValue('fb_post_123'),
});

describe('POST /tiktok-mirrors', () => {
  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
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
    encAccountToken = await encryptToken('acct-token-plain', TEST_KEY);
    encPageToken = await encryptToken('page-token-plain', TEST_KEY);
  });

  it('returns 401 without a session cookie', async () => {
    const res = await handleCreateMirror(
      createRequest({ accountId, targetExternalId: fbPageId, sourceUsername: 'alice' }, ''),
      'acme'
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 on cross-tenant subdomain mismatch', async () => {
    const req = new NextRequest('http://localhost:3000/api/tenant/other/tiktok-mirrors', {
      method: 'POST',
      body: JSON.stringify({ accountId, targetExternalId: fbPageId, sourceUsername: 'alice' }),
      headers: { cookie: validSessionCookie, 'content-type': 'application/json' },
    });
    const res = await handleCreateMirror(req, 'other');
    expect(res.status).toBe(403);
  });

  it('returns 400 on invalid usernames', async () => {
    const { db } = fakeDb();
    for (const username of ['has space', '', 'a'.repeat(25)]) {
      const res = await handleCreateMirror(
        createRequest({ accountId, targetExternalId: fbPageId, sourceUsername: username }),
        'acme',
        db,
        createDeps() as never
      );
      expect(res.status).toBe(400);
    }
  });

  it('returns 400 TIKTOK_FEED_UNAVAILABLE and creates nothing when the feed fails', async () => {
    const { db, calls } = fakeDb();
    const deps = createDeps();
    deps.fetchTikwmPosts = vi.fn().mockRejectedValue(
      new TikwmError('FEED_UNAVAILABLE', 'no such account')
    );
    const res = await handleCreateMirror(
      createRequest({ accountId, targetExternalId: fbPageId, sourceUsername: 'ghost' }),
      'acme',
      db,
      deps as never
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('TIKTOK_FEED_UNAVAILABLE');
    expect(calls.some((c) => c.sql.includes('INSERT INTO mirrors'))).toBe(false);
    expect(calls.some((c) => c.sql.includes('INSERT INTO destinations'))).toBe(false);
  });

  it('returns 409 DUPLICATE_MIRROR for the same username + same page', async () => {
    const { db } = fakeDb({ duplicate: true });
    const res = await handleCreateMirror(
      createRequest({ accountId, targetExternalId: fbPageId, sourceUsername: 'alice' }),
      'acme',
      db,
      createDeps() as never
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('DUPLICATE_MIRROR');
  });

  it('allows the same username for a different page (no duplicate row)', async () => {
    const { db } = fakeDb({ duplicate: false });
    const deps = createDeps();
    const res = await handleCreateMirror(
      createRequest({ accountId, targetExternalId: fbPageId, sourceUsername: 'alice' }),
      'acme',
      db,
      deps as never
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mirror.sourceUsername).toBe('alice');
    expect(body.immediatePost.status).toBe('posted');
    // Caption verbatim + no-watermark URL passed to the reel publish.
    expect(deps.publishReel).toHaveBeenCalledWith(
      expect.objectContaining({
        pageId: fbPageId,
        videoUrl: 'https://example.com/no-wm.mp4',
        caption: 'My exact caption',
      })
    );
  });

  it('records the post failed and the mirror in error when the immediate post fails', async () => {
    const { db, calls } = fakeDb();
    const deps = createDeps({
      publish: vi.fn().mockRejectedValue(new Error('Graph exploded')),
    });
    const res = await handleCreateMirror(
      createRequest({ accountId, targetExternalId: fbPageId, sourceUsername: 'alice' }),
      'acme',
      db,
      deps as never
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.immediatePost.status).toBe('failed');
    expect(body.immediatePost.error).toContain('Graph exploded');
    const postUpdate = calls.find((c) => c.sql.includes('UPDATE mirror_posts'));
    expect(postUpdate?.params?.[1]).toBe('failed');
    const mirrorUpdate = calls.find((c) => c.sql.includes('UPDATE mirrors'));
    expect(mirrorUpdate?.params).toContain('error');
  });

  it('shows the plain restriction message (not Facebook raw text) when the immediate post is restricted', async () => {
    const { db, calls } = fakeDb();
    const restrictedError = Object.assign(
      new Error(
        'For security reasons, your account has limited access to the site for a few days.'
      ),
      { code: 1, errorSubcode: 2424009 }
    );
    const deps = createDeps({
      publish: vi.fn().mockRejectedValue(restrictedError),
    });
    const res = await handleCreateMirror(
      createRequest({ accountId, targetExternalId: fbPageId, sourceUsername: 'alice' }),
      'acme',
      db,
      deps as never
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.immediatePost.status).toBe('failed');
    expect(body.immediatePost.error).toBe(
      "This Facebook page can't post right now because the connected account is temporarily restricted on Facebook. It should work again once the restriction lifts — check Facebook Account Status for details."
    );
    expect(body.immediatePost.error).not.toContain('limited access to the site');
    const postUpdate = calls.find((c) => c.sql.includes('UPDATE mirror_posts'));
    expect(postUpdate?.params).toContain(body.immediatePost.error);
    const mirrorUpdate = calls.find((c) => c.sql.includes('UPDATE mirrors'));
    expect(mirrorUpdate?.params).toContain('error');
    expect(mirrorUpdate?.params).toContain(body.immediatePost.error);
  });

  it('records the post failed and the mirror in error when video resolve fails', async () => {
    const { db, calls } = fakeDb();
    const deps = createDeps();
    deps.resolveTikwmVideo = vi.fn().mockRejectedValue(new Error('Could not resolve video'));
    const res = await handleCreateMirror(
      createRequest({ accountId, targetExternalId: fbPageId, sourceUsername: 'alice' }),
      'acme',
      db,
      deps as never
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.immediatePost.status).toBe('failed');
    expect(body.immediatePost.error).toContain('Could not resolve video');
    expect(deps.publishReel).not.toHaveBeenCalled();
    const mirrorUpdate = calls.find((c) => c.sql.includes('UPDATE mirrors'));
    expect(mirrorUpdate?.params).toContain('error');
  });

  it('reuses an existing destination without touching its status', async () => {
    const { db, calls } = fakeDb({ existingDestination: destRow() });
    const res = await handleCreateMirror(
      createRequest({ accountId, targetExternalId: fbPageId, sourceUsername: 'alice' }),
      'acme',
      db,
      createDeps() as never
    );
    expect(res.status).toBe(201);
    expect(calls.some((c) => c.sql.includes('INSERT INTO destinations'))).toBe(false);
    const destUpdates = calls.filter((c) => c.sql.includes('UPDATE destinations'));
    for (const update of destUpdates) {
      expect(update.sql).not.toContain('status');
    }
  });

  it('returns 404 and creates nothing when targetDestinationId belongs to another workspace', async () => {
    const { db, calls } = fakeDb({ foreignDestination: destRow() });
    const deps = createDeps();
    const res = await handleCreateMirror(
      createRequest({ targetDestinationId: destId, sourceUsername: 'alice' }),
      'acme',
      db,
      deps as never
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Facebook page not found');
    expect(calls.some((c) => c.sql.includes('INSERT INTO mirrors'))).toBe(false);
    expect(deps.publishReel).not.toHaveBeenCalled();
  });
});

describe('PATCH /tiktok-mirrors/[mirrorId] (resume arms catch-up)', () => {
  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
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

  function patchRequest(status: string, cookie = validSessionCookie): NextRequest {
    return new NextRequest(
      `http://localhost:3000/api/tenant/acme/tiktok-mirrors/${mirrorId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status }),
        headers: { cookie, 'content-type': 'application/json' },
      }
    );
  }

  it('arms catch_up_pending on resume (paused -> active)', async () => {
    const { db, calls } = fakeDb({ mirrorRowOverride: { status: 'paused' } });
    const res = await handleUpdateMirror(patchRequest('active'), 'acme', mirrorId, db);
    expect(res.status).toBe(200);
    const update = calls.find((c) => c.sql.includes('UPDATE mirrors'));
    expect(update?.sql).toContain('catch_up_pending = true');
  });

  it('pausing does not touch catch_up_pending', async () => {
    const { db, calls } = fakeDb({ mirrorRowOverride: { status: 'active' } });
    const res = await handleUpdateMirror(patchRequest('paused'), 'acme', mirrorId, db);
    expect(res.status).toBe(200);
    const update = calls.find((c) => c.sql.includes('UPDATE mirrors'));
    expect(update?.sql).not.toContain('catch_up_pending');
  });

  it('re-arming an error mirror leaves catch_up_pending untouched', async () => {
    const { db, calls } = fakeDb({ mirrorRowOverride: { status: 'error' } });
    const res = await handleUpdateMirror(patchRequest('active'), 'acme', mirrorId, db);
    expect(res.status).toBe(200);
    const update = calls.find((c) => c.sql.includes('UPDATE mirrors'));
    expect(update?.sql).not.toContain('catch_up_pending');
  });
});

describe('GET /tiktok-mirrors/[mirrorId] (detail header fields)', () => {
  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
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

  function detailRequest(cookie = validSessionCookie): NextRequest {
    return new NextRequest(
      `http://localhost:3000/api/tenant/acme/tiktok-mirrors/${mirrorId}`,
      { headers: { cookie } }
    );
  }

  it('resolves target page details for the detail header from existing rows', async () => {
    const { db } = fakeDb();
    const res = await handleGetMirror(detailRequest(), 'acme', mirrorId, db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mirror: Record<string, unknown>;
      posts: unknown[];
    };
    expect(body.mirror.targetDisplayName).toBe('Test Page');
    expect(body.mirror.targetAddedAt).toBe('2026-11-02T00:00:00.000Z');
    expect(body.mirror.targetFollowers).toBe(0);
    expect(body.mirror.targetCategory).toBe('Digital creator');
    expect(body.mirror.targetAccountDisplayName).toBe('Shahzeb Malik');
    expect(body.mirror.targetAccountAvatarUrl).toBeNull();
    expect(body.mirror.targetStartingFollowers).toBeNull();
    expect(body.posts).toEqual([]);
  });

  it('still returns the mirror with null detail fields when the destination is gone', async () => {
    const { db } = fakeDb({ destinationMissing: true });
    const res = await handleGetMirror(detailRequest(), 'acme', mirrorId, db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mirror: Record<string, unknown> };
    expect(body.mirror.targetDisplayName).toBe('Test Page');
    expect(body.mirror.targetDestinationId).toBeNull();
    expect(body.mirror.targetAddedAt).toBeNull();
    expect(body.mirror.targetFollowers).toBeNull();
    expect(body.mirror.targetCategory).toBeNull();
    expect(body.mirror.targetAccountDisplayName).toBeNull();
  });
});

describe('GET /tiktok-mirrors', () => {
  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
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

  it('lists mirrors with their linked destination names', async () => {
    const { db } = fakeDb();
    const res = await handleListMirrors(listRequest(), 'acme', db);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mirrors).toHaveLength(1);
    expect(body.mirrors[0].sourceUsername).toBe('alice');
    expect(body.mirrors[0].targetDisplayName).toBe('Test Page');
    // List view only: no lastMirroredPost, no nextCheckAt (detail
    // view only), plus page details + all-time post counts.
    expect('lastMirroredPost' in body.mirrors[0]).toBe(false);
    expect('nextCheckAt' in body.mirrors[0]).toBe(false);
    expect(body.mirrors[0].targetAddedAt).toBe('2026-11-02T00:00:00.000Z');
    expect(body.mirrors[0].targetFollowers).toBe(0);
    expect(body.mirrors[0].targetCategory).toBe('Digital creator');
    expect(body.mirrors[0].targetAccountDisplayName).toBe('Shahzeb Malik');
    expect(body.mirrors[0].postCounts).toEqual({ posted: 2, failed: 1 });
    expect(body.mirrors[0].postCountsError).toBe(false);
  });

  it('paginates: page 1 + page 2 of a 35-mirror workspace cover all 35 rows exactly once', async () => {
    const rows = Array.from({ length: 35 }, (_, i) =>
      mirrorRow({
        id: `44444444-4444-4444-a444-${String(i).padStart(12, '0')}`,
        source_username: `user${i}`,
      })
    );
    const { db } = fakeDb({ mirrorRows: rows });
    const page1Res = await handleListMirrors(listRequest(), 'acme', db);
    expect(page1Res.status).toBe(200);
    const page1 = await page1Res.json();
    expect(page1.total).toBe(35);
    expect(page1.page).toBe(1);
    expect(page1.limit).toBe(30);
    expect(page1.totalPages).toBe(2);
    expect(page1.mirrors).toHaveLength(30);
    const page2Req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/tiktok-mirrors?page=2',
      { headers: { cookie: validSessionCookie } }
    );
    const page2Res = await handleListMirrors(page2Req, 'acme', db);
    expect(page2Res.status).toBe(200);
    const page2 = await page2Res.json();
    expect(page2.page).toBe(2);
    expect(page2.total).toBe(35);
    expect(page2.mirrors).toHaveLength(5);
    // No row silently dropped, none duplicated across pages.
    const ids = [...page1.mirrors, ...page2.mirrors].map((m) => m.id);
    expect(new Set(ids).size).toBe(35);
  });

  it('clamps an out-of-range page to the last page instead of returning an empty list', async () => {
    const rows = Array.from({ length: 35 }, (_, i) =>
      mirrorRow({
        id: `44444444-4444-4444-a444-${String(i).padStart(12, '0')}`,
        source_username: `user${i}`,
      })
    );
    const { db } = fakeDb({ mirrorRows: rows });
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/tiktok-mirrors?page=99',
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleListMirrors(req, 'acme', db);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(2);
    expect(body.totalPages).toBe(2);
    expect(body.mirrors).toHaveLength(5);
  });
});

describe('POST /tiktok-mirrors/[mirrorId]/posts/[postId]/retry', () => {
  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
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
    encAccountToken = await encryptToken('acct-token-plain', TEST_KEY);
    encPageToken = await encryptToken('page-token-plain', TEST_KEY);
  });

  function retryRequest(cookie = validSessionCookie): NextRequest {
    return new NextRequest(
      `http://localhost:3000/api/tenant/acme/tiktok-mirrors/${mirrorId}/posts/${postId}/retry`,
      { method: 'POST', headers: { cookie } }
    );
  }

  it('publishes a pending post with its stored video URL and marks it posted', async () => {
    const { db, calls } = fakeDb();
    const publishReel = vi.fn().mockResolvedValue('fb_post_999');
    const res = await handleRetryMirrorPost(retryRequest(), 'acme', mirrorId, postId, db, {
      publishReel,
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.post.status).toBe('posted');
    expect(body.post.publishedPostId).toBe('fb_post_999');
    expect(body.post.error).toBeNull();
    expect(publishReel).toHaveBeenCalledWith({
      pageId: fbPageId,
      pageToken: 'page-token-plain',
      videoUrl: 'https://example.com/v1.mp4',
      caption: 'My exact caption',
    });
    const postUpdate = calls.find((c) => c.sql.includes('UPDATE mirror_posts'));
    expect(postUpdate?.params).toEqual([
      postId,
      'posted',
      'fb_post_999',
      null,
      'https://example.com/v1.mp4',
      'My exact caption',
    ]);
    const mirrorUpdate = calls.find((c) => c.sql.includes('UPDATE mirrors'));
    expect(mirrorUpdate?.params).toEqual([mirrorId, 'active', null]);
  });

  it('publishes a failed post with its stored video URL and marks it posted', async () => {
    const { db } = fakeDb({ postRowOverride: { status: 'failed' } });
    const publishReel = vi.fn().mockResolvedValue('fb_post_998');
    const res = await handleRetryMirrorPost(retryRequest(), 'acme', mirrorId, postId, db, {
      publishReel,
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.post.status).toBe('posted');
    expect(body.post.publishedPostId).toBe('fb_post_998');
    expect(publishReel).toHaveBeenCalled();
  });

  it('leaves the row failed with the error when publishing fails', async () => {
    const { db, calls } = fakeDb();
    const publishReel = vi.fn().mockRejectedValue(new Error('Facebook rejected this reel.'));
    const res = await handleRetryMirrorPost(retryRequest(), 'acme', mirrorId, postId, db, {
      publishReel,
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.post.status).toBe('failed');
    expect(body.post.publishedPostId).toBeNull();
    expect(body.post.error).toBe('Facebook rejected this reel.');
    const postUpdate = calls.find((c) => c.sql.includes('UPDATE mirror_posts'));
    expect(postUpdate?.params).toEqual([
      postId,
      'failed',
      null,
      'Facebook rejected this reel.',
      'https://example.com/v1.mp4',
      'My exact caption',
    ]);
    const mirrorUpdate = calls.find((c) => c.sql.includes('UPDATE mirrors'));
    expect(mirrorUpdate?.params).toEqual([
      mirrorId,
      'error',
      'Facebook rejected this reel.',
    ]);
  });

  it('rejects a posted post with 409 and never publishes', async () => {
    const { db } = fakeDb({ postRowOverride: { status: 'posted' } });
    const publishReel = vi.fn();
    const res = await handleRetryMirrorPost(retryRequest(), 'acme', mirrorId, postId, db, {
      publishReel,
    } as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('NOT_RETRYABLE');
    expect(publishReel).not.toHaveBeenCalled();
  });

  it('returns 404 for a foreign mirror and a missing post', async () => {
    const { db } = fakeDb({ mirrorMissing: true });
    const res = await handleRetryMirrorPost(retryRequest(), 'acme', mirrorId, postId, db);
    expect(res.status).toBe(404);
    const { db: db2 } = fakeDb({ postMissing: true });
    const res2 = await handleRetryMirrorPost(retryRequest(), 'acme', mirrorId, postId, db2);
    expect(res2.status).toBe(404);
  });

  it('keeps the row failed with the reconnect message when the token is missing', async () => {
    const { db, calls } = fakeDb({ destinationMissing: true });
    const publishReel = vi.fn();
    const res = await handleRetryMirrorPost(retryRequest(), 'acme', mirrorId, postId, db, {
      publishReel,
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.post.status).toBe('failed');
    expect(body.post.error).toContain('Reconnect the page');
    expect(publishReel).not.toHaveBeenCalled();
    const postUpdate = calls.find((c) => c.sql.includes('UPDATE mirror_posts'));
    expect(postUpdate?.params[1]).toBe('failed');
  });

  it('re-resolves a null video URL before publishing, and persists it', async () => {
    const { db, calls } = fakeDb({ postRowOverride: { video_url: null } });
    const publishReel = vi.fn().mockResolvedValue('fb_post_777');
    const resolveTikwmVideo = vi.fn().mockResolvedValue({
      playUrl: 'https://example.com/no-wm.mp4',
      title: 'Resolved title',
    });
    const res = await handleRetryMirrorPost(retryRequest(), 'acme', mirrorId, postId, db, {
      publishReel,
      resolveTikwmVideo,
    } as never);
    expect(res.status).toBe(200);
    expect((await res.json()).post.status).toBe('posted');
    expect(resolveTikwmVideo).toHaveBeenCalledWith(
      'https://www.tiktok.com/@alice/video/v1'
    );
    expect(publishReel).toHaveBeenCalledWith(
      expect.objectContaining({
        videoUrl: 'https://example.com/no-wm.mp4',
        caption: 'Resolved title',
      })
    );
    const postUpdate = calls.find((c) => c.sql.includes('UPDATE mirror_posts'));
    expect(postUpdate?.params).toEqual([
      postId,
      'posted',
      'fb_post_777',
      null,
      'https://example.com/no-wm.mp4',
      'Resolved title',
    ]);
  });

  it('keeps the row failed when the re-resolve fails and never publishes', async () => {
    const { db } = fakeDb({ postRowOverride: { video_url: null } });
    const publishReel = vi.fn();
    const resolveTikwmVideo = vi.fn().mockRejectedValue(new Error('Resolve failed.'));
    const res = await handleRetryMirrorPost(retryRequest(), 'acme', mirrorId, postId, db, {
      publishReel,
      resolveTikwmVideo,
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.post.status).toBe('failed');
    expect(body.post.error).toBe('Resolve failed.');
    expect(publishReel).not.toHaveBeenCalled();
  });

  it('publishes an Instagram-target pending post with the account token', async () => {
    const { db } = fakeDb({
      mirrorRowOverride: { target_platform: 'instagram', target_external_id: 'ig_123' },
    });
    const publishInstagramReel = vi.fn().mockResolvedValue('ig_post_1');
    const res = await handleRetryMirrorPost(retryRequest(), 'acme', mirrorId, postId, db, {
      publishInstagramReel,
    } as never);
    expect(res.status).toBe(200);
    expect((await res.json()).post.status).toBe('posted');
    expect(publishInstagramReel).toHaveBeenCalledWith({
      igUserId: 'ig_123',
      accessToken: 'acct-token-plain',
      // Mock account row carries no metadata, so it resolves as
      // legacy (never guessed as BISU) and stays on the legacy host.
      isBisu: false,
      videoUrl: 'https://example.com/v1.mp4',
      caption: 'My exact caption',
    });
  });

  it('rejects an unsupported target platform with 400', async () => {
    const { db } = fakeDb({
      mirrorRowOverride: { target_platform: 'threads' },
    });
    const publishReel = vi.fn();
    const res = await handleRetryMirrorPost(retryRequest(), 'acme', mirrorId, postId, db, {
      publishReel,
    } as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('RETRY_UNSUPPORTED');
    expect(publishReel).not.toHaveBeenCalled();
  });

  it('never unpauses a paused mirror on success', async () => {
    const { db, calls } = fakeDb({ mirrorRowOverride: { status: 'paused' } });
    const publishReel = vi.fn().mockResolvedValue('fb_post_999');
    const res = await handleRetryMirrorPost(retryRequest(), 'acme', mirrorId, postId, db, {
      publishReel,
    } as never);
    expect(res.status).toBe(200);
    expect((await res.json()).post.status).toBe('posted');
    const mirrorUpdate = calls.find((c) => c.sql.includes('UPDATE mirrors'));
    expect(mirrorUpdate?.params).toEqual([mirrorId, 'paused', null]);
  });
});

describe('spec 155: mirror Facebook detail (fb_status)', () => {
  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
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
    encPageToken = await encryptToken('page-token-plain', TEST_KEY);
    encAccountToken = await encryptToken('account-token-plain', TEST_KEY);
  });

  it('normalizeMirrorFbStatus accepts coarse + detail values, rejects the rest', () => {
    expect(normalizeMirrorFbStatus('active')).toBe('active');
    expect(normalizeMirrorFbStatus('paused')).toBe('paused');
    expect(normalizeMirrorFbStatus('error')).toBe('error');
    expect(normalizeMirrorFbStatus('missing_permission')).toBe('missing_permission');
    expect(normalizeMirrorFbStatus('checkpoint')).toBe('checkpoint');
    expect(normalizeMirrorFbStatus('fb_rate_limited')).toBe('fb_rate_limited');
    expect(normalizeMirrorFbStatus('bogus')).toBeNull();
    expect(normalizeMirrorFbStatus('')).toBeNull();
    expect(normalizeMirrorFbStatus(null)).toBeNull();
    // The Pages wire name is NOT a mirror filter value.
    expect(normalizeMirrorFbStatus('page_checkpoint')).toBeNull();
  });

  it('buildMirrorFbStatusSqlCondition: coarse matches status, detail matches error + fb_status', () => {
    const params: unknown[] = [];
    const pushParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length + 1}`;
    };
    expect(buildMirrorFbStatusSqlCondition(null, pushParam)).toBeNull();
    expect(buildMirrorFbStatusSqlCondition('active', pushParam)).toBe('status = $2');
    expect(buildMirrorFbStatusSqlCondition('error', pushParam)).toBe('status = $3');
    expect(buildMirrorFbStatusSqlCondition('missing_permission', pushParam)).toBe(
      "status = 'error' AND fb_status = $4",
    );
    expect(params).toEqual(['active', 'error', 'missing_permission']);
  });

  it('targetFbStatusFor: Facebook target detail in mirror spelling, stale rate-limit reads as active', () => {
    const fbMirror = asMirrorRow(mirrorRow())!;
    expect(
      targetFbStatusFor(
        fbMirror,
        asDestinationRow(destRow({ status: 'error', metadata: { fb_status: 'missing_permission' } }))!,
      ),
    ).toBe('missing_permission');
    expect(
      targetFbStatusFor(
        fbMirror,
        asDestinationRow(destRow({ status: 'error', metadata: { fb_status: 'checkpoint' } }))!,
      ),
    ).toBe('checkpoint');
    // Active target: no detail.
    expect(
      targetFbStatusFor(
        fbMirror,
        asDestinationRow(destRow({ status: 'active', metadata: {} }))!,
      ),
    ).toBeNull();
    // Missing destination: no detail.
    expect(targetFbStatusFor(fbMirror, null)).toBeNull();
    // Instagram targets never carry a Facebook detail.
    const igMirror = asMirrorRow(mirrorRow({ target_platform: 'instagram' }))!;
    expect(
      targetFbStatusFor(
        igMirror,
        asDestinationRow(destRow({ status: 'error', metadata: { fb_status: 'missing_permission' } }))!,
      ),
    ).toBeNull();
    // Rate-limited target with a stale anchor reads as active.
    expect(
      targetFbStatusFor(
        fbMirror,
        asDestinationRow(
          destRow({
            status: 'rate_limited',
            metadata: { rate_limited_at: '2026-10-25T12:00:00.000Z' },
          }),
        )!,
      ),
    ).toBeNull();
    // Fresh anchor: still rate-limited.
    expect(
      targetFbStatusFor(
        fbMirror,
        asDestinationRow(
          destRow({
            status: 'rate_limited',
            metadata: { rate_limited_at: new Date(Date.now() - 60_000).toISOString() },
          }),
        )!,
      ),
    ).toBe('fb_rate_limited');
  });

  it('toMirrorListView carries the mirror detail + anchor + target fallback', () => {
    const mirror = asMirrorRow(
      mirrorRow({
        status: 'error',
        fb_status: 'missing_permission',
        fb_rate_limited_at: null,
        last_error: 'Permissions error.',
      }),
    )!;
    const dest = asDestinationRow(
      destRow({ status: 'error', metadata: { fb_status: 'account_suspended' } }),
    )!;
    const view = toMirrorListView(mirror, dest, null, { posted: 0, failed: 1 }, false);
    // Own detail wins over the target's.
    expect(view.fbStatus).toBe('missing_permission');
    expect(view.fbRateLimitedAt).toBeNull();
    expect(view.targetFbStatus).toBe('account_suspended');
    expect(view.lastError).toBe('Permissions error.');
    expect(view.status).toBe('error');
  });

  it('toMirrorView falls back to the target detail when the mirror has none', () => {
    const mirror = asMirrorRow(
      mirrorRow({ status: 'error', fb_status: null, last_error: 'Something failed.' }),
    )!;
    const dest = asDestinationRow(
      destRow({ status: 'error', metadata: { fb_status: 'invalid_token' } }),
    )!;
    const view = toMirrorView(mirror, dest, null, null);
    expect(view.fbStatus).toBeNull();
    expect(view.targetFbStatus).toBe('invalid_token');
  });

  it('toMirrorView prefers the mirror own follower columns once populated, destination values before (spec 162)', () => {
    const details = {
      addedAt: '2026-10-01T00:00:00.000Z',
      followers: 1200,
      category: 'Community',
      accountDisplayName: 'Owner',
      accountAvatarUrl: null,
      startingFollowers: 1000,
    };
    // Before the first worker run the mirror columns are NULL:
    // the borrowed destination values are the fallback.
    const unpopulated = asMirrorRow(mirrorRow())!;
    const fallbackView = toMirrorView(unpopulated, null, null, details);
    expect(fallbackView.targetFollowers).toBe(1200);
    expect(fallbackView.targetStartingFollowers).toBe(1000);
    expect(fallbackView.startingFollowers).toBeNull();
    expect(fallbackView.currentFollowers).toBeNull();
    expect(fallbackView.followersUpdatedAt).toBeNull();
    // After the first worker run the mirror's own values win, even
    // when the destination has since moved on.
    const populated = asMirrorRow(
      mirrorRow({
        starting_followers: 1100,
        current_followers: 1300,
        followers_updated_at: '2026-11-10T22:00:00.000Z',
      }),
    )!;
    const ownView = toMirrorView(populated, null, null, details);
    expect(ownView.targetFollowers).toBe(1300);
    expect(ownView.targetStartingFollowers).toBe(1100);
    expect(ownView.startingFollowers).toBe(1100);
    expect(ownView.currentFollowers).toBe(1300);
    expect(ownView.followersUpdatedAt).toBe('2026-11-10T22:00:00.000Z');
  });

  it('list ?fbStatus= sends the detail condition to SQL (legacy path)', async () => {
    const { db, calls } = fakeDb();
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/tiktok-mirrors?fbStatus=missing_permission',
      { headers: { cookie: validSessionCookie } },
    );
    const res = await handleListMirrors(req, 'acme', db);
    expect(res.status).toBe(200);
    const listCall = calls.find((c) => c.sql.includes('FROM mirrors WHERE workspace_id') && c.sql.includes('ORDER BY'));
    expect(listCall).toBeDefined();
    expect(listCall!.sql).toContain("status = 'error' AND fb_status = $");
    expect(listCall!.params).toContain('missing_permission');
    const countCall = calls.find((c) => c.sql.includes('COUNT(*)'));
    expect(countCall!.sql).toContain('fb_status');
  });

  it('list ?fbStatus=bogus sends no status condition (unknown = no filter)', async () => {
    const { db, calls } = fakeDb();
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/tiktok-mirrors?fbStatus=bogus',
      { headers: { cookie: validSessionCookie } },
    );
    const res = await handleListMirrors(req, 'acme', db);
    expect(res.status).toBe(200);
    const listCall = calls.find((c) => c.sql.includes('FROM mirrors WHERE workspace_id') && c.sql.includes('ORDER BY'));
    expect(listCall).toBeDefined();
    // The SELECT list always carries fb_status / fb_rate_limited_at
    // (the view needs them); the assertion is about the filter: an
    // unknown value must add no fb_status condition to the WHERE.
    const whereClause = listCall!.sql.split('WHERE')[1] ?? '';
    expect(whereClause).not.toContain('fb_status');
  });

  it('detail returns fbStatus/targetFbStatus for an errored mirror', async () => {
    const { db } = fakeDb({
      mirrorRowOverride: {
        status: 'error',
        fb_status: 'missing_permission',
        last_error: 'Permissions error.',
      },
    });
    const req = new NextRequest(
      `http://localhost:3000/api/tenant/acme/tiktok-mirrors/${mirrorId}`,
      { headers: { cookie: validSessionCookie } },
    );
    const res = await handleGetMirror(req, 'acme', mirrorId, db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mirror: Record<string, unknown> };
    expect(body.mirror.fbStatus).toBe('missing_permission');
    expect(body.mirror.status).toBe('error');
  });
});
