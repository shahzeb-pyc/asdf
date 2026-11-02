import { describe, expect, it } from 'vitest';
import {
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type PublisherTokenSet,
} from '@fbuploadpro/contracts';
import {
  InstagramGraphError,
  MockInstagramPublishClient,
} from '../src/instagram-client.js';
import { InstagramPublisher } from '../src/publishers/instagram.js';
import { createWorkerPublisherRegistry } from '../src/registry.js';

const IG_ID = 'ig-user-123';
const TOKENS: PublisherTokenSet = { accessToken: 'ig-access-token' };
const IMAGE_URL = 'https://media.example.com/images/photo-1.jpg';
const VIDEO_URL = 'https://media.example.com/videos/clip-1.mp4';
const NO_SLEEP = async () => {};

function makeItem(
  overrides: Partial<DatabaseUnifiedQueueItemRow> = {}
): DatabaseUnifiedQueueItemRow {
  return {
    id: 'item-1',
    workspace_id: 'ws-1',
    destination_id: 'dest-1',
    platform: 'instagram',
    kind: 'image',
    platform_format: 'image',
    caption: 'Hello from Instagram',
    title: null,
    first_comment: null,
    media_item_id: null,
    media_url: IMAGE_URL,
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
    platform: 'instagram',
    external_destination_id: IG_ID,
    name: 'Test IG',
    handle: 'testig',
    avatar_url: null,
    timezone: 'UTC',
    status: 'active',
    encrypted_destination_token: null,
    rate_usage_pct: 0,
    metadata: { account_type: 'BUSINESS' },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeAccount(): DatabaseSocialAccountRow {
  return {
    id: 'acct-1',
    workspace_id: 'ws-1',
    platform: 'instagram',
    external_account_id: IG_ID,
    display_name: 'Test IG',
    avatar_url: null,
    encrypted_access_token: 'encrypted',
    encrypted_refresh_token: null,
    token_expires_at: null,
    scopes: null,
    status: 'active',
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function publisherWith(mock: MockInstagramPublishClient): InstagramPublisher {
  return new InstagramPublisher(mock, { pollIntervalMs: 0, sleep: NO_SLEEP });
}

describe('InstagramPublisher (spec 124)', () => {
  it('registers under platform instagram in the worker registry', () => {
    const registry = createWorkerPublisherRegistry();
    expect(registry.has('instagram')).toBe(true);
    expect(registry.get('instagram')).toBeInstanceOf(InstagramPublisher);
  });

  it('photo: container → FINISHED → publish, container id in detail from the first attempt', async () => {
    const mock = new MockInstagramPublishClient();
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe('mock_media_1');
    expect(outcome.detail).toMatchObject({ containerId: 'mock_container_1' });
    expect(mock.containersCreated).toHaveLength(1);
    expect(mock.containersCreated[0].imageUrl).toBe(IMAGE_URL);
    expect(mock.containersCreated[0].caption).toBe('Hello from Instagram');
    expect(mock.containersPublished).toEqual([
      { igUserId: IG_ID, containerId: 'mock_container_1' },
    ]);
  });

  it('polls status_code until FINISHED before publishing (IN_PROGRESS first)', async () => {
    const mock = new MockInstagramPublishClient();
    mock.statusSequence = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(mock.statusChecks).toHaveLength(3);
    expect(mock.containersPublished).toHaveLength(1);
  });

  it('reel: a video item creates a REELS container with share_to_feed from options', async () => {
    const mock = new MockInstagramPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({
        kind: 'video',
        platform_format: 'reel',
        media_url: VIDEO_URL,
        platform_options: { shareToFeed: true },
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.containersCreated[0].mediaType).toBe('REELS');
    expect(mock.containersCreated[0].videoUrl).toBe(VIDEO_URL);
    expect(mock.containersCreated[0].shareToFeed).toBe(true);
  });

  it('carousel: child containers then a CAROUSEL parent, published once', async () => {
    const mock = new MockInstagramPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({
        kind: 'carousel',
        platform_format: 'carousel',
        media_url: null,
        platform_options: {
          carouselItems: [
            { mediaUrl: IMAGE_URL, mediaType: 'image' },
            { mediaUrl: VIDEO_URL, mediaType: 'video' },
            { mediaUrl: IMAGE_URL, mediaType: 'image' },
          ],
        },
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    // 3 children + 1 parent.
    expect(mock.containersCreated).toHaveLength(4);
    const parent = mock.containersCreated[3];
    expect(parent.mediaType).toBe('CAROUSEL');
    expect(parent.children).toHaveLength(3);
    expect(mock.containersCreated.slice(0, 3).every((c) => c.isCarouselItem)).toBe(true);
    expect(mock.containersPublished).toHaveLength(1);
    expect(outcome.detail).toMatchObject({ containerId: expect.any(String) });
  });

  it('Business story: publishes a STORIES container', async () => {
    const mock = new MockInstagramPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({ kind: 'story', platform_format: 'story', caption: '' }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.containersCreated[0].mediaType).toBe('STORIES');
  });

  it('Creator story: permanent plain-language failure, no container created', async () => {
    const mock = new MockInstagramPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({ kind: 'story', platform_format: 'story', caption: '' }),
      makeDestination({ metadata: { account_type: 'CREATOR' } }),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('permanent');
    expect(outcome.error?.code).toBe('story_requires_business_account');
    expect(outcome.error?.message).toContain('Business accounts');
    expect(outcome.error?.message).toContain('Creator account');
    expect(mock.containersCreated).toHaveLength(0);
  });

  it('media_publish timeout: re-checks container status and never double-posts', async () => {
    const mock = new MockInstagramPublishClient();
    mock.publishErrorToThrow = new Error('request timed out');
    // The publish actually landed before the timeout: the status
    // re-check reads PUBLISHED, so no second publish is attempted.
    let publishAttempts = 0;
    const originalPublish = mock.publishContainer.bind(mock);
    mock.publishContainer = async (params) => {
      publishAttempts += 1;
      mock.statusByContainer.set(params.containerId, 'PUBLISHED');
      return originalPublish(params);
    };
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(outcome.detail).toMatchObject({ containerId: 'mock_container_1' });
    expect(publishAttempts).toBe(1);
  });

  it('media_publish failure with container not published settles via classification (retryable, detail kept)', async () => {
    const mock = new MockInstagramPublishClient();
    mock.publishErrorToThrow = new InstagramGraphError('temporarily unavailable', {
      code: 2,
    }, 503);
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('retry');
    expect(outcome.detail).toMatchObject({ containerId: 'mock_container_1' });
  });

  it('container already PUBLISHED at poll time settles published without a publish call', async () => {
    const mock = new MockInstagramPublishClient();
    mock.statusSequence = ['PUBLISHED'];
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(mock.containersPublished).toHaveLength(0);
  });

  it('first comment: posted after publish and settled with the comment id', async () => {
    const mock = new MockInstagramPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({ first_comment: 'First!' }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(outcome.externalCommentId).toBe('mock_comment_1');
    expect(outcome.commentWarning).toBeUndefined();
    expect(mock.commentsPosted).toEqual([{ mediaId: 'mock_media_1', message: 'First!' }]);
  });

  it('first comment failure: post still settles published with a comment warning', async () => {
    const mock = new MockInstagramPublishClient();
    mock.throwOn = 'comment';
    mock.errorToThrow = new Error('comment boom');
    const outcome = await publisherWith(mock).publish(
      makeItem({ first_comment: 'First!' }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe('mock_media_1');
    expect(outcome.externalCommentId).toBeUndefined();
    expect(outcome.commentWarning).toContain('comment boom');
  });

  it('live quota: reads content_publishing_limit and records it in detail (no hardcoded value)', async () => {
    const mock = new MockInstagramPublishClient();
    mock.limitToReturn = { usage: 7, totalCount: 42, raw: {} };
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(mock.limitReads).toBe(1);
    expect(outcome.detail).toMatchObject({
      publishingLimit: { usage: 7, totalCount: 42 },
    });
  });

  it('live quota read failure never blocks the publish', async () => {
    const mock = new MockInstagramPublishClient();
    mock.throwOn = 'limit';
    mock.errorToThrow = new Error('limit endpoint down');
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
  });

  it('error 190 anywhere classifies as auth and cascades the account to expired', async () => {
    const mock = new MockInstagramPublishClient();
    mock.throwOn = 'create';
    mock.errorToThrow = new InstagramGraphError('Invalid OAuth access token', {
      code: 190,
      error_subcode: 463,
    });
    const publisher = publisherWith(mock);
    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('auth');
    expect(outcome.error?.code).toBe('190');
    expect(outcome.targetAccountStatus).toBe('expired');
    expect(outcome.error?.message).toContain('Reconnect');
    expect(publisher.mapError(mock.errorToThrow).kind).toBe('auth');
  });

  it('publish() never refreshes tokens (D6) — refreshCalls stays zero across formats', async () => {
    const mock = new MockInstagramPublishClient();
    const publisher = publisherWith(mock);
    await publisher.publish(makeItem(), makeDestination(), TOKENS);
    await publisher.publish(
      makeItem({ kind: 'video', platform_format: 'reel', media_url: VIDEO_URL }),
      makeDestination(),
      TOKENS
    );
    expect(mock.refreshCalls).toBe(0);
  });

  it('refreshTokens (refresh job only) exchanges via the client and computes the new expiry', async () => {
    const mock = new MockInstagramPublishClient();
    const publisher = publisherWith(mock);
    const refreshed = await publisher.refreshTokens(makeAccount(), TOKENS);
    expect(mock.refreshCalls).toBe(1);
    expect(refreshed.accessToken).toBe('ig-access-token-refreshed');
    expect(refreshed.tokenExpiresAt).toBeTruthy();
  });

  it('caption over the limits fails permanently before any container is created', async () => {
    const mock = new MockInstagramPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({ caption: Array(31).fill('#tag').join(' ') }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('permanent');
    expect(mock.containersCreated).toHaveLength(0);
  });

  it('missing media URL fails PERMANENTLY as a validation error, without a container', async () => {
    const mock = new MockInstagramPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({ media_url: null }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('permanent');
    expect(outcome.error?.code).toBe('validation');
    expect(mock.containersCreated).toHaveLength(0);
  });

  it('live quota at the cap defers (publishing_limit_reached) and creates no container', async () => {
    const mock = new MockInstagramPublishClient();
    mock.limitToReturn = { usage: 50, totalCount: 50, raw: {} };
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('deferred');
    expect(outcome.error?.kind).toBe('retryable');
    expect(outcome.error?.code).toBe('publishing_limit_reached');
    expect(outcome.retryDelaySeconds).toBe(3600);
    expect(outcome.detail).toMatchObject({
      publishingLimit: { usage: 50, totalCount: 50 },
    });
    expect(mock.containersCreated).toHaveLength(0);
  });
});
