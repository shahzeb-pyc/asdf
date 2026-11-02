import { describe, it, expect } from 'vitest';
import {
  LANE_ROUTING_TABLE,
  PLATFORM_PUBLISH_LIMITS,
  PLATFORM_TOKEN_REFRESH_CONFIG,
  PUBLISH_LANE_FAST,
  PUBLISH_LANE_HEAVY,
  QUEUE_ITEM_KINDS,
  createPublisherRegistry,
  getLaneKindSet,
  getTokenRefreshConfig,
  isTokenRefreshDue,
  resolvePublishLimit,
  resolvePublishLimitWindow,
  routePublishLane,
  routePublishLaneForItem,
  type Platform,
  type Publisher,
  type PublishLane,
  type QueueItemKind,
} from '../src/index.js';

const ALL_PLATFORMS: Platform[] = ['facebook', 'instagram', 'threads', 'youtube', 'x', 'tiktok'];

function makePublisher(platform: Platform): Publisher {
  return {
    platform,
    async publish() {
      return { status: 'published', externalPostId: `${platform}-post-1` };
    },
    async refreshTokens(_account, tokens) {
      return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? null };
    },
    mapError(err) {
      return {
        kind: 'permanent',
        code: 'test_error',
        message: err instanceof Error ? err.message : String(err),
      };
    },
  };
}

describe('Publisher registry (spec 121 Scope.1)', () => {
  it('registers and retrieves a publisher by platform', () => {
    const registry = createPublisherRegistry();
    const fb = makePublisher('facebook');
    registry.register(fb);

    expect(registry.has('facebook')).toBe(true);
    expect(registry.get('facebook')).toBe(fb);
    expect(registry.platforms()).toEqual(['facebook']);
  });

  it('returns undefined / false for unregistered platforms', () => {
    const registry = createPublisherRegistry();
    expect(registry.get('x')).toBeUndefined();
    expect(registry.has('x')).toBe(false);
    expect(registry.platforms()).toEqual([]);
  });

  it('keeps platforms independent and preserves registration order', () => {
    const registry = createPublisherRegistry();
    registry.register(makePublisher('instagram'));
    registry.register(makePublisher('facebook'));
    registry.register(makePublisher('x'));

    expect(registry.platforms()).toEqual(['instagram', 'facebook', 'x']);
    expect(registry.get('facebook')?.platform).toBe('facebook');
    expect(registry.get('instagram')?.platform).toBe('instagram');
  });

  it('rejects a duplicate registration for the same platform', () => {
    const registry = createPublisherRegistry();
    registry.register(makePublisher('threads'));
    expect(() => registry.register(makePublisher('threads'))).toThrow(/already registered/);
    // The original registration survives the rejected duplicate.
    expect(registry.platforms()).toEqual(['threads']);
  });

  it('publisher outcomes and error classification round-trip through the registry', async () => {
    const registry = createPublisherRegistry();
    registry.register(makePublisher('youtube'));
    const publisher = registry.get('youtube');
    expect(publisher).toBeDefined();

    const outcome = await publisher!.publish(
      {
        id: 'item-1',
        workspace_id: 'ws-1',
        destination_id: 'dest-1',
        platform: 'youtube',
        kind: 'video',
        platform_format: 'video',
        caption: 'hello',
        title: 'Hello',
        first_comment: null,
        media_item_id: null,
        media_url: 'https://cdn.example.com/v.mp4',
        media_storage_key: null,
        link_url: null,
        platform_options: {},
        scheduled_time: '2026-10-22T00:00:00.000Z',
        slot_id: null,
        status: 'publishing',
        claimed_at: null,
        retry_count: 0,
        max_retries: 3,
        error_code: null,
        error_subcode: null,
        error_message: null,
        external_post_id: null,
        external_comment_id: null,
        created_at: '2026-10-22T00:00:00.000Z',
        updated_at: '2026-10-22T00:00:00.000Z',
      },
      {
        id: 'dest-1',
        workspace_id: 'ws-1',
        account_id: 'acct-1',
        platform: 'youtube',
        external_destination_id: 'chan-1',
        name: 'Channel',
        handle: null,
        avatar_url: null,
        timezone: 'UTC',
        status: 'active',
        encrypted_destination_token: null,
            rate_usage_pct: 0,
        metadata: {},
        created_at: '2026-10-22T00:00:00.000Z',
        updated_at: '2026-10-22T00:00:00.000Z',
      },
      { accessToken: 'token' }
    );
    expect(outcome.status).toBe('published');
    expect(outcome.externalPostId).toBe('youtube-post-1');

    const classified = publisher!.mapError(new Error('boom'));
    expect(classified.kind).toBe('permanent');
    expect(classified.message).toBe('boom');
  });
});

describe('Lane routing (spec 121 Scope.2)', () => {
  // The expected table, written independently from spec 119 §5.1 /
  // spec 121 Scope.2: fast = text/image/link/carousel; heavy = anything
  // streaming bytes (reels, video, stories, YouTube uploads, X chunked
  // video). YouTube media-bearing kinds are all heavy (upload-only path).
  const EXPECTED: Record<Platform, Record<QueueItemKind, PublishLane>> = {
    facebook: { text: 'publish-fast', image: 'publish-fast', video: 'publish-heavy', story: 'publish-heavy', carousel: 'publish-fast' },
    instagram: { text: 'publish-fast', image: 'publish-fast', video: 'publish-heavy', story: 'publish-heavy', carousel: 'publish-fast' },
    threads: { text: 'publish-fast', image: 'publish-fast', video: 'publish-heavy', story: 'publish-heavy', carousel: 'publish-fast' },
    youtube: { text: 'publish-fast', image: 'publish-heavy', video: 'publish-heavy', story: 'publish-heavy', carousel: 'publish-heavy' },
    x: { text: 'publish-fast', image: 'publish-heavy', video: 'publish-heavy', story: 'publish-heavy', carousel: 'publish-heavy' },
    tiktok: { text: 'publish-fast', image: 'publish-fast', video: 'publish-heavy', story: 'publish-heavy', carousel: 'publish-fast' },
  };

  it('routes every (platform, kind) pair per the specced table', () => {
    for (const platform of ALL_PLATFORMS) {
      for (const kind of QUEUE_ITEM_KINDS) {
        expect(
          routePublishLane(platform, kind),
          `${platform}/${kind}`
        ).toBe(EXPECTED[platform][kind]);
        expect(LANE_ROUTING_TABLE[platform][kind]).toBe(EXPECTED[platform][kind]);
      }
    }
  });

  it('routes byte-streaming platform_format values heavy even when kind understates them', () => {
    expect(routePublishLane('facebook', 'image', 'reel')).toBe(PUBLISH_LANE_HEAVY);
    expect(routePublishLane('youtube', 'video', 'short')).toBe(PUBLISH_LANE_HEAVY);
    expect(routePublishLane('instagram', 'image', 'REEL')).toBe(PUBLISH_LANE_HEAVY);
    expect(routePublishLane('tiktok', 'image', ' story ')).toBe(PUBLISH_LANE_HEAVY);
  });

  it('does not let a light platform_format pull a heavy kind into the fast lane', () => {
    expect(routePublishLane('x', 'video', 'tweet')).toBe(PUBLISH_LANE_HEAVY);
    expect(routePublishLane('facebook', 'story', 'post')).toBe(PUBLISH_LANE_HEAVY);
  });

  it('routes every X media kind heavy (spec 127: chunked upload streams bytes for all media)', () => {
    expect(routePublishLane('x', 'image', 'tweet')).toBe(PUBLISH_LANE_HEAVY);
    expect(routePublishLane('x', 'carousel', 'tweet')).toBe(PUBLISH_LANE_HEAVY);
  });

  it('keeps light formats on the fast lane when kind agrees', () => {
    expect(routePublishLane('x', 'text', 'tweet')).toBe(PUBLISH_LANE_FAST);
    expect(routePublishLane('instagram', 'carousel', 'carousel')).toBe(PUBLISH_LANE_FAST);
    expect(routePublishLane('facebook', 'text', null)).toBe(PUBLISH_LANE_FAST);
    expect(routePublishLane('facebook', 'text', undefined)).toBe(PUBLISH_LANE_FAST);
  });

  it('derives the lane from a queue item row alone', () => {
    expect(
      routePublishLaneForItem({ platform: 'instagram', kind: 'video', platform_format: 'reel', media_url: 'https://cdn.example.com/r.mp4' })
    ).toBe(PUBLISH_LANE_HEAVY);
    expect(
      routePublishLaneForItem({ platform: 'threads', kind: 'text', platform_format: null })
    ).toBe(PUBLISH_LANE_FAST);
    expect(
      routePublishLaneForItem({ platform: 'youtube', kind: 'video', platform_format: 'short', media_item_id: 'm-1' })
    ).toBe(PUBLISH_LANE_HEAVY);
  });

  it('falls back deterministically for unknown kinds: heavy when media-bearing, else fast', () => {
    const unknownKind = 'live' as QueueItemKind;
    expect(routePublishLane('facebook', unknownKind, null, true)).toBe(PUBLISH_LANE_HEAVY);
    expect(routePublishLane('facebook', unknownKind, null, false)).toBe(PUBLISH_LANE_FAST);
    expect(
      routePublishLaneForItem({ platform: 'x', kind: unknownKind, media_storage_key: 'tenant/v.mp4' })
    ).toBe(PUBLISH_LANE_HEAVY);
    expect(
      routePublishLaneForItem({ platform: 'x', kind: unknownKind })
    ).toBe(PUBLISH_LANE_FAST);
  });

  it('lane kind sets partition the full kind set per platform (claim filter cannot drift)', () => {
    for (const platform of ALL_PLATFORMS) {
      const fast = getLaneKindSet(platform, PUBLISH_LANE_FAST);
      const heavy = getLaneKindSet(platform, PUBLISH_LANE_HEAVY);
      expect([...fast, ...heavy].sort()).toEqual([...QUEUE_ITEM_KINDS].sort());
      expect(fast.filter((k) => heavy.includes(k))).toEqual([]);
      // And each kind set agrees with the routing function itself.
      for (const kind of QUEUE_ITEM_KINDS) {
        const lane = routePublishLane(platform, kind);
        expect(getLaneKindSet(platform, lane)).toContain(kind);
      }
    }
  });

  it('exposes the claim kind sets the claimer will pass to the RPC', () => {
    expect(getLaneKindSet('facebook', PUBLISH_LANE_FAST)).toEqual(['text', 'image', 'carousel']);
    expect(getLaneKindSet('facebook', PUBLISH_LANE_HEAVY)).toEqual(['video', 'story']);
    expect(getLaneKindSet('youtube', PUBLISH_LANE_HEAVY)).toEqual(['image', 'video', 'story', 'carousel']);
    expect(getLaneKindSet('x', PUBLISH_LANE_FAST)).toEqual(['text']);
    expect(getLaneKindSet('x', PUBLISH_LANE_HEAVY)).toEqual(['image', 'video', 'story', 'carousel']);
  });
});

describe('Per-destination posting limits (spec 121 Scope.8, D5)', () => {
  it('carries the decided defaults per platform', () => {
    expect(PLATFORM_PUBLISH_LIMITS.instagram).toEqual({
      publishedPosts: { maxCount: 100, windowSeconds: 86400 },
      publishCalls: { maxCount: 25, windowSeconds: 3600 },
    });
    expect(PLATFORM_PUBLISH_LIMITS.threads).toEqual({
      publishedPosts: { maxCount: 250, windowSeconds: 86400 },
    });
    expect(PLATFORM_PUBLISH_LIMITS.x).toEqual({
      publishedPosts: { maxCount: 100, windowSeconds: 900 },
    });
    // Facebook: no centred cap.
    expect(PLATFORM_PUBLISH_LIMITS.facebook).toBeNull();
    // YouTube/TikTok: provider-imposed, extensible entries not yet set.
    expect(PLATFORM_PUBLISH_LIMITS.youtube).toEqual({});
    expect(PLATFORM_PUBLISH_LIMITS.tiktok).toEqual({});
  });

  it('resolves windows, returning null where a platform is uncapped', () => {
    expect(resolvePublishLimitWindow('instagram', 'publishedPosts')).toEqual({ maxCount: 100, windowSeconds: 86400 });
    expect(resolvePublishLimitWindow('instagram', 'publishCalls')).toEqual({ maxCount: 25, windowSeconds: 3600 });
    expect(resolvePublishLimitWindow('threads', 'publishCalls')).toBeNull();
    expect(resolvePublishLimitWindow('facebook', 'publishedPosts')).toBeNull();
    expect(resolvePublishLimitWindow('youtube', 'publishedPosts')).toBeNull();
    expect(resolvePublishLimit('facebook')).toBeNull();
  });

  it('lets a destination-level live value override the platform default', () => {
    // Instagram reports a smaller live quota for this account.
    const liveQuota = { publishedPosts: { maxCount: 50, windowSeconds: 86400 } };
    const resolved = resolvePublishLimit('instagram', liveQuota);
    expect(resolved?.publishedPosts).toEqual({ maxCount: 50, windowSeconds: 86400 });
    // The window the override does not mention keeps its default.
    expect(resolved?.publishCalls).toEqual({ maxCount: 25, windowSeconds: 3600 });
    expect(resolvePublishLimitWindow('instagram', 'publishedPosts', liveQuota)).toEqual({
      maxCount: 50,
      windowSeconds: 86400,
    });
  });

  it('applies an override on an otherwise uncapped platform', () => {
    const resolved = resolvePublishLimit('facebook', {
      publishedPosts: { maxCount: 10, windowSeconds: 3600 },
    });
    expect(resolved?.publishedPosts).toEqual({ maxCount: 10, windowSeconds: 3600 });
  });

  it('fills an extensible provider platform from an override without any schema change', () => {
    const resolved = resolvePublishLimit('youtube', {
      publishedPosts: { maxCount: 100, windowSeconds: 86400 },
    });
    expect(resolved?.publishedPosts).toEqual({ maxCount: 100, windowSeconds: 86400 });
    expect(resolvePublishLimitWindow('tiktok', 'publishedPosts', {
      publishedPosts: { maxCount: 20, windowSeconds: 86400 },
    })).toEqual({ maxCount: 20, windowSeconds: 86400 });
  });

  it('treats null/undefined/empty overrides as "use the defaults"', () => {
    expect(resolvePublishLimit('instagram', null)).toEqual(PLATFORM_PUBLISH_LIMITS.instagram);
    expect(resolvePublishLimit('instagram', undefined)).toEqual(PLATFORM_PUBLISH_LIMITS.instagram);
    expect(resolvePublishLimit('instagram', {})).toEqual(PLATFORM_PUBLISH_LIMITS.instagram);
    expect(resolvePublishLimit('facebook', {})).toBeNull();
  });
});

describe('Token-refresh thresholds (spec 121 Scope.9, D6)', () => {
  const NOW = new Date('2026-10-22T00:00:00.000Z');
  const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();

  it('carries the decided per-platform config', () => {
    const ig = getTokenRefreshConfig('instagram');
    expect(ig.strategy).toBe('long-lived');
    expect(ig.minimumTokenAgeSeconds).toBe(86400);
    expect(ig.requiresUnexpiredToken).toBe(true);
    expect(ig.accessTokenLifetimeSeconds).toBe(60 * 86400);

    const threads = getTokenRefreshConfig('threads');
    expect(threads.minimumTokenAgeSeconds).toBe(86400);
    expect(threads.requiresUnexpiredToken).toBe(true);

    const x = getTokenRefreshConfig('x');
    expect(x.strategy).toBe('rotating');
    expect(x.rotatingRefreshToken).toBe(true);
    expect(x.accessTokenLifetimeSeconds).toBe(2 * 3600);

    expect(getTokenRefreshConfig('facebook').strategy).toBe('lapse-detection');
    expect(getTokenRefreshConfig('youtube').strategy).toBe('provider-managed');
    expect(getTokenRefreshConfig('tiktok').strategy).toBe('provider-managed');
    expect(PLATFORM_TOKEN_REFRESH_CONFIG.x.refreshWhenExpiringWithinSeconds).toBe(1800);
  });

  it('marks a long-lived token due inside the threshold once it is old enough', () => {
    // Expires in 3 days (inside the 7-day threshold), issued 30 days ago.
    expect(
      isTokenRefreshDue('instagram', { tokenExpiresAt: hoursFromNow(72), tokenIssuedAt: daysAgo(30) }, NOW)
    ).toBe(true);
    expect(
      isTokenRefreshDue('threads', { tokenExpiresAt: hoursFromNow(72), tokenIssuedAt: daysAgo(30) }, NOW)
    ).toBe(true);
  });

  it('does not refresh a long-lived token that is too young or too far from expiry', () => {
    // Only 12 h old — the 24 h minimum-age rule blocks refresh.
    expect(
      isTokenRefreshDue('instagram', { tokenExpiresAt: hoursFromNow(72), tokenIssuedAt: hoursFromNow(-12) }, NOW)
    ).toBe(false);
    // 30 days from expiry — outside the 7-day threshold.
    expect(
      isTokenRefreshDue('instagram', { tokenExpiresAt: hoursFromNow(24 * 30), tokenIssuedAt: daysAgo(30) }, NOW)
    ).toBe(false);
  });

  it('never refreshes an expired long-lived token (re-auth instead)', () => {
    expect(
      isTokenRefreshDue('instagram', { tokenExpiresAt: hoursFromNow(-1), tokenIssuedAt: daysAgo(61) }, NOW)
    ).toBe(false);
  });

  it('marks X tokens due near expiry and still due after the access token lapses', () => {
    // 15 minutes left — inside the 30-minute threshold.
    expect(isTokenRefreshDue('x', { tokenExpiresAt: hoursFromNow(0.25) }, NOW)).toBe(true);
    // 90 minutes left — not yet due.
    expect(isTokenRefreshDue('x', { tokenExpiresAt: hoursFromNow(1.5) }, NOW)).toBe(false);
    // Access token already expired; the rotating refresh token can still be spent.
    expect(isTokenRefreshDue('x', { tokenExpiresAt: hoursFromNow(-1) }, NOW)).toBe(true);
  });

  it('fires Facebook lapse detection near expiry and after lapse', () => {
    expect(isTokenRefreshDue('facebook', { tokenExpiresAt: hoursFromNow(48) }, NOW)).toBe(true);
    expect(isTokenRefreshDue('facebook', { tokenExpiresAt: hoursFromNow(-48) }, NOW)).toBe(true);
    expect(isTokenRefreshDue('facebook', { tokenExpiresAt: hoursFromNow(24 * 30) }, NOW)).toBe(false);
  });

  it('never acts for provider-managed platforms or tokens without an expiry', () => {
    expect(isTokenRefreshDue('youtube', { tokenExpiresAt: hoursFromNow(1) }, NOW)).toBe(false);
    expect(isTokenRefreshDue('tiktok', { tokenExpiresAt: hoursFromNow(1) }, NOW)).toBe(false);
    expect(isTokenRefreshDue('instagram', { tokenExpiresAt: null }, NOW)).toBe(false);
    expect(isTokenRefreshDue('facebook', { tokenExpiresAt: null }, NOW)).toBe(false);
    expect(isTokenRefreshDue('x', {}, NOW)).toBe(false);
  });
});
