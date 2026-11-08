import { describe, expect, it } from 'vitest';
import {
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type IFacebookPublishClient,
  type PublisherTokenSet,
} from '@fbuploadpro/contracts';
import { FacebookGraphError } from '../src/fb-client.js';
import { MockFacebookPublishClient } from './mock-fb-client.js';
import { FacebookPublisher } from '../src/publishers/facebook.js';
import { createWorkerPublisherRegistry } from '../src/registry.js';

// ==========================================
// Fixtures
// ==========================================

const PAGE_ID = 'page-123';
const PAGE_TOKEN = 'plain-page-token';

function makeItem(
  overrides: Partial<DatabaseUnifiedQueueItemRow> = {}
): DatabaseUnifiedQueueItemRow {
  return {
    id: 'item-1',
    workspace_id: 'ws-1',
    destination_id: 'dest-1',
    platform: 'facebook',
    kind: 'text',
    platform_format: 'text',
    caption: 'Hello from the boss',
    title: null,
    first_comment: null,
    media_item_id: null,
    media_url: null,
    media_storage_key: null,
    link_url: null,
    platform_options: {},
    scheduled_time: new Date().toISOString(),
    slot_id: null,
    status: 'publishing',
    claimed_at: new Date().toISOString(),
    retry_count: 0,
    max_retries: 3,
    error_code: null,
    error_subcode: null,
    error_message: null,
    external_post_id: null,
    external_comment_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDestination(
  overrides: Partial<DatabaseDestinationRow> = {}
): DatabaseDestinationRow {
  return {
    id: 'dest-1',
    workspace_id: 'ws-1',
    account_id: 'acct-1',
    platform: 'facebook',
    external_destination_id: PAGE_ID,
    name: 'Test Page',
    handle: null,
    avatar_url: null,
    timezone: 'UTC',
    status: 'active',
    encrypted_destination_token: 'encrypted-page-token',
    rate_usage_pct: 0,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeAccount(): DatabaseSocialAccountRow {
  return {
    id: 'acct-1',
    workspace_id: 'ws-1',
    platform: 'facebook',
    external_account_id: 'user-123',
    display_name: 'User',
    avatar_url: null,
    encrypted_access_token: 'encrypted-user-token',
    encrypted_refresh_token: null,
    token_expires_at: null,
    scopes: null,
    status: 'active',
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

const TOKENS: PublisherTokenSet = {
  accessToken: 'plain-user-token',
  destinationToken: PAGE_TOKEN,
};

const IMAGE_URL = 'https://media.example.com/images/photo-1.jpg';
const VIDEO_URL = 'https://media.example.com/videos/clip-1.mp4';

// ==========================================
// Per-format publish parity
// ==========================================

describe('FacebookPublisher — per-format dispatch (parity with the old dispatcher)', () => {
  it('registers under platform facebook in the worker registry', () => {
    const registry = createWorkerPublisherRegistry();
    expect(registry.has('facebook')).toBe(true);
    expect(registry.get('facebook')).toBeInstanceOf(FacebookPublisher);
  });

  it('text: publishes via publishTextPost with caption as message and the link URL', async () => {
    const mock = new MockFacebookPublishClient();
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({ kind: 'text', platform_format: 'text', link_url: 'https://example.com/post' }),
      makeDestination(),
      TOKENS
    );
    expect(outcome).toEqual({ status: 'published', externalPostId: 'mock_post_123' });
    expect(mock.textPostsPublished).toEqual([
      { pageId: PAGE_ID, message: 'Hello from the boss', linkUrl: 'https://example.com/post' },
    ]);
  });

  it('image: publishes via publishPhoto with the media URL and caption, using the Page token', async () => {
    const mock = new MockFacebookPublishClient();
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({ kind: 'image', platform_format: 'image', media_url: IMAGE_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.photosPublished).toEqual([
      { pageId: PAGE_ID, accessToken: PAGE_TOKEN, imageUrl: IMAGE_URL, caption: 'Hello from the boss' },
    ]);
  });

  it('reel: a kind video / platform_format reel item publishes via the 3-phase publishReel', async () => {
    const mock = new MockFacebookPublishClient();
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({ kind: 'video', platform_format: 'reel', media_url: VIDEO_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.reelsPublished).toEqual([
      {
        pageId: PAGE_ID,
        accessToken: PAGE_TOKEN,
        videoUrl: VIDEO_URL,
        caption: 'Hello from the boss',
        itemId: 'item-1',
      },
    ]);
    expect(mock.videosPublished).toHaveLength(0);
  });

  it('video: publishes via publishVideo', async () => {
    const mock = new MockFacebookPublishClient();
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({ kind: 'video', platform_format: 'video', media_url: VIDEO_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.videosPublished).toHaveLength(1);
    expect(mock.reelsPublished).toHaveLength(0);
  });

  it('video: falls back to publishReel when the client has no publishVideo (old dispatcher rule)', async () => {
    const reels: unknown[] = [];
    const client: IFacebookPublishClient = {
      publishReel: async (params) => {
        reels.push(params);
        return { postId: 'reel-fallback-post' };
      },
      publishPhoto: async () => ({ postId: 'unused' }),
      postComment: async () => ({ commentId: 'unused' }),
      // publishVideo intentionally absent
    };
    const publisher = new FacebookPublisher(client);
    const outcome = await publisher.publish(
      makeItem({ kind: 'video', platform_format: 'video', media_url: VIDEO_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome).toEqual({ status: 'published', externalPostId: 'reel-fallback-post' });
    expect(reels).toHaveLength(1);
  });

  it('photo story: a story item with an image media URL publishes via publishPhotoStory', async () => {
    const mock = new MockFacebookPublishClient();
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({ kind: 'story', platform_format: 'story', media_url: IMAGE_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.photoStoriesPublished).toEqual([{ pageId: PAGE_ID, imageUrl: IMAGE_URL }]);
    expect(mock.videoStoriesPublished).toHaveLength(0);
  });

  it('video story: a story item with a video media URL publishes via publishVideoStory', async () => {
    const mock = new MockFacebookPublishClient();
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({ kind: 'story', platform_format: 'story', media_url: VIDEO_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.videoStoriesPublished).toEqual([{ pageId: PAGE_ID, videoUrl: VIDEO_URL }]);
    expect(mock.photoStoriesPublished).toHaveLength(0);
  });

  it('photo story: an explicit media_type in platform_options wins over the URL extension', async () => {
    const mock = new MockFacebookPublishClient();
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({
        kind: 'story',
        platform_format: 'story',
        media_url: VIDEO_URL,
        platform_options: { media_type: 'image' },
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.photoStoriesPublished).toHaveLength(1);
  });

  it('carousel: the old format set had no carousel path — same unsupported-format outcome (retryable validation)', async () => {
    const mock = new MockFacebookPublishClient();
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({ kind: 'carousel', platform_format: 'carousel', media_url: IMAGE_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('retry');
    expect(outcome.retryDelaySeconds).toBe(300);
    expect(outcome.error?.kind).toBe('retryable');
    expect(outcome.error?.message).toContain('Unsupported post format: carousel');
  });

  it('missing media URL for an image post follows the old validation path (retryable, 300s at retry 0)', async () => {
    const mock = new MockFacebookPublishClient();
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({ kind: 'image', platform_format: 'image', media_url: null }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('retry');
    expect(outcome.retryDelaySeconds).toBe(300);
    expect(outcome.error?.message).toContain('Media URL is required for image publishing');
    expect(mock.photosPublished).toHaveLength(0);
  });

  it('missing destination token is a direct failed outcome with no status side effects (old token path)', async () => {
    const mock = new MockFacebookPublishClient();
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(makeItem(), makeDestination(), {
      accessToken: 'plain-user-token',
      destinationToken: null,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('permanent');
    expect(outcome.error?.code).toBe('missing_destination_token');
    expect(outcome.targetDestinationStatus).toBeUndefined();
    expect(outcome.targetAccountStatus).toBeUndefined();
    expect(mock.textPostsPublished).toHaveLength(0);
  });

  it('refreshTokens returns the supplied tokens unchanged (refresh job never calls this for Facebook)', async () => {
    const publisher = new FacebookPublisher(new MockFacebookPublishClient());
    const refreshed = await publisher.refreshTokens(makeAccount(), TOKENS);
    expect(refreshed).toEqual({
      accessToken: 'plain-user-token',
      refreshToken: null,
      tokenExpiresAt: null,
    });
  });
});

// ==========================================
// First comment parity
// ==========================================

describe('FacebookPublisher — first comment (old flow: 3 attempts, warning settle, never a post failure)', () => {
  it('posts the trimmed first comment and settles published with the comment id', async () => {
    const mock = new MockFacebookPublishClient();
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({ first_comment: '  First!  ' }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(outcome.externalCommentId).toBe('mock_comment_456');
    expect(outcome.commentWarning).toBeUndefined();
    expect(mock.commentsPosted).toEqual([
      { postId: 'mock_post_123', accessToken: PAGE_TOKEN, message: 'First!' },
    ]);
  });

  it('retries the comment and succeeds on the third attempt with no warning', async () => {
    let attempts = 0;
    const client: IFacebookPublishClient = {
      publishReel: async () => ({ postId: 'p' }),
      publishPhoto: async () => ({ postId: 'p' }),
      publishTextPost: async () => ({ postId: 'post-9' }),
      postComment: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('flaky comment');
        return { commentId: 'comment-9' };
      },
    };
    const publisher = new FacebookPublisher(client);
    const outcome = await publisher.publish(
      makeItem({ first_comment: 'hello' }),
      makeDestination(),
      TOKENS
    );
    expect(attempts).toBe(3);
    expect(outcome.status).toBe('published');
    expect(outcome.externalCommentId).toBe('comment-9');
    expect(outcome.commentWarning).toBeUndefined();
  });

  it('after 3 failed attempts the post still settles published, with a comment warning and no comment id', async () => {
    let attempts = 0;
    const client: IFacebookPublishClient = {
      publishReel: async () => ({ postId: 'p' }),
      publishPhoto: async () => ({ postId: 'p' }),
      publishTextPost: async () => ({ postId: 'post-9' }),
      postComment: async () => {
        attempts += 1;
        throw new Error('comment boom');
      },
    };
    const publisher = new FacebookPublisher(client);
    const outcome = await publisher.publish(
      makeItem({ first_comment: 'hello' }),
      makeDestination(),
      TOKENS
    );
    expect(attempts).toBe(3);
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe('post-9');
    expect(outcome.externalCommentId).toBeUndefined();
    expect(outcome.commentWarning).toBe(
      'Published post but first comment failed: comment boom'
    );
  });

  it('never attempts a first comment on a story', async () => {
    const mock = new MockFacebookPublishClient();
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({
        kind: 'story',
        platform_format: 'story',
        media_url: IMAGE_URL,
        first_comment: 'should not be posted',
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.commentsPosted).toHaveLength(0);
  });
});

// ==========================================
// Telemetry / BUC pacing parity
// ==========================================

describe('FacebookPublisher — telemetry metering, no pacing (20261102160000)', () => {
  it('reports BUC usage as rateUsagePct with no cooldown at >= 85%', async () => {
    const mock = new MockFacebookPublishClient();
    mock.telemetryToReturn = { bucUsageMaxPct: 90, estimatedTimeToRegainAccessMinutes: 12 };
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({ kind: 'image', platform_format: 'image', media_url: IMAGE_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(outcome.rateUsagePct).toBe(90);
    expect('destinationCooldownSeconds' in outcome).toBe(false);
  });

  it('reports BUC usage below 85% with no cooldown', async () => {
    const mock = new MockFacebookPublishClient();
    mock.telemetryToReturn = { bucUsageMaxPct: 50, estimatedTimeToRegainAccessMinutes: 12 };
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({ kind: 'image', platform_format: 'image', media_url: IMAGE_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.rateUsagePct).toBe(50);
    expect('destinationCooldownSeconds' in outcome).toBe(false);
  });

  it('reports BUC usage at 100% with no cooldown when no regain estimate is present', async () => {
    const mock = new MockFacebookPublishClient();
    mock.telemetryToReturn = { bucUsageMaxPct: 100 };
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({ kind: 'image', platform_format: 'image', media_url: IMAGE_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.rateUsagePct).toBe(100);
    expect('destinationCooldownSeconds' in outcome).toBe(false);
  });
});

// ==========================================
// Error-classification parity table
// ==========================================

interface ErrorCase {
  name: string;
  code: number;
  subcode?: number;
  retryCount?: number;
  kind: 'auth' | 'retryable' | 'permanent';
  status: 'retry' | 'failed';
  retryDelaySeconds?: number;
  targetDestinationStatus?: string;
  targetAccountStatus?: string;
  expectedMessage?: string;
}

const RAW_MESSAGE = 'fixture graph error';

const ERROR_CASES: ErrorCase[] = [
  // Auth — evaluation requiresReauth; account cascades to expired;
  // destination invalid_token -> error (new vocabulary).
  { name: '190 invalid token', code: 190, kind: 'auth', status: 'failed', targetDestinationStatus: 'error', targetAccountStatus: 'expired' },
  { name: '190/463 token expired', code: 190, subcode: 463, kind: 'auth', status: 'failed', targetDestinationStatus: 'error', targetAccountStatus: 'expired' },
  // Old dispatcher quirk, preserved: 190/492's evaluation keeps the
  // account active, but the dispatcher's `isAuth && code 190` rule
  // still cascaded it to expired.
  { name: '190/492 page role', code: 190, subcode: 492, kind: 'auth', status: 'failed', targetDestinationStatus: 'error', targetAccountStatus: 'expired' },
  { name: '102 session invalid', code: 102, kind: 'auth', status: 'failed', targetDestinationStatus: 'error', targetAccountStatus: 'expired' },
  { name: '10 permission denied', code: 10, kind: 'auth', status: 'failed', targetDestinationStatus: 'error', targetAccountStatus: 'expired' },
  { name: '250 (2xx) authorization denied', code: 250, kind: 'auth', status: 'failed', targetDestinationStatus: 'error', targetAccountStatus: 'expired' },
  // Permanent policy / client.
  {
    name: '368/4854002 checkpoint',
    code: 368,
    subcode: 4854002,
    kind: 'permanent',
    status: 'failed',
    targetDestinationStatus: 'error',
    expectedMessage:
      'Confirm your identity before you can publish as this Page. Please log in to Facebook on a mobile device, switch to this Page, confirm verification, and then manually turn the Page to active.',
  },
  {
    name: '368/1404082 already posted',
    code: 368,
    subcode: 1404082,
    kind: 'permanent',
    status: 'failed',
    expectedMessage:
      "You've already posted this. Posting the same content repeatedly is not allowed by Facebook.",
  },
  { name: '506 duplicate post', code: 506, kind: 'permanent', status: 'failed' },
  // Content codes 100 / 1609005 retry ×2, then fail (owner decision,
  // ADU statuses build): kind stays 'permanent', only the retry
  // disposition changes with the attempt count.
  { name: '1609005 bad link', code: 1609005, kind: 'permanent', status: 'retry', retryDelaySeconds: 300 },
  { name: '1609005 bad link at retry 2', code: 1609005, retryCount: 2, kind: 'permanent', status: 'failed' },
  { name: '100 invalid parameter', code: 100, kind: 'permanent', status: 'retry', retryDelaySeconds: 300 },
  { name: '100 invalid parameter at retry 2', code: 100, retryCount: 2, kind: 'permanent', status: 'failed' },
  { name: '400 bad request (4xx client)', code: 400, kind: 'permanent', status: 'failed' },
  // Transient rate limits — page stays active, no status flip, no
  // cooldown; retry delay 300s at retry_count 0.
  { name: '4 app rate limit', code: 4, kind: 'retryable', status: 'retry', retryDelaySeconds: 300 },
  { name: '17 user rate limit', code: 17, kind: 'retryable', status: 'retry', retryDelaySeconds: 300 },
  { name: '32 page rate limit', code: 32, kind: 'retryable', status: 'retry', retryDelaySeconds: 300 },
  { name: '341 app limit reached', code: 341, kind: 'retryable', status: 'retry', retryDelaySeconds: 300 },
  { name: '613 custom rate limit', code: 613, kind: 'retryable', status: 'retry', retryDelaySeconds: 300 },
  { name: '80001 BUC rate limit', code: 80001, kind: 'retryable', status: 'retry', retryDelaySeconds: 300 },
  // 368 non-policy: fb_rate_limited -> rate_limited; the 3-day anchor
  // is stamped by the settle RPC, never carried on the outcome.
  { name: '368 plain (rate limited)', code: 368, kind: 'retryable', status: 'retry', retryDelaySeconds: 300, targetDestinationStatus: 'rate_limited' },
  { name: '368/1390008 rate limited', code: 368, subcode: 1390008, kind: 'retryable', status: 'retry', retryDelaySeconds: 300, targetDestinationStatus: 'rate_limited' },
];

describe('FacebookPublisher — error-classification parity (publish outcomes)', () => {
  for (const c of ERROR_CASES) {
    it(`${c.name} -> ${c.kind}/${c.status}`, async () => {
      const mock = new MockFacebookPublishClient();
      mock.errorToThrow = new FacebookGraphError(RAW_MESSAGE, {
        message: RAW_MESSAGE,
        code: c.code,
        ...(c.subcode !== undefined ? { error_subcode: c.subcode } : {}),
      });
      const publisher = new FacebookPublisher(mock);
      const outcome = await publisher.publish(
        makeItem(c.retryCount !== undefined ? { retry_count: c.retryCount } : {}),
        makeDestination(),
        TOKENS,
      );

      expect(outcome.status).toBe(c.status);
      expect(outcome.error?.kind).toBe(c.kind);
      expect(outcome.error?.code).toBe(String(c.code));
      expect(outcome.error?.subcode).toBe(
        c.subcode !== undefined ? String(c.subcode) : undefined
      );
      expect(outcome.error?.message).toBe(c.expectedMessage ?? RAW_MESSAGE);
      expect(outcome.retryDelaySeconds).toBe(c.retryDelaySeconds);
      expect(outcome.targetDestinationStatus).toBe(c.targetDestinationStatus);
      expect(outcome.targetAccountStatus).toBe(c.targetAccountStatus);
      expect('destinationCooldownSeconds' in outcome).toBe(false);
    });
  }

  it('unknown error (no code) -> retryable fallback, code unknown, 300s at retry 0', async () => {
    const mock = new MockFacebookPublishClient();
    mock.errorToThrow = new Error('something unexpected exploded');
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('retry');
    expect(outcome.error).toEqual({
      kind: 'retryable',
      code: 'unknown',
      message: 'something unexpected exploded',
    });
    expect(outcome.retryDelaySeconds).toBe(300);
    expect(outcome.targetDestinationStatus).toBeUndefined();
    expect(outcome.targetAccountStatus).toBeUndefined();
  });

  it('retry delay formula: 300 * 2^retry_count capped at 3600 (old dispatcher)', async () => {
    const delays: Array<[number, number, number]> = [
      // [retry_count, max_retries, expected delay]
      [0, 5, 300],
      [1, 5, 600],
      [2, 5, 1200],
      [3, 5, 2400],
      [4, 5, 3600],
    ];
    for (const [retryCount, maxRetries, expected] of delays) {
      const mock = new MockFacebookPublishClient();
      mock.errorToThrow = new FacebookGraphError(RAW_MESSAGE, {
        message: RAW_MESSAGE,
        code: 4,
      });
      const publisher = new FacebookPublisher(mock);
      const outcome = await publisher.publish(
        makeItem({ retry_count: retryCount, max_retries: maxRetries }),
        makeDestination(),
        TOKENS
      );
      expect(outcome.status).toBe('retry');
      expect(outcome.retryDelaySeconds).toBe(expected);
    }
  });

  it('retry delay uses Graph telemetry regain minutes when present', async () => {
    const mock = new MockFacebookPublishClient();
    mock.errorToThrow = new FacebookGraphError(
      RAW_MESSAGE,
      { message: RAW_MESSAGE, code: 4 },
      { bucUsageMaxPct: 99, estimatedTimeToRegainAccessMinutes: 7 }
    );
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('retry');
    expect(outcome.retryDelaySeconds).toBe(420);
    expect('destinationCooldownSeconds' in outcome).toBe(false);
  });

  it('max retries exhausted: a transient error settles failed with no retry delay (old canRetry rule)', async () => {
    const mock = new MockFacebookPublishClient();
    mock.errorToThrow = new FacebookGraphError(RAW_MESSAGE, {
      message: RAW_MESSAGE,
      code: 4,
    });
    const publisher = new FacebookPublisher(mock);
    const outcome = await publisher.publish(
      makeItem({ retry_count: 3, max_retries: 3 }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('retryable');
    expect(outcome.retryDelaySeconds).toBeUndefined();
  });
});

describe('FacebookPublisher — mapError (pure, total)', () => {
  const publisher = new FacebookPublisher(new MockFacebookPublishClient());

  it('classifies the fixture set by kind/code/subcode', () => {
    const cases: Array<[unknown, string, string, string | undefined]> = [
      [new FacebookGraphError('m', { message: 'm', code: 190 }), 'auth', '190', undefined],
      [new FacebookGraphError('m', { message: 'm', code: 102, error_subcode: 460 }), 'auth', '102', '460'],
      [new FacebookGraphError('m', { message: 'm', code: 10 }), 'auth', '10', undefined],
      [new FacebookGraphError('m', { message: 'm', code: 299 }), 'auth', '299', undefined],
      [new FacebookGraphError('m', { message: 'm', code: 368, error_subcode: 4854002 }), 'permanent', '368', '4854002'],
      [new FacebookGraphError('m', { message: 'm', code: 368, error_subcode: 1404082 }), 'permanent', '368', '1404082'],
      [new FacebookGraphError('m', { message: 'm', code: 368 }), 'retryable', '368', undefined],
      [new FacebookGraphError('m', { message: 'm', code: 506 }), 'permanent', '506', undefined],
      [new FacebookGraphError('m', { message: 'm', code: 1609005 }), 'permanent', '1609005', undefined],
      [new FacebookGraphError('m', { message: 'm', code: 100 }), 'permanent', '100', undefined],
      [new FacebookGraphError('m', { message: 'm', code: 4 }), 'retryable', '4', undefined],
      [new FacebookGraphError('m', { message: 'm', code: 17 }), 'retryable', '17', undefined],
      [new FacebookGraphError('m', { message: 'm', code: 613 }), 'retryable', '613', undefined],
      [new FacebookGraphError('m', { message: 'm', code: 80001 }), 'retryable', '80001', undefined],
      [new Error('plain boom'), 'retryable', 'unknown', undefined],
      [{ code: 190 }, 'auth', '190', undefined],
    ];
    for (const [err, kind, code, subcode] of cases) {
      const classified = publisher.mapError(err);
      expect(classified.kind).toBe(kind);
      expect(classified.code).toBe(code);
      expect(classified.subcode).toBe(subcode);
    }
  });

  it('never throws for non-Error inputs', () => {
    for (const input of [null, undefined, 'a string failure', 42, { weird: true }]) {
      const classified = publisher.mapError(input);
      expect(classified.kind).toBe('retryable');
      expect(classified.code).toBe('unknown');
      expect(typeof classified.message).toBe('string');
    }
  });
});
