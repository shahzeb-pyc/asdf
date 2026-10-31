import { describe, expect, it } from 'vitest';
import {
  type DatabaseDestinationRow,
  type DatabaseUnifiedQueueItemRow,
  type PublisherTokenSet,
} from '@fbuploadpro/contracts';
import { MockInstagramPublishClient } from '../src/instagram-client.js';
import { InstagramPublisher } from '../src/publishers/instagram.js';

/**
 * Instagram Schedule readiness: the exact queue rows the Schedule
 * composer creates (photo, reel, carousel — the only types the
 * composer offers, on a destination carrying the Schedule flag and
 * a Creator account type) must pass the worker Instagram
 * publisher's pre-flight and container flow with a stub client.
 * This proves the Schedule → worker handoff is well-formed; it is
 * NOT a real Instagram post.
 */

const TOKENS: PublisherTokenSet = { accessToken: 'ig-access-token' };
const NO_SLEEP = async () => {};

function makeItem(
  overrides: Partial<DatabaseUnifiedQueueItemRow>
): DatabaseUnifiedQueueItemRow {
  return {
    id: 'item-1',
    workspace_id: 'ws-1',
    destination_id: 'dest-1',
    platform: 'instagram',
    kind: 'image',
    platform_format: null,
    caption: 'Hello from Schedule',
    title: null,
    first_comment: 'First!',
    media_item_id: null,
    media_url: 'https://media.example.com/images/photo-1.jpg',
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

function makeDestination(): DatabaseDestinationRow {
  return {
    id: 'dest-1',
    workspace_id: 'ws-1',
    account_id: 'acct-1',
    platform: 'instagram',
    external_destination_id: 'ig-user-123',
    name: 'Sunset Bakery',
    handle: 'sunset.bakery',
    avatar_url: null,
    timezone: 'Asia/Karachi',
    status: 'active',
    encrypted_destination_token: null,
    next_allowed_publish_at: null,
    rate_usage_pct: 0,
    metadata: { scheduled: true, account_type: 'CREATOR' },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe('instagram schedule rows through the worker publisher', () => {
  it('publishes a schedule photo row with its first comment', async () => {
    const mock = new MockInstagramPublishClient();
    const publisher = new InstagramPublisher(mock, {
      pollIntervalMs: 0,
      sleep: NO_SLEEP,
    });
    const outcome = await publisher.publish(
      makeItem({}),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe('mock_media_1');
    expect(mock.commentsPosted).toHaveLength(1);
    expect(mock.commentsPosted[0]?.message).toBe('First!');
  });

  it('publishes a schedule reel row (video kind, reel format)', async () => {
    const mock = new MockInstagramPublishClient();
    const publisher = new InstagramPublisher(mock, {
      pollIntervalMs: 0,
      sleep: NO_SLEEP,
    });
    const outcome = await publisher.publish(
      makeItem({
        kind: 'video',
        platform_format: 'reel',
        media_url: 'https://media.example.com/videos/clip-1.mp4',
        first_comment: null,
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(
      mock.containersCreated.some((c) => c.mediaType === 'REELS')
    ).toBe(true);
  });

  it('publishes a schedule carousel row from its platform options', async () => {
    const mock = new MockInstagramPublishClient();
    const publisher = new InstagramPublisher(mock, {
      pollIntervalMs: 0,
      sleep: NO_SLEEP,
    });
    const outcome = await publisher.publish(
      makeItem({
        kind: 'carousel',
        platform_format: null,
        media_url: 'https://media.example.com/images/photo-1.jpg',
        platform_options: {
          carouselItems: [
            {
              mediaUrl: 'https://media.example.com/images/photo-1.jpg',
              mediaType: 'image',
            },
            {
              mediaUrl: 'https://media.example.com/images/photo-2.jpg',
              mediaType: 'image',
            },
          ],
        },
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(
      mock.containersCreated.some((c) => c.mediaType === 'CAROUSEL')
    ).toBe(true);
  });

  it('fails a story row for a Creator destination instead of publishing it', async () => {
    const mock = new MockInstagramPublishClient();
    const publisher = new InstagramPublisher(mock, {
      pollIntervalMs: 0,
      sleep: NO_SLEEP,
    });
    const outcome = await publisher.publish(
      makeItem({
        kind: 'story',
        platform_format: 'story',
        media_url: 'https://media.example.com/images/photo-1.jpg',
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('story_requires_business_account');
    expect(mock.containersCreated).toHaveLength(0);
  });
});
