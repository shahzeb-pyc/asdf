import { describe, expect, it } from 'vitest';
import {
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type PublisherTokenSet,
} from '@fbuploadpro/contracts';
import { PostForMeError } from '../src/providers/post-for-me.js';
import type {
  CreatePostForMeTikTokPostInput,
  IPostForMeTikTokClient,
  PostForMePostResult,
  PostForMeSocialPost,
} from '../src/providers/post-for-me-tiktok.js';
import { TikTokPublisher } from '../src/publishers/tiktok.js';
import { createWorkerPublisherRegistry } from '../src/registry.js';

// ==========================================
// Fixtures + mock provider (spec 126)
// ==========================================

const PROVIDER_ACCOUNT_ID = 'sa_tt_1';
const POST_ID = 'ttPost987';
const POST_URL = 'https://www.tiktok.com/@boss/video/ttPost987';
const CAPTION = 'Disrespect! The boss reviews the new office chair.';

function makeItem(
  overrides: Partial<DatabaseUnifiedQueueItemRow> = {}
): DatabaseUnifiedQueueItemRow {
  return {
    id: 'item-1',
    workspace_id: 'ws-1',
    destination_id: 'dest-1',
    platform: 'tiktok',
    kind: 'video',
    platform_format: 'video',
    caption: CAPTION,
    title: null,
    first_comment: null,
    media_item_id: 'media-1',
    media_url: 'https://media.example.com/videos/chair.mp4',
    media_storage_key: null,
    link_url: null,
    platform_options: { privacy: 'public' },
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
    platform: 'tiktok',
    external_destination_id: 'creator-123',
    section: 'schedule',
    name: 'The Baby Boss',
    handle: '@babyboss',
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
    platform: 'tiktok',
    external_account_id: 'creator-123',
    display_name: 'The Baby Boss',
    avatar_url: null,
    encrypted_access_token: '',
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
  /** Applied privacy as the provider echoes it (its or TikTok's vocabulary). */
  privacyStatus?: string;
  /** Simulate TikTok landing the post in the creator's inbox as a draft. */
  draft?: boolean;
  postId?: string;
}

/**
 * A mock Post for Me TikTok client with a provider-side ledger:
 * `results` is what the provider reports, `createCalls` records every
 * submission attempt (the duplicate-safety assertions read it).
 */
class MockPostForMeTikTokClient implements IPostForMeTikTokClient {
  readonly createCalls: CreatePostForMeTikTokPostInput[] = [];
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
        caption: this.createCalls.at(-1)?.caption ?? CAPTION,
        platform_post_id: overrides.postId ?? POST_ID,
        post_url: POST_URL,
        privacy_status: overrides.privacyStatus ?? 'public',
        ...(overrides.draft ? { status: 'SEND_TO_USER_INBOX' } : {}),
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
    input: CreatePostForMeTikTokPostInput
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

function makePublisher(client: MockPostForMeTikTokClient): TikTokPublisher {
  return new TikTokPublisher(client, { pollAttempts: 3, pollDelayMs: 0 });
}

/** Wraps createPost so the provider confirms each post immediately. */
function confirmingClient(
  overrides: SuccessfulResultOverrides = {}
): MockPostForMeTikTokClient {
  const client = new MockPostForMeTikTokClient();
  const originalCreate = client.createPost.bind(client);
  client.createPost = async (input) => {
    const post = await originalCreate(input);
    client.confirmLastPost(overrides);
    return post;
  };
  return client;
}

// ==========================================
// Settlement: confirmation only
// ==========================================

describe('TikTokPublisher — settlement', () => {
  it('settles published only when the provider confirms, with the post id as externalPostId', async () => {
    const client = confirmingClient();
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe(POST_ID);
    expect(outcome.detail).toMatchObject({
      provider: 'post-for-me',
      providerPostId: 'post-1',
      providerResultId: 'result-post-1',
      postUrl: POST_URL,
    });
    expect(client.createCalls).toHaveLength(1);
  });

  it('does NOT settle published on a bare create response — unconfirmed settles retry', async () => {
    const client = new MockPostForMeTikTokClient();
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('retry');
    expect(outcome.error?.code).toBe('provider_confirmation_pending');
    expect(outcome.externalPostId).toBeUndefined();
    expect(client.createCalls).toHaveLength(1);
  });

  it('settles failed when the provider reports the post as failed', async () => {
    const client = new MockPostForMeTikTokClient();
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
    expect(outcome.error?.code).toBe('provider_post_failed');
    expect(outcome.error?.message).toContain('could not be processed');
  });
});

// ==========================================
// Draft / inbox outcomes — never published (spec 126 Scope.1)
// ==========================================

describe('TikTokPublisher — draft outcomes', () => {
  it('a SEND_TO_USER_INBOX result settles FAILED, never published', async () => {
    const client = confirmingClient({ draft: true });
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('permanent');
    expect(outcome.error?.code).toBe('provider_draft_outcome');
    expect(outcome.error?.message).toContain('draft');
    expect(outcome.externalPostId).toBeUndefined();
  });

  it('an is_draft flag on the result also settles failed', async () => {
    const client = new MockPostForMeTikTokClient();
    const publisher = makePublisher(client);
    const originalCreate = client.createPost.bind(client);
    client.createPost = async (input) => {
      const post = await originalCreate(input);
      client.results = [
        {
          id: 'result-post-1',
          post_id: post.id,
          social_account_id: PROVIDER_ACCOUNT_ID,
          success: true,
          platform_data: { caption: CAPTION, is_draft: true },
        },
      ];
      return post;
    };

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('provider_draft_outcome');
  });
});

// ==========================================
// Applied-privacy read-back (spec 126 + contracts tiktok-options)
// ==========================================

describe('TikTokPublisher — applied privacy read-back', () => {
  it('fails plainly when TikTok fell back to SELF_ONLY against a public request', async () => {
    const client = confirmingClient({ privacyStatus: 'SELF_ONLY' });
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('permanent');
    expect(outcome.error?.code).toBe('privacy_not_honoured');
    expect(outcome.error?.message).toContain('private');
    expect(outcome.error?.message).toContain('privacy settings');
    expect(outcome.externalPostId).toBeUndefined();
    expect(outcome.detail).toMatchObject({ appliedPrivacy: 'private' });
  });

  it('publishes when the applied privacy matches in TikTok vocabulary', async () => {
    const client = confirmingClient({ privacyStatus: 'PUBLIC_TO_EVERYONE' });
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(outcome.detail).toMatchObject({ appliedPrivacy: 'public' });
  });

  it('publishes a followers-only post when followers was requested and applied', async () => {
    const client = confirmingClient({ privacyStatus: 'FOLLOWER_OF_CREATOR' });
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(
      makeItem({ platform_options: { privacy: 'followers' } }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
  });

  it('fails when a followers-only request landed public', async () => {
    const client = confirmingClient({ privacyStatus: 'public' });
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(
      makeItem({ platform_options: { privacy: 'followers' } }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('privacy_not_honoured');
  });

  it('publishes when the provider reports no applied privacy (nothing contradicts the request)', async () => {
    const client = new MockPostForMeTikTokClient();
    const publisher = makePublisher(client);
    const originalCreate = client.createPost.bind(client);
    client.createPost = async (input) => {
      const post = await originalCreate(input);
      client.results = [
        {
          id: 'result-post-1',
          post_id: post.id,
          social_account_id: PROVIDER_ACCOUNT_ID,
          success: true,
          platform_data: { caption: CAPTION, platform_post_id: POST_ID },
        },
      ];
      return post;
    };

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(outcome.detail).toMatchObject({ appliedPrivacy: null });
  });
});

// ==========================================
// Duplicate safety
// ==========================================

describe('TikTokPublisher — duplicate safety', () => {
  it('retry-after-timeout settles from provider state instead of resubmitting', async () => {
    const client = new MockPostForMeTikTokClient();
    client.createErrorAfterAccept = new TypeError('fetch failed');
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe(POST_ID);
    // The provider was submitted to exactly once.
    expect(client.createCalls).toHaveLength(1);
  });

  it('a later attempt finds the already-confirmed post and never resubmits', async () => {
    const client = confirmingClient();
    const publisher = makePublisher(client);

    const first = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(first.status).toBe('published');

    const second = await publisher.publish(
      makeItem({ retry_count: 1 }),
      makeDestination(),
      TOKENS
    );
    expect(second.status).toBe('published');
    expect(second.externalPostId).toBe(POST_ID);
    expect(client.createCalls).toHaveLength(1);
  });

  it('a prior DRAFT result is settled as the draft failure, not resubmitted and not published', async () => {
    const client = confirmingClient({ draft: true });
    const publisher = makePublisher(client);

    const first = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(first.status).toBe('failed');
    expect(first.error?.code).toBe('provider_draft_outcome');

    const second = await publisher.publish(
      makeItem({ retry_count: 1 }),
      makeDestination(),
      TOKENS
    );
    expect(second.status).toBe('failed');
    expect(second.error?.code).toBe('provider_draft_outcome');
    expect(client.createCalls).toHaveLength(1);
  });
});

// ==========================================
// Outbound payload
// ==========================================

describe('TikTokPublisher — outbound payload', () => {
  it('always sends is_draft as an explicit false, and the requested privacy', async () => {
    const client = new MockPostForMeTikTokClient();
    const publisher = makePublisher(client);

    await publisher.publish(
      makeItem({ platform_options: { privacy: 'friends' } }),
      makeDestination(),
      TOKENS
    );
    const sent = client.createCalls[0];
    if (!sent) throw new Error('expected a create call');
    expect('is_draft' in sent.tiktok).toBe(true);
    expect(sent.tiktok.is_draft).toBe(false);
    expect(sent.tiktok.privacy_status).toBe('friends');
    expect(sent.media).toEqual([
      { url: 'https://media.example.com/videos/chair.mp4' },
    ]);
    expect(sent.socialAccountId).toBe(PROVIDER_ACCOUNT_ID);
    expect(sent.caption).toBe(CAPTION);
  });

  it('sends only the reaction toggles the user picked', async () => {
    const client = new MockPostForMeTikTokClient();
    const publisher = makePublisher(client);

    await publisher.publish(
      makeItem({
        platform_options: {
          privacy: 'public',
          allowComment: false,
          isAiGenerated: true,
        },
      }),
      makeDestination(),
      TOKENS
    );
    const sent = client.createCalls[0];
    if (!sent) throw new Error('expected a create call');
    expect(sent.tiktok.allow_comment).toBe(false);
    expect(sent.tiktok.is_ai_generated).toBe(true);
    expect('allow_duet' in sent.tiktok).toBe(false);
    expect('allow_stitch' in sent.tiktok).toBe(false);
  });

  it('never sends auto_add_music for a video post, even when picked', async () => {
    const client = new MockPostForMeTikTokClient();
    const publisher = makePublisher(client);

    await publisher.publish(
      makeItem({
        platform_options: { privacy: 'public', autoAddMusic: true },
      }),
      makeDestination(),
      TOKENS
    );
    const sent = client.createCalls[0];
    if (!sent) throw new Error('expected a create call');
    expect('auto_add_music' in sent.tiktok).toBe(false);
  });

  it('sends auto_add_music for a photo post when picked', async () => {
    const client = new MockPostForMeTikTokClient();
    const publisher = makePublisher(client);

    await publisher.publish(
      makeItem({
        kind: 'image',
        platform_format: 'photo',
        platform_options: { privacy: 'public', autoAddMusic: true },
      }),
      makeDestination(),
      TOKENS
    );
    const sent = client.createCalls[0];
    if (!sent) throw new Error('expected a create call');
    expect(sent.tiktok.auto_add_music).toBe(true);
  });

  it('fails permanently without submitting when platform_options hold a value the provider cannot accept', async () => {
    const client = new MockPostForMeTikTokClient();
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(
      makeItem({ platform_options: { privacy: 'unlisted' } }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('invalid_platform_options');
    expect(client.createCalls).toHaveLength(0);
  });

  it('fails permanently without submitting when the caption exceeds TikTok\u2019s limit', async () => {
    const client = new MockPostForMeTikTokClient();
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(
      makeItem({ caption: 'a'.repeat(2201) }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('invalid_post_fields');
    expect(outcome.error?.message).toContain('2,200');
    expect(client.createCalls).toHaveLength(0);
  });

  it('fails permanently without submitting when the destination has no provider account ref', async () => {
    const client = new MockPostForMeTikTokClient();
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

  it('fails permanently without submitting when the item has no media', async () => {
    const client = new MockPostForMeTikTokClient();
    const publisher = makePublisher(client);

    const outcome = await publisher.publish(
      makeItem({ media_url: null }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('missing_media_url');
    expect(client.createCalls).toHaveLength(0);
  });
});

// ==========================================
// Errors, tokens, registry
// ==========================================

describe('TikTokPublisher — errors and tokens', () => {
  it('classifies provider errors onto the shared taxonomy', () => {
    const publisher = makePublisher(new MockPostForMeTikTokClient());
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
    const serverError = new PostForMeError({
      status: 503,
      providerCode: null,
      providerMessage: 'Unavailable',
      body: null,
    });
    expect(publisher.mapError(serverError)).toMatchObject({ kind: 'retryable' });
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
    const client = new MockPostForMeTikTokClient();
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
    const publisher = makePublisher(new MockPostForMeTikTokClient());
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

describe('createWorkerPublisherRegistry — TikTok gating (spec 126)', () => {
  it('registers TikTok when the Post for Me API key is present', () => {
    const registry = createWorkerPublisherRegistry({
      POST_FOR_ME_API_KEY: ['test', 'key'].join('-'),
    });
    expect(registry.has('tiktok')).toBe(true);
    expect(registry.get('tiktok')).toBeInstanceOf(TikTokPublisher);
    expect(registry.has('facebook')).toBe(true);
  });

  it('does NOT register TikTok when the key is absent — items stay queued instead of failing auth', () => {
    const registry = createWorkerPublisherRegistry({});
    expect(registry.has('tiktok')).toBe(false);
    expect(registry.has('facebook')).toBe(true);
  });

  it('does NOT register TikTok when called with no env at all', () => {
    const registry = createWorkerPublisherRegistry();
    expect(registry.has('tiktok')).toBe(false);
  });
});
