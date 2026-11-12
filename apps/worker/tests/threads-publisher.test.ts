import { describe, expect, it } from 'vitest';
import {
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type PublisherTokenSet,
} from '@fbuploadpro/contracts';
import {
  MockThreadsPublishClient,
  ThreadsGraphError,
} from '../src/threads-client.js';
import { ThreadsPublisher } from '../src/publishers/threads.js';
import { createWorkerPublisherRegistry } from '../src/registry.js';

const THREADS_ID = 'threads-user-123';
const TOKENS: PublisherTokenSet = { accessToken: 'threads-access-token' };
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
    platform: 'threads',
    kind: 'text',
    platform_format: 'text',
    caption: 'Hello from Threads',
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
    platform: 'threads',
    external_destination_id: THREADS_ID,
    section: 'schedule',
    name: 'Test Threads',
    handle: 'testthreads',
    avatar_url: null,
    timezone: 'UTC',
    status: 'active',
    encrypted_destination_token: null,
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
    platform: 'threads',
    external_account_id: THREADS_ID,
    display_name: 'Test Threads',
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

function publisherWith(mock: MockThreadsPublishClient): ThreadsPublisher {
  return new ThreadsPublisher(mock, { pollIntervalMs: 0, sleep: NO_SLEEP });
}

describe('ThreadsPublisher (spec 124)', () => {
  it('registers under platform threads in the worker registry', () => {
    const registry = createWorkerPublisherRegistry();
    expect(registry.has('threads')).toBe(true);
    expect(registry.get('threads')).toBeInstanceOf(ThreadsPublisher);
  });

  it('text: container → FINISHED → publish, returned media id stored as externalPostId', async () => {
    const mock = new MockThreadsPublishClient();
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe('mock_media_1');
    expect(outcome.detail).toMatchObject({ containerId: 'mock_container_1' });
    expect(mock.containersCreated[0].mediaType).toBe('TEXT');
    expect(mock.containersCreated[0].text).toBe('Hello from Threads');
    expect(mock.containersPublished).toEqual([
      { threadsUserId: THREADS_ID, containerId: 'mock_container_1' },
    ]);
  });

  it('publishes only on FINISHED — IN_PROGRESS polls do not publish early', async () => {
    const mock = new MockThreadsPublishClient();
    mock.statusSequence = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(mock.statusChecks).toHaveLength(3);
    expect(mock.containersPublished).toHaveLength(1);
  });

  it('tolerates initial 404s while the container propagates', async () => {
    const mock = new MockThreadsPublishClient();
    mock.notFoundBeforeStatus = 2;
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(mock.containersPublished).toHaveLength(1);
  });

  it('image: IMAGE container with the public media URL and alt text', async () => {
    const mock = new MockThreadsPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({
        kind: 'image',
        platform_format: 'image',
        media_url: IMAGE_URL,
        platform_options: { altText: 'A photo' },
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.containersCreated[0].mediaType).toBe('IMAGE');
    expect(mock.containersCreated[0].imageUrl).toBe(IMAGE_URL);
    expect(mock.containersCreated[0].altText).toBe('A photo');
  });

  it('video: VIDEO container with the public media URL', async () => {
    const mock = new MockThreadsPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({ kind: 'video', platform_format: 'video', media_url: VIDEO_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.containersCreated[0].mediaType).toBe('VIDEO');
    expect(mock.containersCreated[0].videoUrl).toBe(VIDEO_URL);
  });

  it('carousel: 2–20 child containers then the CAROUSEL parent, published once', async () => {
    const mock = new MockThreadsPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({
        kind: 'carousel',
        platform_format: 'carousel',
        platform_options: {
          carouselItems: [
            { mediaUrl: IMAGE_URL, mediaType: 'image' },
            { mediaUrl: VIDEO_URL, mediaType: 'video' },
          ],
        },
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.containersCreated).toHaveLength(3);
    expect(mock.containersCreated[2].mediaType).toBe('CAROUSEL');
    expect(mock.containersCreated[2].children).toHaveLength(2);
    expect(mock.containersPublished).toHaveLength(1);
  });

  it('quote post: quote_post_id rides on the container', async () => {
    const mock = new MockThreadsPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({ platform_options: { quotePostId: 'post-to-quote' } }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.containersCreated[0].quotePostId).toBe('post-to-quote');
  });

  it('reply: reply_to_id rides on the container', async () => {
    const mock = new MockThreadsPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({ platform_options: { replyToId: 'post-to-reply' } }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.containersCreated[0].replyToId).toBe('post-to-reply');
  });

  it('reply chain: follow-ups publish in order, each replying to the previous media id', async () => {
    const mock = new MockThreadsPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({
        platform_options: {
          replyChain: [{ text: 'Part two' }, { text: 'Part three' }],
        },
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe('mock_media_1');
    expect(mock.containersCreated).toHaveLength(3);
    expect(mock.containersCreated[1].replyToId).toBe('mock_media_1');
    expect(mock.containersCreated[1].text).toBe('Part two');
    expect(mock.containersCreated[2].text).toBe('Part three');
    expect(outcome.detail).toMatchObject({
      replyChainMediaIds: ['mock_media_1', 'mock_media_1'],
    });
  });

  it('text attachment: passes text_attachment through on the container (poll-publish still the path)', async () => {
    const mock = new MockThreadsPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({
        caption: 'Short lead',
        platform_options: { textAttachment: 'The long version of this post.' },
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.containersCreated[0].textAttachment).toBe('The long version of this post.');
  });

  it('code 24 / subcode 4279009 on publish: re-reads status (FINISHED) and publishes once more, never blindly', async () => {
    const mock = new MockThreadsPublishClient();
    let publishCalls = 0;
    const originalPublish = mock.publishContainer.bind(mock);
    mock.publishContainer = async (params) => {
      publishCalls += 1;
      if (publishCalls === 1) {
        throw new ThreadsGraphError('media cannot be found', {
          code: 24,
          error_subcode: 4279009,
        });
      }
      return originalPublish(params);
    };
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe('mock_media_1');
    // One failed attempt + one status-verified republish.
    expect(publishCalls).toBe(2);
    // The status was re-read between the two publish calls.
    expect(mock.statusChecks.length).toBeGreaterThanOrEqual(2);
  });

  it('code 24 with container already PUBLISHED settles published with no second publish', async () => {
    const mock = new MockThreadsPublishClient();
    let publishCalls = 0;
    mock.publishContainer = async (params) => {
      publishCalls += 1;
      mock.statusByContainer.set(params.containerId, 'PUBLISHED');
      throw new ThreadsGraphError('media cannot be found', {
        code: 24,
        error_subcode: 4279009,
      });
    };
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(publishCalls).toBe(1);
  });

  it('container ERROR settles failed permanently with the container id in detail', async () => {
    const mock = new MockThreadsPublishClient();
    mock.statusSequence = ['ERROR'];
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('permanent');
    expect(outcome.detail).toMatchObject({ containerId: 'mock_container_1' });
    expect(mock.containersPublished).toHaveLength(0);
  });

  it('text over the 500 weighted cap fails permanently before any container (emoji weigh more)', async () => {
    const mock = new MockThreadsPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({ caption: '🎉'.repeat(126) }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('permanent');
    expect(mock.containersCreated).toHaveLength(0);
  });

  it('error 190 classifies as auth and cascades the account to expired', async () => {
    const mock = new MockThreadsPublishClient();
    mock.throwOn = 'create';
    mock.errorToThrow = new ThreadsGraphError('Invalid OAuth access token', {
      code: 190,
    });
    const publisher = publisherWith(mock);
    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('auth');
    expect(outcome.targetAccountStatus).toBe('expired');
    expect(publisher.mapError(mock.errorToThrow).kind).toBe('auth');
  });

  it('publish() never refreshes tokens (D6); refreshTokens serves the refresh job only', async () => {
    const mock = new MockThreadsPublishClient();
    const publisher = publisherWith(mock);
    await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(mock.refreshCalls).toBe(0);
    const refreshed = await publisher.refreshTokens(makeAccount(), TOKENS);
    expect(mock.refreshCalls).toBe(1);
    expect(refreshed.accessToken).toBe('threads-access-token-refreshed');
  });

  it('missing media URL: publish() RESOLVES with a permanent validation failure (never throws, no container)', async () => {
    const mock = new MockThreadsPublishClient();
    const outcome = await publisherWith(mock).publish(
      makeItem({ kind: 'image', platform_format: 'image', media_url: null }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('permanent');
    expect(outcome.error?.code).toBe('validation');
    // Failure outcomes record the resolved live quota too (mirrors IG).
    expect(outcome.detail).toMatchObject({
      publishingLimit: { usage: 10, totalCount: 250 },
    });
    expect(mock.containersCreated).toHaveLength(0);
  });

  it('live quota at the cap defers (publishing_limit_reached) and creates no container', async () => {
    const mock = new MockThreadsPublishClient();
    mock.limitToReturn = { usage: 250, totalCount: 250, raw: {} };
    const outcome = await publisherWith(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('deferred');
    expect(outcome.error?.kind).toBe('retryable');
    expect(outcome.error?.code).toBe('publishing_limit_reached');
    expect(outcome.retryDelaySeconds).toBe(3600);
    expect(outcome.detail).toMatchObject({
      publishingLimit: { usage: 250, totalCount: 250 },
    });
    expect(mock.containersCreated).toHaveLength(0);
  });
});
