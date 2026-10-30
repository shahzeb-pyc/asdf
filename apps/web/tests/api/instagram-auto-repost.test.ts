/**
 * Instagram Auto Repost API (legacy DB path): create posts the latest
 * reel to the chosen Instagram account, duplicate (username + IG
 * account) is blocked, a different IG account is allowed, expired
 * accounts and feed failures create nothing, and the list filters
 * by targetPlatform=instagram.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { encryptToken, signSessionToken } from '@fbuploadpro/contracts';
import {
  handleCreateMirror,
  handleListMirrors,
} from '../../src/app/api/tenant/[subdomain]/tiktok-mirrors/route';
import { TikwmError } from '../../src/lib/server/tikwm';
import type { DatabaseClient } from '@fbuploadpro/contracts';

const TEST_SECRET = 'test-session-secret-that-is-long-enough-123456';
const TEST_KEY = 'a'.repeat(64);

const userId = '11111111-1111-4111-a111-111111111111';
const accountId = '22222222-2222-4222-a222-222222222222';
const destId = '33333333-3333-4333-a333-333333333333';
const mirrorId = '44444444-4444-4444-a444-444444444444';
const postId = '55555555-5555-4555-a555-555555555555';
const igUserId = '17841400008460056';

let validSessionCookie: string;
let encAccountToken: string;

function createRequest(body: unknown, cookie = validSessionCookie): NextRequest {
  return new NextRequest('http://localhost:3000/api/tenant/acme/tiktok-mirrors', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { cookie, 'content-type': 'application/json' },
  });
}

function listRequest(url: string, cookie = validSessionCookie): NextRequest {
  return new NextRequest(url, { headers: { cookie } });
}

function mirrorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: mirrorId,
    workspace_id: 'ws_1',
    source_platform: 'tiktok',
    source_username: 'alice',
    source_display_name: 'Alice',
    source_avatar_url: 'https://example.com/a.jpg',
    target_platform: 'instagram',
    target_external_id: igUserId,
    target_display_name: 'Alice on IG',
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
    external_destination_id: igUserId,
    name: 'Alice on IG',
    avatar_url: null,
    encrypted_destination_token: null,
    status: 'active',
    ...overrides,
  };
}

interface FakeDbOptions {
  existingDestination?: Record<string, unknown> | null;
  duplicate?: boolean;
  accountStatus?: string;
  accountExternalId?: string;
}

function fakeDb(options: FakeDbOptions = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const existing = options.existingDestination ?? null;
  const accountStatus = options.accountStatus ?? 'active';
  const accountExternalId = options.accountExternalId ?? igUserId;
  const db: Partial<DatabaseClient> = {
    query: vi.fn().mockImplementation((sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM workspaces')) return Promise.resolve([{ id: 'ws_1' }]);
      if (sql.includes('FROM social_accounts')) {
        return Promise.resolve([
          {
            id: accountId,
            external_account_id: accountExternalId,
            display_name: 'Alice on IG',
            avatar_url: null,
            status: accountStatus,
            encrypted_access_token: encAccountToken,
          },
        ]);
      }
      if (sql.includes('FROM destinations WHERE account_id')) {
        return Promise.resolve(existing ? [existing] : []);
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
        return Promise.resolve([mirrorRow()]);
      }
      if (sql.includes('COUNT(*)')) {
        return Promise.resolve([{ total: 1 }]);
      }
      if (sql.includes('FROM mirrors WHERE workspace_id')) {
        // Filtered list: params are [ws, platform, limit, offset];
        // unfiltered: [ws, limit, offset].
        const limit =
          typeof params[1] === 'string'
            ? (params[2] as number)
            : (params[1] as number);
        const offset =
          typeof params[1] === 'string'
            ? (params[3] as number)
            : (params[2] as number);
        return Promise.resolve([mirrorRow()].slice(offset, offset + limit));
      }
      if (sql.includes('FROM destinations WHERE workspace_id')) {
        return Promise.resolve([destRow()]);
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

const createDeps = (options: { publishInstagram?: unknown; feedError?: boolean } = {}) => ({
  fetchTikwmPosts: options.feedError
    ? vi.fn().mockRejectedValue(new TikwmError('Feed unavailable'))
    : vi.fn().mockResolvedValue([feedVideo()]),
  fetchTikwmInfo: vi.fn().mockResolvedValue({
    unique_id: 'alice',
    nickname: 'Alice',
    avatar: 'https://example.com/a.jpg',
  }),
  resolveTikwmVideo: vi.fn().mockResolvedValue({
    playUrl: 'https://example.com/no-wm.mp4',
    title: 'My exact caption',
  }),
  publishInstagramReel:
    options.publishInstagram ?? vi.fn().mockResolvedValue('ig_media_123'),
});

const igBody = {
  accountId,
  targetExternalId: igUserId,
  targetPlatform: 'instagram',
  sourceUsername: 'alice',
};

describe('POST /tiktok-mirrors (Instagram target)', () => {
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
    encAccountToken = await encryptToken('ig-acct-token-plain', TEST_KEY);
  });

  it('creates an Instagram mirror and posts the latest reel to the Instagram account', async () => {
    const { db, calls } = fakeDb({ existingDestination: destRow() });
    const deps = createDeps();
    const res = await handleCreateMirror(createRequest(igBody), 'acme', db, deps);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mirror.targetPlatform).toBe('instagram');
    expect(body.mirror.targetExternalId).toBe(igUserId);
    expect(body.immediatePost.status).toBe('posted');
    expect(body.immediatePost.publishedPostId).toBe('ig_media_123');
    const publish = deps.publishInstagramReel as ReturnType<typeof vi.fn>;
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        igUserId,
        videoUrl: 'https://example.com/no-wm.mp4',
        caption: 'My exact caption',
      })
    );
    // The mirror insert carried the Instagram platform, not facebook.
    const mirrorInsert = calls.find((c) => c.sql.includes('INSERT INTO mirrors'));
    expect(mirrorInsert?.params).toContain('instagram');
  });

  it('blocks the exact duplicate (same username + same Instagram account)', async () => {
    const { db } = fakeDb({ existingDestination: destRow(), duplicate: true });
    const deps = createDeps();
    const res = await handleCreateMirror(createRequest(igBody), 'acme', db, deps);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.message).toContain('Instagram account');
    expect(deps.publishInstagramReel).not.toHaveBeenCalled();
  });

  it('refuses an expired Instagram account and creates nothing', async () => {
    const { db, calls } = fakeDb({ existingDestination: destRow(), accountStatus: 'expired' });
    const deps = createDeps();
    const res = await handleCreateMirror(createRequest(igBody), 'acme', db, deps);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('ACCOUNT_EXPIRED');
    expect(calls.some((c) => c.sql.includes('INSERT INTO mirrors'))).toBe(false);
    expect(deps.publishInstagramReel).not.toHaveBeenCalled();
  });

  it('refuses a mismatched external id and creates nothing', async () => {
    const { db, calls } = fakeDb({
      existingDestination: destRow(),
      accountExternalId: '99999999999999999',
    });
    const deps = createDeps();
    const res = await handleCreateMirror(createRequest(igBody), 'acme', db, deps);
    expect(res.status).toBe(404);
    expect(calls.some((c) => c.sql.includes('INSERT INTO mirrors'))).toBe(false);
  });

  it('a feed failure creates nothing', async () => {
    const { db, calls } = fakeDb({ existingDestination: destRow() });
    const deps = createDeps({ feedError: true });
    const res = await handleCreateMirror(createRequest(igBody), 'acme', db, deps);
    expect(res.status).toBe(400);
    expect(calls.some((c) => c.sql.includes('INSERT INTO mirrors'))).toBe(false);
    expect(deps.publishInstagramReel).not.toHaveBeenCalled();
  });
});

describe('GET /tiktok-mirrors?targetPlatform=instagram', () => {
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
    encAccountToken = await encryptToken('ig-acct-token-plain', TEST_KEY);
  });

  it('returns Instagram mirrors and sends the platform filter to the database', async () => {
    const { db, calls } = fakeDb();
    const res = await handleListMirrors(
      listRequest('http://localhost:3000/api/tenant/acme/tiktok-mirrors?targetPlatform=instagram&page=1&limit=30'),
      'acme',
      db
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mirrors).toHaveLength(1);
    expect(body.mirrors[0].targetPlatform).toBe('instagram');
    expect(calls.some((c) => c.sql.includes('target_platform') && c.params.includes('instagram'))).toBe(true);
  });

  it('rejects an unknown targetPlatform', async () => {
    const { db } = fakeDb();
    const res = await handleListMirrors(
      listRequest('http://localhost:3000/api/tenant/acme/tiktok-mirrors?targetPlatform=youtube'),
      'acme',
      db
    );
    expect(res.status).toBe(400);
  });
});
