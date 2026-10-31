import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST } from '@/app/api/tenant/[subdomain]/instagram/publish-now/route';

/**
 * Instagram Publish Now direct-publish route, tested with mocked
 * session, Supabase reads, and Instagram Graph responses — no real
 * token, database, or Instagram call. Covers: container-create →
 * poll FINISHED → media_publish success; sequential fan-out that
 * continues after a failure; the restriction reason mapping (code 1
 * / subcode 2424009); PUBLISHED-on-recheck settling published
 * without a second publish; the first-comment warning that never
 * fails a published row; the JPEG photo rule; idempotency replay
 * returning stored results without re-executing; and plain-language
 * validation messages (never a bare INVALID_REQUEST).
 */

vi.mock('@/lib/connect/session', () => ({
  resolveSocialRouteContext: vi.fn(async () => ({
    session: { userId: 'user-1' },
    workspaceId: 'ws-1',
  })),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

vi.mock('@/lib/storage', () => ({
  getR2Config: () => ({ publicUrl: 'https://r2.example.com' }),
}));

vi.mock('@fbuploadpro/contracts', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@fbuploadpro/contracts')
  >();
  return {
    ...actual,
    decryptToken: async () => 'acct-token',
    getTokenEncryptionKey: () => 'test-key',
  };
});

// In-memory idempotency store for this test file only.
const idempotencyStore = new Map<string, { status: number; body: unknown }>();
let idempotencyProcessing = new Set<string>();

vi.mock('@/lib/publishing/idempotency', () => ({
  parseIdempotencyKeyHeader: (headers: { get(name: string): string | null }) => {
    const raw = headers.get('Idempotency-Key');
    if (raw === null) return { key: null, invalid: false };
    const ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.trim());
    return ok ? { key: raw.trim(), invalid: false } : { key: null, invalid: true };
  },
  lookupIdempotencyResult: async (_client: unknown, scope: { key: string }) =>
    idempotencyStore.get(scope.key) ?? null,
  claimIdempotencyResult: async (_client: unknown, scope: { key: string }) => {
    if (idempotencyProcessing.has(scope.key)) return 'already-processing';
    idempotencyProcessing.add(scope.key);
    return 'claimed';
  },
  completeIdempotencyResult: async (
    _client: unknown,
    scope: { key: string },
    result: { status: number; body: unknown }
  ) => {
    idempotencyProcessing.delete(scope.key);
    idempotencyStore.set(scope.key, result);
    return true;
  },
  storeIdempotencyResult: async (
    _client: unknown,
    scope: { key: string },
    result: { status: number; body: unknown }
  ) => {
    idempotencyStore.set(scope.key, result);
  },
  updateIdempotencyResult: async (
    _client: unknown,
    scope: { key: string },
    result: { status: number; body: unknown }
  ) => {
    idempotencyStore.set(scope.key, result);
  },
  releaseIdempotencyClaim: async (_client: unknown, scope: { key: string }) => {
    idempotencyProcessing.delete(scope.key);
  },
}));

type SupabaseChain = {
  select: () => SupabaseChain;
  eq: (key: string, value: unknown) => SupabaseChain;
  is: () => SupabaseChain;
  lte: () => SupabaseChain;
  gt: () => SupabaseChain;
  neq: () => SupabaseChain;
  order: () => SupabaseChain;
  limit: () => SupabaseChain;
  insert: () => SupabaseChain;
  maybeSingle: () => Promise<unknown>;
  data?: unknown;
  count?: number;
  error?: unknown;
};

const ACCOUNT_MAP: Record<string, string> = {
  '11111111-1111-4111-a111-111111111111': 'ig-user-1',
  '22222222-2222-4222-a222-222222222222': 'ig-user-2',
};

let mediaRow: {
  id: string;
  media_type: string;
  url: string;
  mime_type: string;
  file_size: number;
  width: number | null;
  height: number | null;
} = {
  id: '33333333-3333-4333-a333-333333333333',
  media_type: 'image',
  url: 'https://media.example.com/photo.jpg',
  mime_type: 'image/jpeg',
  file_size: 1000,
  width: 1080,
  height: 1350,
};

let createFailures: Record<string, { code: number; error_subcode: number } | undefined> = {};
let commentShouldFail = false;
let publishShouldFail = false;
let containerStatus = 'FINISHED';
let containerCounter = 0;
let publishedContainers = new Set<string>();

let periodRow: Record<string, unknown> = {};
let periodPresent = true;
const insertedTables: string[] = [];

function supabaseBuilder(table: string): SupabaseChain {
  const eqValues = new Map<string, unknown>();
  const builder: SupabaseChain = {
    select: () => builder,
    eq: (key: string, value: unknown) => {
      eqValues.set(key, value);
      return builder;
    },
    is: () => builder,
    lte: () => builder,
    gt: () => builder,
    neq: () => builder,
    order: () => builder,
    limit: () => builder,
    insert: () => {
      insertedTables.push(table);
      return builder;
    },
    maybeSingle: async () => {
      if (table === 'media_items') {
        return { data: mediaRow, error: null };
      }
      if (table === 'social_accounts') {
        const id = eqValues.get('id') as string | undefined;
        const igUserId = id ? ACCOUNT_MAP[id] : undefined;
        if (!igUserId) return { data: null, error: null };
        return {
          data: {
            external_account_id: igUserId,
            encrypted_access_token: 'enc-token',
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
  if (table === 'subscription_periods') {
    builder.data = periodPresent ? [periodRow] : [];
    builder.error = null;
  }
  if (table === 'subscription_usage') {
    builder.data = [];
    builder.count = 0;
    builder.error = null;
  }
  return builder;
}

vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: () => ({
    from: (table: string) => supabaseBuilder(table),
  }),
}));

function graphResponse(ok: boolean, status: number, data: unknown) {
  return {
    ok,
    status,
    headers: new Headers(),
    json: async () => data,
  } as unknown as Response;
}

beforeEach(() => {
  createFailures = {};
  commentShouldFail = false;
  publishShouldFail = false;
  containerStatus = 'FINISHED';
  containerCounter = 0;
  publishedContainers = new Set<string>();
  idempotencyStore.clear();
  periodRow = {
    id: 'period-1',
    user_id: 'user-1',
    facebook_count: 10,
    instagram_count: 10,
    threads_count: 10,
    x_count: 10,
    tiktok_count: 10,
    youtube_count: 10,
    starts_at: '2020-01-01T00:00:00.000Z',
    ends_at: '2099-01-01T00:00:00.000Z',
    superseded_at: null,
  };
  periodPresent = true;
  insertedTables.length = 0;
  idempotencyProcessing = new Set<string>();
  mediaRow = {
    id: '33333333-3333-4333-a333-333333333333',
    media_type: 'image',
    url: 'https://media.example.com/photo.jpg',
    mime_type: 'image/jpeg',
    file_size: 1000,
    width: 1080,
    height: 1350,
  };

  vi.stubGlobal('fetch', async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    if (url.includes('media.example.com') || url.includes('r2.example.com')) {
      const isVideo = url.endsWith('.mp4');
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': isVideo ? 'video/mp4' : 'image/jpeg',
          'content-length': '1000',
        }),
        json: async () => ({}),
      } as unknown as Response;
    }
    if (url.includes('/media_publish')) {
      const bodyText = typeof init?.body === 'string' ? init.body : '{}';
      const creationId = (JSON.parse(bodyText) as { creation_id?: string }).creation_id;
      if (publishShouldFail) {
        // The post went live despite the failed response: the
        // recheck below must see PUBLISHED for this container.
        if (creationId) publishedContainers.add(creationId);
        return graphResponse(false, 500, {
          error: { message: 'Server error', code: 1 },
        });
      }
      if (creationId) publishedContainers.add(creationId);
      return graphResponse(true, 200, { id: 'media-1' });
    }
    if (url.includes('?fields=status_code')) {
      const containerId = url.split('/v26.0/')[1]?.split('?')[0] ?? '';
      const decoded = decodeURIComponent(containerId);
      return graphResponse(true, 200, {
        status_code: publishedContainers.has(decoded) ? 'PUBLISHED' : containerStatus,
      });
    }
    if (url.includes('/comments')) {
      if (commentShouldFail) {
        return graphResponse(false, 400, {
          error: { message: 'Comment failed', code: 1 },
        });
      }
      return graphResponse(true, 200, { id: 'comment-1' });
    }
    const createMatch = url.match(/\/v26\.0\/([^/]+)\/media$/);
    if (createMatch && init?.method === 'POST') {
      const failure = createFailures[createMatch[1] as string];
      if (failure) {
        return graphResponse(false, 400, {
          error: {
            message: 'An unknown error occurred',
            code: failure.code,
            error_subcode: failure.error_subcode,
            fbtrace_id: 'trace-1',
          },
        });
      }
      containerCounter += 1;
      return graphResponse(true, 200, { id: `container-${containerCounter}` });
    }
    return graphResponse(false, 404, {});
  });
});

const ACCOUNT_1 = '11111111-1111-4111-a111-111111111111';
const ACCOUNT_2 = '22222222-2222-4222-a222-222222222222';
const MEDIA_ID = '33333333-3333-4333-a333-333333333333';

function photoBody(targets: Array<{ accountId: string; accountName: string }>) {
  return {
    caption: 'Hello',
    postType: 'photo',
    targets,
    media: {
      source: 'library',
      mediaId: MEDIA_ID,
      tempKey: null,
      url: 'https://media.example.com/photo.jpg',
      mediaType: 'image',
      aspectRatio: '4:5',
      width: 1080,
      height: 1350,
      name: 'photo.jpg',
    },
  };
}

async function callPost(body: unknown, headers?: Record<string, string>) {
  const request = new NextRequest(
    'http://localhost/api/tenant/acme/instagram/publish-now',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    }
  );
  const response = await POST(request, {
    params: Promise.resolve({ subdomain: 'acme' }),
  });
  return { status: response.status, body: await response.json() };
}

describe('POST instagram/publish-now', () => {
  it('publishes a photo to both accounts with a first comment on each', async () => {
    const { status, body } = await callPost({
      ...photoBody([
        { accountId: ACCOUNT_1, accountName: 'Creator One' },
        { accountId: ACCOUNT_2, accountName: 'Creator Two' },
      ]),
      firstComment: 'Nice!',
    });
    expect(status).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({
      status: 'published',
      postId: 'media-1',
      firstCommentFailed: null,
    });
    expect(body.results[1]).toMatchObject({
      status: 'published',
      postId: 'media-1',
    });
  });

  it('publishes even with zero bought accounts and writes no usage row (Publish Now is uncapped)', async () => {
    periodRow = { ...periodRow, instagram_count: 0 };
    const { status, body } = await callPost({
      ...photoBody([
        { accountId: ACCOUNT_1, accountName: 'Creator One' },
        { accountId: ACCOUNT_2, accountName: 'Creator Two' },
      ]),
      firstComment: 'Nice!',
    });
    expect(status).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].status).toBe('published');
    expect(body.results[1].status).toBe('published');
    expect(insertedTables).not.toContain('subscription_usage');
  });

  it('still refuses a user with no paid period', async () => {
    periodPresent = false;
    const { status, body } = await callPost(
      photoBody([{ accountId: ACCOUNT_1, accountName: 'Creator One' }])
    );
    expect(status).toBe(403);
    expect(body.error).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('continues to the next account when one fails, and maps the restriction', async () => {
    createFailures = { 'ig-user-2': { code: 1, error_subcode: 2424009 } };
    const { status, body } = await callPost(
      photoBody([
        { accountId: ACCOUNT_1, accountName: 'Creator One' },
        { accountId: ACCOUNT_2, accountName: 'Creator Two' },
      ])
    );
    expect(status).toBe(200);
    expect(body.results[0].status).toBe('published');
    expect(body.results[1]).toMatchObject({
      status: 'failed',
      graphCode: 1,
      graphSubcode: 2424009,
      step: 'container-create',
      httpStatus: 400,
    });
    expect(body.results[1].reason).toContain(
      'Instagram has restricted this account from posting'
    );
  });

  it('settles published when a failed media_publish is followed by a PUBLISHED container', async () => {
    publishShouldFail = true;
    const { status, body } = await callPost(
      photoBody([{ accountId: ACCOUNT_1, accountName: 'Creator One' }])
    );
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({
      status: 'published',
      postId: 'container-1',
    });
  });

  it('keeps a published row published when its first comment fails', async () => {
    commentShouldFail = true;
    const { status, body } = await callPost({
      ...photoBody([{ accountId: ACCOUNT_1, accountName: 'Creator One' }]),
      firstComment: 'Nice!',
    });
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({
      status: 'published',
      firstCommentFailed: true,
    });
    expect(body.results[0].firstCommentReason).toBeTruthy();
  });

  it('rejects a non-JPEG library photo with the plain JPEG rule', async () => {
    mediaRow = { ...mediaRow, mime_type: 'image/png' };
    const { status, body } = await callPost(
      photoBody([{ accountId: ACCOUNT_1, accountName: 'Creator One' }])
    );
    expect(status).toBe(400);
    expect(body.message).toContain('Instagram photos must be JPEG');
  });

  it('replays a stored result for the same idempotency key without re-executing', async () => {
    const key = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const first = await callPost(
      photoBody([{ accountId: ACCOUNT_1, accountName: 'Creator One' }]),
      { 'Idempotency-Key': key }
    );
    expect(first.status).toBe(200);
    expect(first.body.results[0].status).toBe('published');
    // Break Graph for the second call: a replay must not reach it.
    createFailures = { 'ig-user-1': { code: 1, error_subcode: 2424009 } };
    const second = await callPost(
      photoBody([{ accountId: ACCOUNT_1, accountName: 'Creator One' }]),
      { 'Idempotency-Key': key }
    );
    expect(second.status).toBe(200);
    expect(second.body.results[0].status).toBe('published');
  });

  it('returns plain-language validation messages, never a bare code', async () => {
    const empty = await callPost(photoBody([]));
    expect(empty.status).toBe(400);
    expect(empty.body.message).toBe('Please select at least one account.');

    const noMedia = await callPost({
      caption: 'Hello',
      postType: 'photo',
      targets: [{ accountId: ACCOUNT_1, accountName: 'Creator One' }],
      media: null,
    });
    expect(noMedia.status).toBe(400);
    expect(noMedia.body.message).toBe('This post type needs media.');

    const longCaption = await callPost({
      ...photoBody([{ accountId: ACCOUNT_1, accountName: 'Creator One' }]),
      caption: 'x'.repeat(2201),
    });
    expect(longCaption.status).toBe(400);
    expect(longCaption.body.message).toContain('2,200');
  });
});
