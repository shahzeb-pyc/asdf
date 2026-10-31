import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST } from '@/app/api/tenant/[subdomain]/publishing/publish-now/route';

/**
 * Publish Now direct-publish route (PR #33), tested with mocked
 * session, Supabase reads, and Facebook Graph responses — no real
 * token, database, or Facebook call. Covers: sequential fan-out
 * that continues after a failure, the restriction reason mapping
 * (code 1 / subcode 2424009), the publish-rights pre-check, the
 * first-comment warning that never fails a published row, and the
 * plain-language validation messages (never a bare INVALID_REQUEST).
 */

vi.mock('@/lib/connect/session', () => ({
  resolveSocialRouteContext: vi.fn(async () => ({
    session: { userId: 'user-1' },
    workspaceId: 'ws-1',
  })),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
  trackServerEvent: vi.fn(),
}));

vi.mock('@/lib/storage', () => ({
  getR2Config: () => null,
  // Post-owned keys resolve to media.example.com so the fetch
  // mock below serves their bytes, exactly as R2's public URL
  // would in production.
  getStorageService: () => ({
    listObjects: async ({ prefix }: { prefix: string }) =>
      existingStorageKeys.has(prefix) ? [{ key: prefix }] : [],
    getPublicUrl: (key: string) =>
      `https://media.example.com/${key.split('/').pop()}`,
    deleteObject: async (key: string) => {
      deletedStorageKeys.push(key);
      existingStorageKeys.delete(key);
    },
  }),
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

type GraphPage = {
  id: string;
  name: string;
  tasks: string[];
  access_token: string;
};

let graphPages: GraphPage[] = [];
let feedFailures: Record<
  string,
  { code: number; error_subcode: number } | undefined
> = {};
let commentShouldFail = false;
let permissionsResponse: {
  data: Array<{ permission: string; status: string }>;
} = { data: [] };
let mediaRow: { id: string; media_type: string; url: string } | null = {
  id: '22222222-2222-4222-a222-222222222222',
  media_type: 'image',
  url: 'https://media.example.com/photo.jpg',
};
let mediaFetchShouldFail = false;
let headShouldFail = false;
let existingStorageKeys = new Set<string>();
let deletedStorageKeys: string[] = [];

function graphResponse(ok: boolean, status: number, data: unknown) {
  return {
    ok,
    status,
    json: async () => data,
  } as unknown as Response;
}

/**
 * Subscription fixtures for the publish-now plan gate (added
 * with the subscription feature): the route's plan-only gate
 * (assertPaidPlan) still queries the entitlement — an active paid
 * period — before any Facebook call. Publish Now is unlimited
 * (owner decision 2026-10-31): it writes no usage rows and has no
 * per-page cap, so the fake client must answer the entitlement
 * queries the gate makes. Without these, the gate's query chain
 * (.is/.lte/.gt/.order/.limit/.neq) hits a builder that has none
 * of them and every publish-now test fails before Facebook is
 * called.
 */
type SupabaseChain = {
  select: () => SupabaseChain;
  eq: () => SupabaseChain;
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

let periodRow: Record<string, unknown> = {};
let periodPresent = true;
const insertedTables: string[] = [];

function supabaseBuilder(table: string): SupabaseChain {
  const builder: SupabaseChain = {
    select: () => builder,
    eq: () => builder,
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
      return {
        data: { encrypted_access_token: 'enc-token' },
        error: null,
      };
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

beforeEach(() => {
  graphPages = [
    {
      id: '111',
      name: 'Page One',
      tasks: ['CREATE_CONTENT'],
      access_token: 'page-token-1',
    },
    {
      id: '222',
      name: 'Page Two',
      tasks: ['CREATE_CONTENT'],
      access_token: 'page-token-2',
    },
  ];
  feedFailures = {};
  commentShouldFail = false;
  permissionsResponse = { data: [] };
  mediaRow = {
    id: '22222222-2222-4222-a222-222222222222',
    media_type: 'image',
    url: 'https://media.example.com/photo.jpg',
  };
  mediaFetchShouldFail = false;
  headShouldFail = false;
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
  existingStorageKeys = new Set([
    POST_OWNED_PHOTO_KEY,
    POST_OWNED_CLIP_KEY,
    POST_OWNED_STAGED_KEY,
  ]);
  deletedStorageKeys = [];

  vi.stubGlobal(
    'fetch',
    async (
      input: unknown,
      init?: { method?: string; body?: unknown }
    ) => {
      const url = String(input);
      if (url.includes('/me/accounts')) {
        return graphResponse(true, 200, { data: graphPages });
      }
      if (url.includes('/me/permissions')) {
        return graphResponse(true, 200, permissionsResponse);
      }
      if (url.includes('/comments')) {
        if (commentShouldFail) {
          return graphResponse(false, 400, {
            error: { message: 'Comment failed', code: 1 },
          });
        }
        return graphResponse(true, 200, { id: 'comment-1' });
      }
      if (url.includes('media.example.com')) {
        if (init?.method === 'HEAD') {
          return headShouldFail
            ? graphResponse(false, 404, {})
            : graphResponse(true, 200, {});
        }
        if (mediaFetchShouldFail) {
          return {
            ok: false,
            status: 404,
            body: null,
            headers: new Headers(),
            arrayBuffer: async () => new ArrayBuffer(0),
            json: async () => ({}),
          } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          body: {},
          headers: new Headers({
            'content-length': '8',
            'content-type': 'image/jpeg',
          }),
          arrayBuffer: async () =>
            new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
          json: async () => ({}),
        } as unknown as Response;
      }
      if (url.includes('rupload.example.com')) {
        return graphResponse(true, 200, {});
      }
      const photosMatch = url.match(/\/(\d+)\/photos$/);
      if (photosMatch) {
        return graphResponse(true, 200, {
          post_id: `photo-post-${photosMatch[1]}`,
        });
      }
      const videosMatch = url.match(/\/(\d+)\/videos$/);
      if (videosMatch) {
        return graphResponse(true, 200, { id: `video-post-${videosMatch[1]}` });
      }
      if (url.includes('/video_reels')) {
        const bodyText =
          typeof init?.body === 'string' ? init.body : '{}';
        const parsedBody = JSON.parse(bodyText) as {
          upload_phase?: string;
        };
        if (parsedBody.upload_phase === 'start') {
          return graphResponse(true, 200, {
            video_id: 'vid-1',
            upload_url: 'https://rupload.example.com/up',
          });
        }
        return graphResponse(true, 200, { post_id: 'reel-post-111' });
      }
      const feedMatch = url.match(/\/(\d+)\/feed$/);
      if (feedMatch) {
        const failure = feedFailures[feedMatch[1]];
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
        return graphResponse(true, 200, { id: `post-${feedMatch[1]}` });
      }
      return graphResponse(false, 404, {});
    }
  );
});

const ACCOUNT_ID = '11111111-1111-4111-a111-111111111111';

const POST_OWNED_PHOTO_KEY =
  'users/user-1/post-media/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/photo.jpg';
const POST_OWNED_CLIP_KEY =
  'users/user-1/post-media/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb/clip.mp4';
const POST_OWNED_STAGED_KEY =
  'users/user-1/post-staging/cccccccc-cccc-4ccc-cccc-cccccccccccc/photo.jpg';

function postOwnedMedia(key: string, mediaType: 'image' | 'video') {
  return {
    source: 'post-owned' as const,
    mediaId: null,
    tempKey: null,
    postOwnedKey: key,
    url: `https://media.example.com/${key.split('/').pop()}`,
    mediaType,
    aspectRatio: null,
    width: null,
    height: null,
    name: key.split('/').pop()!,
  };
}

function target(fbPageId: string, pageName: string) {
  return { accountId: ACCOUNT_ID, fbPageId, pageName };
}

async function callPost(body: unknown) {
  const request = new NextRequest(
    'http://localhost/api/tenant/acme/publishing/publish-now',
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }
  );
  const response = await POST(request, {
    params: Promise.resolve({ subdomain: 'acme' }),
  });
  return { status: response.status, body: await response.json() };
}

describe('POST publish-now', () => {
  it('publishes a text post to both pages with a first comment on each', async () => {
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'text',
      firstComment: 'Nice!',
      targets: [target('111', 'Page One'), target('222', 'Page Two')],
      media: null,
    });
    expect(status).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({
      status: 'published',
      postId: 'post-111',
      firstCommentFailed: null,
    });
    expect(body.results[1]).toMatchObject({
      status: 'published',
      postId: 'post-222',
      firstCommentFailed: null,
    });
  });

  it('publishes even with zero bought pages and writes no usage row (Publish Now is uncapped)', async () => {
    periodRow = { ...periodRow, facebook_count: 0 };
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'text',
      targets: [target('111', 'Page One'), target('222', 'Page Two')],
      media: null,
    });
    expect(status).toBe(200);
    expect(body.results).toHaveLength(2);
    expect(body.results[0].status).toBe('published');
    expect(body.results[1].status).toBe('published');
    expect(insertedTables).not.toContain('subscription_usage');
  });

  it('still refuses a user with no paid period', async () => {
    periodPresent = false;
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'text',
      targets: [target('111', 'Page One')],
      media: null,
    });
    expect(status).toBe(403);
    expect(body.error).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('continues to the next page when one fails, and maps the restriction', async () => {
    feedFailures = { '222': { code: 1, error_subcode: 2424009 } };
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'text',
      targets: [target('111', 'Page One'), target('222', 'Page Two')],
      media: null,
    });
    expect(status).toBe(200);
    expect(body.results[0].status).toBe('published');
    expect(body.results[1]).toMatchObject({
      status: 'failed',
      graphCode: 1,
      graphSubcode: 2424009,
      step: 'feed',
      httpStatus: 400,
    });
    expect(body.results[1].reason).toContain(
      'Facebook has restricted this account from posting'
    );
  });

  it('keeps a published row published when its first comment fails', async () => {
    commentShouldFail = true;
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'text',
      firstComment: 'Nice!',
      targets: [target('111', 'Page One')],
      media: null,
    });
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({
      status: 'published',
      postId: 'post-111',
      firstCommentFailed: true,
    });
    expect(body.results[0].firstCommentReason).toBeTruthy();
  });

  it('fails fast on the pre-check when the page role cannot create content', async () => {
    graphPages = [
      {
        id: '111',
        name: 'Page One',
        tasks: ['ANALYZE'],
        access_token: 'page-token-1',
      },
    ];
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'text',
      targets: [target('111', 'Page One')],
      media: null,
    });
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({
      status: 'failed',
      step: 'precheck',
    });
    expect(body.results[0].reason).toContain(
      'does not include creating content'
    );
  });

  it('returns plain-language validation messages, never a bare code', async () => {
    const empty = await callPost({
      caption: 'Hello',
      postType: 'text',
      targets: [],
      media: null,
    });
    expect(empty.status).toBe(400);
    expect(empty.body.message).toBe('Please select at least one page.');

    const blankText = await callPost({
      caption: '   ',
      postType: 'text',
      targets: [target('111', 'Page One')],
      media: null,
    });
    expect(blankText.status).toBe(400);
    expect(blankText.body.message).toBe('A text post needs text.');

    const imageWithoutMedia = await callPost({
      caption: 'Hello',
      postType: 'image',
      targets: [target('111', 'Page One')],
      media: null,
    });
    expect(imageWithoutMedia.status).toBe(400);
    expect(imageWithoutMedia.body.message).toBe(
      'This post type needs media.'
    );

    // A reel with media reaches the per-type limit check; without
    // media the earlier "needs media" check fires first.
    const longReel = await callPost({
      caption: 'x'.repeat(2201),
      postType: 'reel',
      targets: [target('111', 'Page One')],
      media: postOwnedMedia(POST_OWNED_CLIP_KEY, 'video'),
    });
    expect(longReel.status).toBe(400);
    expect(longReel.body.message).toBe(
      'Text exceeds the 2,200-character limit'
    );
  });

  it('publishes a photo from its post-owned copy and cleans the bytes up', async () => {
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'image',
      targets: [target('111', 'Page One')],
      media: postOwnedMedia(POST_OWNED_PHOTO_KEY, 'image'),
    });
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({
      status: 'published',
      postId: 'photo-post-111',
    });
    // Fully successful run: Facebook holds the post, so the
    // post-owned bytes are removed, never left lingering.
    expect(deletedStorageKeys).toContain(POST_OWNED_PHOTO_KEY);
  });

  it('publishes a photo from staged bytes, not a library row', async () => {
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'image',
      targets: [target('111', 'Page One')],
      media: postOwnedMedia(POST_OWNED_STAGED_KEY, 'image'),
    });
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({
      status: 'published',
      postId: 'photo-post-111',
    });
    expect(deletedStorageKeys).toContain(POST_OWNED_STAGED_KEY);
  });

  it('fails a photo with a media-fetch step when its bytes cannot be fetched, and keeps the bytes for retry', async () => {
    mediaFetchShouldFail = true;
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'image',
      targets: [target('111', 'Page One')],
      media: postOwnedMedia(POST_OWNED_PHOTO_KEY, 'image'),
    });
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({
      status: 'failed',
      step: 'media-fetch',
    });
    // Failed run: the bytes stay so "Retry failed only" can reuse them.
    expect(deletedStorageKeys).not.toContain(POST_OWNED_PHOTO_KEY);
  });

  it('publishes a video after the reachability guard passes', async () => {
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'video',
      targets: [target('111', 'Page One')],
      media: postOwnedMedia(POST_OWNED_CLIP_KEY, 'video'),
    });
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({
      status: 'published',
      postId: 'video-post-111',
    });
  });

  it('rejects a video outright when its URL is not reachable', async () => {
    headShouldFail = true;
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'video',
      targets: [target('111', 'Page One')],
      media: postOwnedMedia(POST_OWNED_CLIP_KEY, 'video'),
    });
    expect(status).toBe(400);
    expect(body.message).toContain('Please re-attach the video');
  });

  it('publishes a reel through start, upload, and finish', async () => {
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'reel',
      targets: [target('111', 'Page One')],
      media: postOwnedMedia(POST_OWNED_CLIP_KEY, 'video'),
    });
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({
      status: 'published',
      postId: 'reel-post-111',
    });
  });

  it('fails fast on the pre-check when posting permission is declined', async () => {
    permissionsResponse = {
      data: [{ permission: 'pages_manage_posts', status: 'declined' }],
    };
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'text',
      targets: [target('111', 'Page One')],
      media: null,
    });
    expect(status).toBe(200);
    expect(body.results[0]).toMatchObject({
      status: 'failed',
      step: 'precheck',
    });
    expect(body.results[0].reason).toContain(
      'has not allowed posting to pages'
    );
  });

  it('rejects a library media reference outright — the publish path never reads library rows', async () => {
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'image',
      targets: [target('111', 'Page One')],
      media: {
        source: 'library',
        mediaId: '22222222-2222-4222-a222-222222222222',
        tempKey: null,
        url: 'https://media.example.com/photo.jpg',
        mediaType: 'image',
        aspectRatio: null,
        width: null,
        height: null,
        name: 'photo.jpg',
      },
    });
    expect(status).toBe(400);
    expect(body.message).toContain('pick it again');
  });

  it('rejects a post-owned key that no longer exists in storage', async () => {
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'image',
      targets: [target('111', 'Page One')],
      media: postOwnedMedia(
        'users/user-1/post-media/dddddddd-dddd-4ddd-dddd-dddddddddddd/gone.jpg',
        'image'
      ),
    });
    expect(status).toBe(400);
    expect(body.message).toContain('no longer available');
  });

  it('rejects a post-owned key outside the caller’s own prefix', async () => {
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'image',
      targets: [target('111', 'Page One')],
      media: postOwnedMedia(
        'users/user-2/post-media/eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee/photo.jpg',
        'image'
      ),
    });
    expect(status).toBe(400);
    expect(body.message).toContain('could not be verified');
  });

  it('rejects temp media whose key does not verify', async () => {
    const { status, body } = await callPost({
      caption: 'Hello',
      postType: 'image',
      targets: [target('111', 'Page One')],
      media: {
        source: 'temp',
        mediaId: null,
        tempKey: 'users/user-1/publish-now-temp/abc/photo.jpg',
        url: 'https://media.example.com/photo.jpg',
        mediaType: 'image',
        aspectRatio: null,
        width: null,
        height: null,
        name: 'photo.jpg',
      },
    });
    // The R2 config mock returns null, so no temp URL can verify.
    expect(status).toBe(400);
    expect(body.message).toContain('could not be verified');
  });
});
