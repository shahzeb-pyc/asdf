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
}));

vi.mock('@/lib/storage', () => ({
  getR2Config: () => null,
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

function graphResponse(ok: boolean, status: number, data: unknown) {
  return {
    ok,
    status,
    json: async () => data,
  } as unknown as Response;
}

function supabaseBuilder() {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({
      data: { encrypted_access_token: 'enc-token' },
      error: null,
    }),
  };
  return builder;
}

vi.mock('@/lib/auth/clients', () => ({
  getSupabaseAdminClient: () => ({ from: () => supabaseBuilder() }),
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

  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    if (url.includes('/me/accounts')) {
      return graphResponse(true, 200, { data: graphPages });
    }
    if (url.includes('/me/permissions')) {
      return graphResponse(true, 200, { data: [] });
    }
    if (url.includes('/comments')) {
      if (commentShouldFail) {
        return graphResponse(false, 400, {
          error: { message: 'Comment failed', code: 1 },
        });
      }
      return graphResponse(true, 200, { id: 'comment-1' });
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
  });
});

const ACCOUNT_ID = '11111111-1111-4111-a111-111111111111';

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
      media: {
        source: 'library',
        mediaId: '22222222-2222-4222-a222-222222222222',
        tempKey: null,
        url: 'https://media.example.com/clip.mp4',
        mediaType: 'video',
        aspectRatio: null,
        width: null,
        height: null,
        name: 'clip.mp4',
      },
    });
    expect(longReel.status).toBe(400);
    expect(longReel.body.message).toBe(
      'Text exceeds the 2,200-character limit'
    );
  });
});
