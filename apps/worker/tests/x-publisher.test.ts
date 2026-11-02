import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublisherRegistry,
  decryptToken,
  encryptToken,
  type DatabaseDestinationRow,
  type DatabaseSocialAccountRow,
  type DatabaseUnifiedQueueItemRow,
  type PublisherTokenSet,
} from '@fbuploadpro/contracts';
import { MockXClient, XApiError } from '../src/x-client.js';
import {
  X_CREDITS_EXHAUSTED_CODE,
  XPublisher,
} from '../src/publishers/x.js';
import { createWorkerPublisherRegistry } from '../src/registry.js';
import { runRefreshCycle, type RefreshDbClient } from '../src/refresh.js';

// ==========================================
// Fixtures
// ==========================================

const NOW = new Date('2026-10-22T12:00:00.000Z');
const X_USER_ID = 'x-user-42';

// Real DB ids are UUIDs (spec 139 B15 boundary validation parses them).
const WS_ID = '11111111-1111-4111-8111-111111111111';
const ACCT_ID = '44444444-4444-4444-8444-444444444444';

function makeItem(
  overrides: Partial<DatabaseUnifiedQueueItemRow> = {}
): DatabaseUnifiedQueueItemRow {
  return {
    id: 'item-1',
    workspace_id: 'ws-1',
    destination_id: 'dest-1',
    platform: 'x',
    kind: 'text',
    platform_format: 'text',
    caption: 'Hello from X',
    title: null,
    first_comment: null,
    media_item_id: null,
    media_url: null,
    media_storage_key: null,
    link_url: null,
    platform_options: {},
    scheduled_time: NOW.toISOString(),
    slot_id: null,
    status: 'publishing',
    claimed_at: NOW.toISOString(),
    retry_count: 0,
    max_retries: 3,
    error_code: null,
    error_subcode: null,
    error_message: null,
    external_post_id: null,
    external_comment_id: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
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
    platform: 'x',
    external_destination_id: X_USER_ID,
    name: 'Test User',
    handle: 'testuser',
    avatar_url: null,
    timezone: 'UTC',
    status: 'active',
    encrypted_destination_token: null,
    rate_usage_pct: 0,
    metadata: {},
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function makeAccount(
  overrides: Partial<DatabaseSocialAccountRow> = {}
): DatabaseSocialAccountRow {
  return {
    id: 'acct-1',
    workspace_id: 'ws-1',
    platform: 'x',
    external_account_id: X_USER_ID,
    display_name: 'Test User',
    avatar_url: null,
    encrypted_access_token: 'encrypted-access',
    encrypted_refresh_token: 'encrypted-refresh',
    token_expires_at: '2026-10-22T14:00:00.000Z',
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
    status: 'active',
    metadata: {},
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

const TOKENS: PublisherTokenSet = {
  accessToken: 'user-access-token',
  refreshToken: 'user-refresh-token',
};

const IMAGE_URL = 'https://media.example.com/images/photo-1.jpg';
const GIF_URL = 'https://media.example.com/images/dance.gif';
const VIDEO_URL = 'https://media.example.com/videos/clip-1.mp4';

function makePublisher(mock: MockXClient, extra?: { env?: Record<string, string> }) {
  return new XPublisher(mock, {
    clientId: 'global-client-id',
    clientSecret: 'global-client-secret',
    now: () => NOW,
    ...(extra?.env ? { env: extra.env } : {}),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ==========================================
// Per-format publishes — chunked upload → POST /2/tweets, one attempt
// ==========================================

describe('XPublisher — per-format publish (one attempt, media first)', () => {
  it('registers under platform x in the worker registry alongside facebook', () => {
    const registry = createWorkerPublisherRegistry();
    expect(registry.has('x')).toBe(true);
    expect(registry.get('x')).toBeInstanceOf(XPublisher);
    expect(registry.has('facebook')).toBe(true);
  });

  it('text: publishes via POST /2/tweets with no upload', async () => {
    const mock = new MockXClient();
    const outcome = await makePublisher(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe('tweet-1001');
    expect(outcome.detail).toEqual({ mediaIds: [], tweetId: 'tweet-1001' });
    expect(mock.callOrder).toEqual(['createTweet']);
    expect(mock.tweetsCreated[0]?.payload.text).toBe('Hello from X');
  });

  it('image: chunked-uploads then tweets with the media id, in one attempt', async () => {
    const mock = new MockXClient();
    const outcome = await makePublisher(mock).publish(
      makeItem({ kind: 'image', platform_format: 'image', media_url: IMAGE_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.callOrder).toEqual(['uploadMediaChunked', 'createTweet']);
    expect(mock.uploadsStarted).toEqual([
      { sourceUrl: IMAGE_URL, mediaType: 'image/jpeg', mediaCategory: 'tweet_image' },
    ]);
    expect(mock.tweetsCreated[0]?.payload.mediaIds).toEqual(['media-2002']);
    expect(outcome.detail).toEqual({ mediaIds: ['media-2002'], tweetId: 'tweet-1001' });
  });

  it('GIF: uploads as tweet_gif then tweets', async () => {
    const mock = new MockXClient();
    const outcome = await makePublisher(mock).publish(
      makeItem({ kind: 'image', platform_format: 'gif', media_url: GIF_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.uploadsStarted[0]).toMatchObject({
      mediaType: 'image/gif',
      mediaCategory: 'tweet_gif',
    });
    expect(mock.callOrder).toEqual(['uploadMediaChunked', 'createTweet']);
  });

  it('video: uploads as tweet_video then tweets', async () => {
    const mock = new MockXClient();
    const outcome = await makePublisher(mock).publish(
      makeItem({ kind: 'video', platform_format: 'video', media_url: VIDEO_URL }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.uploadsStarted[0]).toMatchObject({
      mediaType: 'video/mp4',
      mediaCategory: 'tweet_video',
    });
    expect(mock.callOrder).toEqual(['uploadMediaChunked', 'createTweet']);
  });

  it('poll: tweets the poll options + duration, with no media', async () => {
    const mock = new MockXClient();
    const outcome = await makePublisher(mock).publish(
      makeItem({
        platform_options: { poll: { options: ['Cats', 'Dogs'], durationMinutes: 1440 } },
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.tweetsCreated[0]?.payload.poll).toEqual({
      options: ['Cats', 'Dogs'],
      durationMinutes: 1440,
    });
    expect(mock.callOrder).toEqual(['createTweet']);
  });

  it('quote: tweets with the quoted tweet id; reply settings ride along', async () => {
    const mock = new MockXClient();
    const outcome = await makePublisher(mock).publish(
      makeItem({
        platform_options: { quoteTweetId: 'tweet-555', replySettings: 'following' },
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.tweetsCreated[0]?.payload.quoteTweetId).toBe('tweet-555');
    expect(mock.tweetsCreated[0]?.payload.replySettings).toBe('following');
  });

  it('alt text: set via the media metadata call between upload and tweet', async () => {
    const mock = new MockXClient();
    const outcome = await makePublisher(mock).publish(
      makeItem({
        kind: 'image',
        platform_format: 'image',
        media_url: IMAGE_URL,
        platform_options: { altText: 'A sleepy cat on a sofa' },
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(mock.callOrder).toEqual(['uploadMediaChunked', 'setMediaMetadata', 'createTweet']);
    expect(mock.metadataSet).toEqual([
      { mediaId: 'media-2002', altText: 'A sleepy cat on a sofa' },
    ]);
  });

  it('publish NEVER refreshes tokens (D6): zero refresh calls across all formats', async () => {
    const mock = new MockXClient();
    const publisher = makePublisher(mock);
    await publisher.publish(makeItem(), makeDestination(), TOKENS);
    await publisher.publish(
      makeItem({ kind: 'image', platform_format: 'image', media_url: IMAGE_URL }),
      makeDestination(),
      TOKENS
    );
    expect(mock.refreshCalls).toHaveLength(0);
    expect(mock.callOrder).not.toContain('refreshAccessToken');
  });

  it('rejects over-limit text by weighted count before any API call', async () => {
    const mock = new MockXClient();
    const outcome = await makePublisher(mock).publish(
      makeItem({ caption: '漢'.repeat(141) }), // 282 weighted
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('text_too_long');
    expect(mock.callOrder).toEqual([]);
  });

  it('rejects a poll combined with media before any API call', async () => {
    const mock = new MockXClient();
    const outcome = await makePublisher(mock).publish(
      makeItem({
        kind: 'image',
        platform_format: 'image',
        media_url: IMAGE_URL,
        platform_options: { poll: { options: ['A', 'B'], durationMinutes: 60 } },
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('invalid_platform_options');
    expect(mock.callOrder).toEqual([]);
  });
});

// ==========================================
// D10 — duplicate-403 verify-then-published
// ==========================================

describe('XPublisher — D10 duplicate-403 settlement', () => {
  const duplicateError = () =>
    new XApiError(403, {
      title: 'Forbidden',
      detail: 'You are not allowed to create a Tweet with duplicate content.',
    });

  it('timeline match → settled published with the timeline post id; exactly one create attempt (no blind re-post)', async () => {
    const mock = new MockXClient();
    mock.createTweetError = duplicateError();
    mock.timelineTweets = [
      { id: 'earlier-1', text: 'something else' },
      { id: 'tweet-original', text: 'Hello from X' },
    ];
    const outcome = await makePublisher(mock).publish(
      makeItem({ retry_count: 1 }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe('tweet-original');
    expect(outcome.detail).toMatchObject({ duplicateVerified: true, tweetId: 'tweet-original' });
    // One create attempt total: the verification replaced any re-post.
    expect(mock.tweetsCreated).toHaveLength(0); // create threw before recording a success
    expect(mock.callOrder).toEqual(['createTweet-attempt', 'getUserTimeline'].map((s) => s.replace('-attempt', '')));
    expect(mock.timelineReads).toEqual([{ userId: X_USER_ID }]);
  });

  it('no timeline match → settled failed with the rejection surfaced; no re-post', async () => {
    const mock = new MockXClient();
    mock.createTweetError = duplicateError();
    mock.timelineTweets = [{ id: 'earlier-1', text: 'something else' }];
    const outcome = await makePublisher(mock).publish(
      makeItem({ retry_count: 1 }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('permanent');
    expect(outcome.error?.code).toBe('duplicate_content');
    expect(outcome.error?.message).toContain('duplicate');
    expect(mock.callOrder).toEqual(['createTweet', 'getUserTimeline']);
  });
});

// ==========================================
// 402 — platform-wide credits exhaustion
// ==========================================

describe('XPublisher — 402 platform-wide handling', () => {
  it('defers with the distinct code + long delay, never expires the account, and raises a platform-level PostHog exception', async () => {
    const captured: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { body?: string }) => {
        captured.push(init?.body ?? '');
        return { ok: true };
      })
    );
    const mock = new MockXClient();
    mock.createTweetError = new XApiError(402, {
      title: 'Payment Required',
      detail: 'Credits exhausted',
    });
    const publisher = makePublisher(mock, {
      env: { POSTHOG_KEY: 'test-key', POSTHOG_HOST: 'https://posthog.example' },
    });
    const outcome = await publisher.publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('deferred');
    expect(outcome.error?.code).toBe(X_CREDITS_EXHAUSTED_CODE);
    expect(outcome.error?.kind).toBe('retryable');
    expect(outcome.retryDelaySeconds).toBe(3600);
    expect('destinationCooldownSeconds' in outcome).toBe(false);
    expect(outcome.targetAccountStatus).toBeUndefined();
    expect(outcome.detail).toMatchObject({ platformWide: true });
    expect(captured.some((body) => body.includes('$exception'))).toBe(true);
    expect(captured.some((body) => body.includes('platform_credits_exhausted'))).toBe(true);
  });

  it('mapError classifies 402 as retryable with the platform code', () => {
    const publisher = makePublisher(new MockXClient());
    const classified = publisher.mapError(new XApiError(402, { detail: 'no credits' }));
    expect(classified.kind).toBe('retryable');
    expect(classified.code).toBe(X_CREDITS_EXHAUSTED_CODE);
  });
});

// ==========================================
// Rate-limit headers → usage metering only (20261102160000: the
// destination-wide cooldown they used to feed is gone)
// ==========================================

describe('XPublisher — x-rate-limit header metering', () => {
  it('published with an exhausted window reports usage with no destination cooldown', async () => {
    const mock = new MockXClient();
    mock.rateLimitToReturn = {
      limit: 100,
      remaining: 0,
      resetEpochSeconds: Math.floor(NOW.getTime() / 1000) + 600,
    };
    const outcome = await makePublisher(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('published');
    expect(outcome.rateUsagePct).toBe(100);
    expect('destinationCooldownSeconds' in outcome).toBe(false);
  });

  it('published with headroom reports usage with no invented cooldown', async () => {
    const mock = new MockXClient();
    mock.rateLimitToReturn = {
      limit: 100,
      remaining: 75,
      resetEpochSeconds: Math.floor(NOW.getTime() / 1000) + 600,
    };
    const outcome = await makePublisher(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.rateUsagePct).toBe(25);
    expect('destinationCooldownSeconds' in outcome).toBe(false);
  });

  it('429 → retry whose delay comes from the reset header', async () => {
    const mock = new MockXClient();
    mock.createTweetError = new XApiError(
      429,
      { title: 'Too Many Requests', detail: 'Rate limit exceeded' },
      { limit: 100, remaining: 0, resetEpochSeconds: Math.floor(NOW.getTime() / 1000) + 900 }
    );
    const outcome = await makePublisher(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('retry');
    expect(outcome.error?.kind).toBe('retryable');
    expect(outcome.retryDelaySeconds).toBe(900);
    expect('destinationCooldownSeconds' in outcome).toBe(false);
  });

  it('401 → failed with the account-expired cascade', async () => {
    const mock = new MockXClient();
    mock.createTweetError = new XApiError(401, { detail: 'Unauthorized' });
    const outcome = await makePublisher(mock).publish(makeItem(), makeDestination(), TOKENS);
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('auth');
    expect(outcome.targetAccountStatus).toBe('expired');
  });
});

// ==========================================
// refreshTokens (D6) + registry env-bag wiring
// ==========================================

describe('XPublisher — refreshTokens + registry env bag', () => {
  it('rotates via the token endpoint and returns the FULL new set for the atomic persist', async () => {
    const mock = new MockXClient();
    const refreshed = await makePublisher(mock).refreshTokens(makeAccount(), TOKENS);
    expect(mock.refreshCalls).toEqual([
      { clientId: 'global-client-id', refreshToken: 'user-refresh-token' },
    ]);
    expect(refreshed.accessToken).toBe('new-access');
    expect(refreshed.refreshToken).toBe('new-refresh');
    expect(refreshed.tokenExpiresAt).toBe('2026-10-22T14:00:00.000Z'); // NOW + 7200s
  });

  it('absent app credentials fail auth-class (clean behaviour, stated in the PR)', async () => {
    const publisher = new XPublisher(new MockXClient(), { now: () => NOW });
    const err = await publisher
      .refreshTokens(makeAccount(), TOKENS)
      .catch((e: unknown) => e);
    const classified = publisher.mapError(err);
    expect(classified.kind).toBe('auth');
    expect(classified.code).toBe('x_credentials_not_configured');
  });

  it('registry passes the env bag into the X publisher (refresh uses the env credentials)', async () => {
    let authHeader = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        authHeader =
          new Headers(init?.headers as Record<string, string>).get('authorization') ?? '';
        return new Response(
          JSON.stringify({
            access_token: 'env-access',
            refresh_token: 'env-refresh',
            expires_in: 7200,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    const registry = createWorkerPublisherRegistry({
      X_CLIENT_ID: 'env-client-id',
      X_CLIENT_SECRET: 'env-client-secret',
    });
    const publisher = registry.get('x');
    expect(publisher).toBeInstanceOf(XPublisher);
    const refreshed = await publisher?.refreshTokens(makeAccount(), TOKENS);
    expect(refreshed?.accessToken).toBe('env-access');
    expect(authHeader).toBe(`Basic ${btoa('env-client-id:env-client-secret')}`);
  });

  it('mapError: invalid_grant is auth; unknown errors stay retryable and mapError never throws', () => {
    const publisher = makePublisher(new MockXClient());
    expect(
      publisher.mapError(new XApiError(400, { error: 'invalid_grant', detail: 'revoked' })).kind
    ).toBe('auth');
    for (const input of [null, undefined, 'boom', 42]) {
      expect(publisher.mapError(input).kind).toBe('retryable');
    }
  });
});

// ==========================================
// Refresh job on the X fixture (D6 single-writer + expired)
// ==========================================

const MASTER_KEY =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

interface FakeAccount extends Record<string, unknown> {
  id: string;
  platform: string;
  status: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  token_expires_at: string | null;
  refresh_lease_owner: string | null;
  refresh_lease_expires_at: string | null;
}

type DbResult = { data: unknown; error: unknown };

function thenable(execute: () => DbResult) {
  return {
    then<TResult1 = DbResult, TResult2 = never>(
      onFulfilled?: ((value: DbResult) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve().then(execute).then(onFulfilled, onRejected);
    },
  };
}

class FakeRefreshDb {
  readonly accounts = new Map<string, FakeAccount>();
  readonly updates: Array<{ values: Record<string, unknown> }> = [];

  from(_table: string) {
    const db = this;
    return {
      select: (_columns: string) => {
        // Mirrors the spec 139 bounded-scan query shape: eq / lte / gt
        // predicates, id ordering, and a page limit.
        const predicates: Array<(row: FakeAccount) => boolean> = [];
        let limitCount: number | null = null;
        const builder = {
          eq(column: string, value: unknown) {
            predicates.push((row) => row[column] === value);
            return builder;
          },
          lte(column: string, value: unknown) {
            predicates.push(
              (row) => row[column] !== null && row[column] !== undefined && (row[column] as string) <= (value as string)
            );
            return builder;
          },
          gt(column: string, value: unknown) {
            predicates.push(
              (row) => row[column] !== null && row[column] !== undefined && (row[column] as string) > (value as string)
            );
            return builder;
          },
          order(_column: string, _options: { ascending: boolean }) {
            return builder;
          },
          limit(count: number) {
            limitCount = count;
            return builder;
          },
          then: thenable(() => {
            let rows = [...db.accounts.values()]
              .filter((row) => predicates.every((p) => p(row)))
              .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              .map((row) => ({ ...row }));
            if (limitCount !== null) rows = rows.slice(0, limitCount);
            return { data: rows, error: null };
          }).then,
        };
        return builder;
      },
      update: (values: Record<string, unknown>) => {
        const eqFilters: Array<[string, unknown]> = [];
        let orFilter: string | null = null;
        const execute = (): DbResult => {
          const matched: Array<{ id: string }> = [];
          for (const row of db.accounts.values()) {
            if (!eqFilters.every(([col, val]) => row[col] === val)) continue;
            if (orFilter !== null) {
              const passes = orFilter.split(',').some((clause) => {
                if (clause === 'refresh_lease_owner.is.null') {
                  return row.refresh_lease_owner === null;
                }
                const lt = /^refresh_lease_expires_at\.lt\.(.+)$/.exec(clause);
                return (
                  lt !== null &&
                  row.refresh_lease_expires_at !== null &&
                  row.refresh_lease_expires_at < (lt[1] as string)
                );
              });
              if (!passes) continue;
            }
            Object.assign(row, values);
            matched.push({ id: row.id });
          }
          db.updates.push({ values: { ...values } });
          return { data: matched, error: null };
        };
        const builder = {
          eq(column: string, value: unknown) {
            eqFilters.push([column, value]);
            return builder;
          },
          or(filter: string) {
            orFilter = filter;
            return builder;
          },
          select(_columns?: string) {
            return builder;
          },
          then: thenable(execute).then,
        };
        return builder;
      },
    };
  }
}

async function makeRefreshAccount(): Promise<FakeAccount> {
  return {
    id: ACCT_ID,
    workspace_id: WS_ID,
    platform: 'x',
    external_account_id: X_USER_ID,
    display_name: 'Test User',
    avatar_url: null,
    encrypted_access_token: await encryptToken('old-access', MASTER_KEY),
    encrypted_refresh_token: await encryptToken('old-refresh', MASTER_KEY),
    token_expires_at: '2026-10-22T12:10:00.000Z', // due: within X's 30-min threshold
    scopes: null,
    status: 'active',
    metadata: {},
    created_at: '2026-10-20T12:00:00.000Z',
    updated_at: '2026-10-20T12:00:00.000Z',
    refresh_lease_owner: null,
    refresh_lease_expires_at: null,
  };
}

function registryWithX(mock: MockXClient) {
  const registry = createPublisherRegistry();
  registry.register(
    new XPublisher(mock, {
      clientId: 'global-client-id',
      clientSecret: 'global-client-secret',
      now: () => NOW,
    })
  );
  return registry;
}

describe('Refresh job with the real XPublisher (spec 127 D6)', () => {
  it('SINGLE-WRITER: two concurrent cycles perform exactly one X rotation and one atomic persist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }))
    );
    const db = new FakeRefreshDb();
    db.accounts.set(ACCT_ID, await makeRefreshAccount());
    const mock = new MockXClient();
    const registry = registryWithX(mock);
    const env = { TOKEN_ENCRYPTION_KEY: MASTER_KEY };

    const [a, b] = await Promise.all([
      runRefreshCycle(db as unknown as RefreshDbClient, registry, env, NOW),
      runRefreshCycle(db as unknown as RefreshDbClient, registry, env, NOW),
    ]);

    expect(mock.refreshCalls).toHaveLength(1);
    expect(a.refreshed + b.refreshed).toBe(1);
    expect(a.skippedLease + b.skippedLease).toBe(1);
    const stored = db.accounts.get(ACCT_ID) as FakeAccount;
    expect(await decryptToken(stored.encrypted_access_token, MASTER_KEY)).toBe('new-access');
    expect(
      await decryptToken(stored.encrypted_refresh_token as string, MASTER_KEY)
    ).toBe('new-refresh');
    expect(stored.status).toBe('active');
  });

  it('expired refresh (invalid_grant from X) flips the account to expired', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true }))
    );
    const db = new FakeRefreshDb();
    db.accounts.set(ACCT_ID, await makeRefreshAccount());
    const mock = new MockXClient();
    mock.refreshError = new XApiError(400, {
      error: 'invalid_grant',
      detail: 'Refresh token has been revoked',
    });
    const result = await runRefreshCycle(
      db as unknown as RefreshDbClient,
      registryWithX(mock),
      { TOKEN_ENCRYPTION_KEY: MASTER_KEY },
      NOW
    );
    expect(result.expired).toBe(1);
    expect(db.accounts.get(ACCT_ID)?.status).toBe('expired');
  });
});

// ==========================================
// Grep proofs as tests: no platform_credentials writes, X-owned files
// ==========================================

describe('Spec 127 grep proofs', () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../src');

  it('no X-owned worker file reads or writes platform_credentials (X rows must stay zero)', () => {
    for (const file of ['publishers/x.ts', 'x-client.ts', 'registry.ts']) {
      const source = readFileSync(join(srcDir, file), 'utf8');
      expect(source).not.toContain(".from('platform_credentials')");
      expect(source).not.toContain('INSERT INTO platform_credentials');
      expect(source).not.toContain('insert into platform_credentials');
    }
  });

  it('the X publisher publish path contains no refresh call (source-level proof beside the behavioural one)', () => {
    const source = readFileSync(join(srcDir, 'publishers/x.ts'), 'utf8');
    const publishStart = source.indexOf('async publish(');
    const publishEnd = source.indexOf('private rateLimitOutcomeParts');
    expect(publishStart).toBeGreaterThan(-1);
    expect(publishEnd).toBeGreaterThan(publishStart);
    const publishBody = source.slice(publishStart, publishEnd);
    expect(publishBody).not.toContain('refresh');
    // And the whole module never re-posts after a duplicate check:
    // createTweet appears exactly in publish + the D10 comment surface.
    expect(source.match(/createTweet/g)?.length).toBe(1);
  });
});

// ==========================================
// Post-merge verification fixes: non-MP4 video rejection +
// spent-refresh-token guard
// ==========================================

describe('XPublisher — media/format guards (verification fix)', () => {
  it('a .mov video fails permanently as unsupported_video_format with NO upload attempted', async () => {
    const mock = new MockXClient();
    const outcome = await makePublisher(mock).publish(
      makeItem({
        kind: 'video',
        platform_format: 'video',
        media_url: 'https://media.example.com/videos/clip.mov',
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.kind).toBe('permanent');
    expect(outcome.error?.code).toBe('unsupported_video_format');
    expect(mock.uploadsStarted).toEqual([]);
    expect(mock.callOrder).toEqual([]);
  });

  it('a .webm video fails the same way (never mislabelled video/mp4)', async () => {
    const mock = new MockXClient();
    const outcome = await makePublisher(mock).publish(
      makeItem({
        kind: 'video',
        platform_format: 'video',
        media_url: 'https://media.example.com/videos/clip.webm',
      }),
      makeDestination(),
      TOKENS
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('unsupported_video_format');
    expect(mock.uploadsStarted).toEqual([]);
  });

  it('refreshTokens fails auth-class when the endpoint returns NO rotated refresh token (the spent token is never returned for persist)', async () => {
    const mock = new MockXClient();
    mock.nextRefresh = { accessToken: 'new-access-only', refreshToken: null, expiresIn: 7200 };
    const publisher = makePublisher(mock);
    const err = await publisher.refreshTokens(makeAccount(), TOKENS).catch((e: unknown) => e);
    const classified = publisher.mapError(err);
    expect(classified.kind).toBe('auth');
    expect(classified.code).toBe('invalid_grant');
  });
});
