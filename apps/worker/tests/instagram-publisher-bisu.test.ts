import { describe, expect, it } from 'vitest';
import type {
  DatabaseDestinationRow,
  DatabaseSocialAccountRow,
  DatabaseUnifiedQueueItemRow,
  PublisherTokenSet,
} from '@fbuploadpro/contracts';
import { MockInstagramPublishClient } from '../src/instagram-client.js';
import {
  InstagramPublisher,
  isBisuDestination,
} from '../src/publishers/instagram.js';

const NO_SLEEP = async () => {};
const TOKENS: PublisherTokenSet = { accessToken: 'bisu-token' };
const IMAGE_URL = 'https://media.example.com/images/photo-1.jpg';

function makeItem(): DatabaseUnifiedQueueItemRow {
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
  };
}

function makeDestination(metadata: Record<string, unknown>): DatabaseDestinationRow {
  return {
    id: 'dest-1',
    workspace_id: 'ws-1',
    account_id: 'acct-1',
    platform: 'instagram',
    external_destination_id: 'ig-user-123',
    name: 'Test IG',
    handle: 'testig',
    avatar_url: null,
    timezone: 'UTC',
    status: 'active',
    encrypted_destination_token: null,
    rate_usage_pct: 0,
    metadata: metadata as never,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeAccount(metadata: Record<string, unknown>): DatabaseSocialAccountRow {
  return {
    id: 'acct-1',
    workspace_id: 'ws-1',
    platform: 'instagram',
    external_account_id: 'ig-user-123',
    display_name: 'Test IG',
    avatar_url: null,
    encrypted_access_token: 'enc',
    encrypted_refresh_token: null,
    token_expires_at: null,
    scopes: null,
    status: 'active',
    metadata: metadata as never,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe('InstagramPublisher BISU destinations (Unified Login)', () => {
  it('routes a BISU destination to the BISU client and never to the legacy client', async () => {
    const legacy = new MockInstagramPublishClient();
    const bisu = new MockInstagramPublishClient();
    const publisher = new InstagramPublisher(legacy, {
      pollIntervalMs: 0,
      sleep: NO_SLEEP,
      bisuClient: bisu,
    });
    const destination = makeDestination({ token_kind: 'bisu' });
    expect(isBisuDestination(destination)).toBe(true);
    const outcome = await publisher.publish(makeItem(), destination, TOKENS);
    expect(outcome.status).toBe('published');
    expect(bisu.containersCreated.length).toBeGreaterThan(0);
    expect(legacy.containersCreated).toEqual([]);
  });

  it('keeps a non-BISU destination on the legacy client', async () => {
    const legacy = new MockInstagramPublishClient();
    const bisu = new MockInstagramPublishClient();
    const publisher = new InstagramPublisher(legacy, {
      pollIntervalMs: 0,
      sleep: NO_SLEEP,
      bisuClient: bisu,
    });
    const destination = makeDestination({ account_type: 'BUSINESS' });
    expect(isBisuDestination(destination)).toBe(false);
    const outcome = await publisher.publish(makeItem(), destination, TOKENS);
    expect(outcome.status).toBe('published');
    expect(legacy.containersCreated.length).toBeGreaterThan(0);
    expect(bisu.containersCreated).toEqual([]);
  });

  it('refreshTokens returns a BISU account tokens unchanged without calling the client', async () => {
    const legacy = new MockInstagramPublishClient();
    const publisher = new InstagramPublisher(legacy, {
      pollIntervalMs: 0,
      sleep: NO_SLEEP,
    });
    const refreshed = await publisher.refreshTokens(
      makeAccount({ token_kind: 'bisu' }),
      TOKENS
    );
    expect(refreshed.accessToken).toBe('bisu-token');
    expect(legacy.refreshCalls).toBe(0);
  });
});
