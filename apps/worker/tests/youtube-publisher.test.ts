import { describe, expect, it } from 'vitest';
import {
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type PublisherTokenSet,
} from '@fbuploadpro/contracts';
import { PostForMeError } from '../src/providers/post-for-me.js';
import type {
  CreatePostForMeYouTubePostInput,
  IPostForMeYouTubeClient,
  PostForMePostResult,
  PostForMeSocialPost,
} from '../src/providers/post-for-me-youtube.js';
import { YouTubePublisher } from '../src/publishers/youtube.js';
import { createWorkerPublisherRegistry } from '../src/registry.js';

// ==========================================
// Fixtures + mock provider (spec 125)
// ==========================================

const PROVIDER_ACCOUNT_ID = 'sa_yt_1';
const VIDEO_ID = 'ytVideo123';
const TITLE = 'Boss Reviews: The New Chair';

function makeItem(
  overrides: Partial<DatabaseUnifiedQueueItemRow> = {}
): DatabaseUnifiedQueueItemRow {
  return {
    id: 'item-1',
    workspace_id: 'ws-1',
    destination_id: 'dest-1',
    platform: 'youtube',
    kind: 'video',
    platform_format: 'video',
    caption: 'The boss reviews the new office chair.',
    title: TITLE,
    first_comment: null,
    media_item_id: 'media-1',
    media_url: 'https://media.example.com/videos/chair.mp4',
    media_storage_key: null,
    link_url: null,
    platform_options: { privacy: 'public', madeForKids: false },
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
    platform: 'youtube',
    external_destination_id: 'channel-123',
    section: 'schedule',
    name: 'Boss Channel',
    handle: '@bosschannel',
    avatar_url: null,
    timezone: 'UTC',
    status: 'active',
    encrypted_destination_token: null,
    rate_usage_pct: 0,
    metadata: { providerAccountId: PROVIDER_ACCOUNT_ID },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeAccount(): DatabaseSocialAccountRow {
  return {
    id: 'acct-1',
    workspace_id: 'ws-1',
    platform: 'youtube',
    external_account_id: 'channel-123',
    display_name: 'Boss Channel',
    avatar_url: null,
    encrypted_access_token: 'unused-provider-managed',
    encrypted_refresh_token: null,
    token_expires_at: null,
    scopes: null,
    status: 'active',
    metadata: { providerAccountId: PROVIDER_ACCOUNT_ID },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

const TOKENS: PublisherTokenSet = { accessToken: 'unused-provider-managed' };

interface SuccessfulResultOverrides {
  privacyStatus?: string;
  videoId?: string;
}

/**
 * A mock Post for Me YouTube client with a provider-side ledger:
 * `results` is what the provider reports, `createCalls` records every
 * submission attempt (the duplicate-safety assertions read it).
 */
class MockPostForMeYouTubeClient implements IPostForMeYouTubeClient {
  readonly createCalls: CreatePostForMeYouTubePostInput[] = [];
  results: PostForMePostResult[] = [];
  /** When set, createPost records the post in the ledger, then throws this. */
  createErrorAfterAccept: Error | null = null;
  createError: Error | null = null;
  private postSeq = 0;

  private successResult(
    postId: string,
    overrides: SuccessfulResultOverrides = {}
  ): PostForMePostResult {
    return {
      id: `result-${postId}`,
      post_id: postId,
      social_account_id: PROVIDER_ACCOUNT_ID,
      success: true,
      platform_data: {
        title: this.createCalls.at(-1)?.youtube.title ?? TITLE,
        platform_post_id: overrides.videoId ?? VIDEO_ID,
        privacy_status: overrides.privacyStatus ?? 'public',
      },
    };
  }

  /** Simulates the provider confirming the most recent post. */
  confirmLastPost(overrides: SuccessfulResultOverrides = {}): void {
    const postId = `post-${this.postSeq}`;
    this.results = [this.successResult(postId, overrides)];
  }

  async createAuthUrl(): Promise<{ url: string }> {
    return { url: 'https://provider.example/auth' };
  }

  async listSocialAccounts(): Promise<[]> {
    return [];
  }

  async getSocialAccount(): Promise<null> {
    return null;
  }

  async getPost(): Promise<null> {
    return null;
  }

  async createPost(
    input: CreatePostForMeYouTubePostInput
  ): Promise<PostForMeSocialPost> {
    this.createCalls.push(input);
    if (this.createError) throw this.createError;
    this.postSeq += 1;
    const postId = `post-${this.postSeq}`;
    if (this.createErrorAfterAccept) {
      // The provider accepted the post, but the response was lost
      // (timeout): the ledger already shows the confirmed result.
      this.results = [this.successResult(postId)];
      throw this.createErrorAfterAccept;
    }
    return { id: postId, status: 'pending' };
  }

  async listPostResults(filter: {
    postId?: string;
    socialAccountId?: string;
  }): Promise<PostForMePostResult[]> {
    return this.results.filter((result) => {
      if (filter.postId && result.post_id !== filter.postId) return false;
      if (
        filter.socialAccountId &&
        result.social_account_id !== filter.socialAccountId
      ) {
        return false;
      }
      return true;
    });
  }
}

function makePublisher(client: MockPostForMeYouTubeClient): YouTubePublisher {
  return new YouTubePublisher(client, { pollAttempts: 3, pollDelayMs: 0 });
}

// ==========================================
// Settlement: confirmation only
// ==========================================

describe('YouTubePublisher — settlement', () => {
  it('settles published only when the provider confirms, with the video id as externalPostId', async () => {
    const client = new MockPostForMeYouTubeClient();
    const publisher = makePublisher(client);

    // The provider confirms synchronously in the results read.
    const originalCreate = client.createPost.bind(client);
    client.createPost = async (input) => {
      const post = await originalCreate(input);
      client.confirmLastPost();
      return post;
    };

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe(VIDEO_ID);
    expect(outcome.detail).toMatchObject({
      provider: 'post-for-me',
      providerPostId: 'post-1',
      providerResultId: 'result-post-1',
    });
    expect(client.createCalls).toHaveLength(1);
  });

  it('does NOT settle published on a bare create response — unconfirmed settles retry', async () => {
    const client = new MockPostForMeYouTubeClient();
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('retry');
    expect(outcome.error?.code).toBe('provider_confirmation_pending');
    expect(outcome.externalPostId).toBeUndefined();
    expect(client.createCalls).toHaveLength(1);
  });

  it('settles failed when the provider reports the post as failed', async () => {
    const client = new MockPostForMeYouTubeClient();
    client.results = [];
    const publisher = makePublisher(client);
    const originalCreate = client.createPost.bind(client);
    client.createPost = async (input) => {
      const post = await originalCreate(input);
      client.results = [
        {
          id: 'result-post-1',
          post_id: post.id,
          social_account_id: PROVIDER_ACCOUNT_ID,
          success: false,
          error: { message: 'The video file could not be processed' },
        },
      ];
      return post;
    };

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('permanent');
    expect(outcome.error?.message).toContain('could not be processed');
  });
});

// ==========================================
// Privacy read-back
// ==========================================

describe('YouTubePublisher — applied privacy', () => {
  it('surfaces a requested-vs-applied privacy mismatch as a warning on the published outcome', async () => {
    const client = new MockPostForMeYouTubeClient();
    const publisher = makePublisher(client);
    const originalCreate = client.createPost.bind(client);
    client.createPost = async (input) => {
      const post = await originalCreate(input);
      client.confirmLastPost({ privacyStatus: 'unlisted' });
      return post;
    };

    const outcome = await publisher.publish(
      makeItem({
        platform_options: { privacy: 'public', madeForKids: false },
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(outcome.commentWarning).toContain('unlisted');
    expect(outcome.commentWarning).toContain('public');
    expect(outcome.detail).toMatchObject({ appliedPrivacy: 'unlisted' });
  });

  it('carries no warning when the applied privacy matches the request', async () => {
    const client = new MockPostForMeYouTubeClient();
    const publisher = makePublisher(client);
    const originalCreate = client.createPost.bind(client);
    client.createPost = async (input) => {
      const post = await originalCreate(input);
      client.confirmLastPost({ privacyStatus: 'public' });
      return post;
    };

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(outcome.commentWarning).toBeUndefined();
  });
});

// ==========================================
// Duplicate safety
// ==========================================

describe('YouTubePublisher — duplicate safety', () => {
  it('retry-after-timeout settles from provider state instead of resubmitting (no duplicate on the ledger)', async () => {
    const client = new MockPostForMeYouTubeClient();
    client.createErrorAfterAccept = new TypeError('fetch failed');
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe(VIDEO_ID);
    // The provider was submitted to exactly once.
    expect(client.createCalls).toHaveLength(1);
  });

  it('a later attempt finds the already-confirmed post and never resubmits', async () => {
    const client = new MockPostForMeYouTubeClient();
    const publisher = makePublisher(client);
    const originalCreate = client.createPost.bind(client);
    client.createPost = async (input) => {
      const post = await originalCreate(input);
      client.confirmLastPost();
      return post;
    };

    const first = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(first.status).toBe('published');

    // A duplicate delivery of the same queue item (e.g. the first
    // settle response was lost) must settle from the provider's
    // ledger, not upload again.
    const second = await publisher.publish(
      makeItem({ retry_count: 1 }),
      makeDestination(),
      TOKENS
    );
    expect(second.status).toBe('published');
    expect(second.externalPostId).toBe(VIDEO_ID);
    expect(client.createCalls).toHaveLength(1);
  });
});

// ==========================================
// Outbound payload
// ==========================================

describe('YouTubePublisher — outbound payload', () => {
  it('always sends madeForKids as an explicit boolean (true)', async () => {
    const client = new MockPostForMeYouTubeClient();
    const publisher = makePublisher(client);

    await publisher.publish(
      makeItem({
        platform_options: {
          privacy: 'private',
          madeForKids: true,
          tags: ['boss'],
          categoryId: '22',
        },
      }),
      makeDestination(),
      TOKENS
    );
    expect(client.createCalls).toHaveLength(1);
    const sent = client.createCalls[0];
    if (!sent) throw new Error('expected a create call');
    expect(sent.youtube.made_for_kids).toBe(true);
    expect(sent.youtube.privacy_status).toBe('private');
    expect(sent.youtube.tags).toEqual(['boss']);
    expect(sent.youtube.category_id).toBe('22');
    expect(sent.youtube.title).toBe(TITLE);
    expect(sent.media).toEqual([
      { url: 'https://media.example.com/videos/chair.mp4' },
    ]);
    expect(sent.socialAccountId).toBe(PROVIDER_ACCOUNT_ID);
  });

  it('always sends madeForKids as an explicit boolean (false, never omitted)', async () => {
    const client = new MockPostForMeYouTubeClient();
    const publisher = makePublisher(client);

    await publisher.publish(makeItem(), makeDestination(), TOKENS);
    const sent = client.createCalls[0];
    if (!sent) throw new Error('expected a create call');
    expect('made_for_kids' in sent.youtube).toBe(true);
    expect(sent.youtube.made_for_kids).toBe(false);
  });

  it('fails permanently without submitting when platform_options are invalid', async () => {
    const client = new MockPostForMeYouTubeClient();
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(
      makeItem({ platform_options: { privacy: 'public' } }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('invalid_platform_options');
    expect(client.createCalls).toHaveLength(0);
  });

  it('fails permanently without submitting when the destination has no provider account ref', async () => {
    const client = new MockPostForMeYouTubeClient();
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(
      makeItem(),
      makeDestination({ metadata: {} }),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('missing_provider_account');
    expect(client.createCalls).toHaveLength(0);
  });
});

// ==========================================
// Errors, tokens, registry
// ==========================================

describe('YouTubePublisher — errors and tokens', () => {
  it('classifies provider errors onto the shared taxonomy', () => {
    const publisher = makePublisher(new MockPostForMeYouTubeClient());
    const auth = new PostForMeError({
      status: 401,
      providerCode: 'unauthorized',
      providerMessage: 'Invalid API key',
      body: null,
    });
    expect(publisher.mapError(auth)).toMatchObject({
      kind: 'auth',
      code: 'unauthorized',
    });
    const rateLimited = new PostForMeError({
      status: 429,
      providerCode: null,
      providerMessage: 'Slow down',
      body: null,
    });
    expect(publisher.mapError(rateLimited)).toMatchObject({
      kind: 'retryable',
      code: 'http_429',
    });
    const permanent = new PostForMeError({
      status: 422,
      providerCode: null,
      providerMessage: 'Bad media',
      body: null,
    });
    expect(publisher.mapError(permanent)).toMatchObject({ kind: 'permanent' });
    expect(publisher.mapError(new Error('boom'))).toMatchObject({
      kind: 'retryable',
      code: 'unknown',
    });
  });

  it('an auth failure cascades the account to expired via settlement', async () => {
    const client = new MockPostForMeYouTubeClient();
    client.createError = new PostForMeError({
      status: 403,
      providerCode: null,
      providerMessage: 'Forbidden',
      body: null,
    });
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('auth');
    expect(outcome.targetAccountStatus).toBe('expired');
  });

  it('refreshTokens returns the supplied tokens unchanged (provider-managed)', async () => {
    const publisher = makePublisher(new MockPostForMeYouTubeClient());
    const refreshed = await publisher.refreshTokens(makeAccount(), {
      accessToken: 'a-token',
      refreshToken: 'r-token',
      tokenExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(refreshed).toEqual({
      accessToken: 'a-token',
      refreshToken: 'r-token',
      tokenExpiresAt: '2030-01-01T00:00:00.000Z',
    });
  });
});

describe('createWorkerPublisherRegistry — YouTube gating (spec 125)', () => {
  it('registers YouTube when the Post for Me API key is present', () => {
    const registry = createWorkerPublisherRegistry({
      POST_FOR_ME_API_KEY: 'test-key',
    });
    expect(registry.has('youtube')).toBe(true);
    expect(registry.get('youtube')).toBeInstanceOf(YouTubePublisher);
    expect(registry.has('facebook')).toBe(true);
  });

  it('does NOT register YouTube when the key is absent — items stay queued instead of failing auth', () => {
    const registry = createWorkerPublisherRegistry({});
    expect(registry.has('youtube')).toBe(false);
    expect(registry.has('facebook')).toBe(true);
  });

  it('does NOT register YouTube when called with no env at all', () => {
    const registry = createWorkerPublisherRegistry();
    expect(registry.has('youtube')).toBe(false);
  });
});
