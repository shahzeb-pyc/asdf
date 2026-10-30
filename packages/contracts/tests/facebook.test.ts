import { describe, expect, it } from 'vitest';
import {
  DiscoveredPageSchema,
  FacebookAccountSchema,
  FacebookAccountStatusEnum,
  FacebookAccountStatusSchema,
  FacebookAccountViewSchema,
  FacebookPageSchema,
  FacebookPageStatusEnum,
  FacebookPageStatusSchema,
  FacebookPageViewSchema,
  fetchAllFacebookPages,
} from '../src/domain/facebook.js';
import { evaluateGraphApiError } from '../src/domain/facebook-health.js';

describe('Facebook Account & Page Domain Schemas', () => {
  const userId = '550e8400-e29b-41d4-a716-446655440000';
  const accountId = '660e8400-e29b-41d4-a716-446655440001';
  const pageId = '770e8400-e29b-41d4-a716-446655440002';

  describe('FacebookAccountStatusSchema', () => {
    it('accepts valid statuses and exposes FacebookAccountStatusEnum', () => {
      expect(FacebookAccountStatusSchema.parse('active')).toBe('active');
      expect(FacebookAccountStatusSchema.parse('disconnected')).toBe('disconnected');
      expect(FacebookAccountStatusSchema.parse('expired')).toBe('expired');
      expect(FacebookAccountStatusEnum.active).toBe('active');
      expect(FacebookAccountStatusEnum.disconnected).toBe('disconnected');
      expect(FacebookAccountStatusEnum.expired).toBe('expired');
    });

    it('rejects invalid statuses', () => {
      expect(FacebookAccountStatusSchema.safeParse('pending').success).toBe(false);
      expect(FacebookAccountStatusSchema.safeParse('banned').success).toBe(false);
    });
  });

  describe('FacebookAccountSchema', () => {
    const validAccount = {
      id: accountId,
      userId,
      fbAccountId: 'act_1092837465',
      displayName: 'Main Media Ops',
      status: 'active' as const,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };

    it('validates a correct Facebook account entity', () => {
      const parsed = FacebookAccountSchema.parse(validAccount);
      expect(parsed.id).toBe(accountId);
      expect(parsed.userId).toBe(userId);
      expect(parsed.fbAccountId).toBe('act_1092837465');
      expect(parsed.status).toBe('active');
      expect(parsed.profilePictureUrl).toBeNull();
      expect(parsed.gender).toBeNull();
      expect(parsed.accountLink).toBeNull();
    });

    it('accepts profilePictureUrl, gender, and accountLink and defaults them to null when omitted', () => {
      const withMetadata = FacebookAccountSchema.parse({
        ...validAccount,
        profilePictureUrl: 'https://platform-lookaside.fbsbx.com/platform/profilepic/account.jpg',
        gender: 'female',
        accountLink: 'https://www.facebook.com/app_scoped_user_id/1092837465/',
      });
      expect(withMetadata.profilePictureUrl).toBe(
        'https://platform-lookaside.fbsbx.com/platform/profilepic/account.jpg'
      );
      expect(withMetadata.gender).toBe('female');
      expect(withMetadata.accountLink).toBe(
        'https://www.facebook.com/app_scoped_user_id/1092837465/'
      );

      const viewWithMetadata = FacebookAccountViewSchema.parse({
        id: accountId,
        fbAccountId: 'act_1092837465',
        displayName: 'Main Media Ops',
        profilePictureUrl: 'https://platform-lookaside.fbsbx.com/platform/profilepic/account.jpg',
        gender: 'female',
        accountLink: 'https://www.facebook.com/app_scoped_user_id/1092837465/',
        status: 'active',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      expect(viewWithMetadata.profilePictureUrl).toBe(
        'https://platform-lookaside.fbsbx.com/platform/profilepic/account.jpg'
      );
      expect(viewWithMetadata.gender).toBe('female');
      expect(viewWithMetadata.accountLink).toBe(
        'https://www.facebook.com/app_scoped_user_id/1092837465/'
      );
    });

    it('applies default status when omitted', () => {
      const { status: _, ...omittedStatus } = validAccount;
      const parsed = FacebookAccountSchema.parse(omittedStatus);
      expect(parsed.status).toBe('active');
    });

    it('rejects invalid UUIDs or empty account identifiers', () => {
      expect(FacebookAccountSchema.safeParse({ ...validAccount, id: 'not-uuid' }).success).toBe(false);
      expect(FacebookAccountSchema.safeParse({ ...validAccount, userId: 'not-uuid' }).success).toBe(false);
      expect(FacebookAccountSchema.safeParse({ ...validAccount, fbAccountId: '' }).success).toBe(false);
      expect(FacebookAccountSchema.safeParse({ ...validAccount, displayName: '' }).success).toBe(false);
    });
  });

  describe('FacebookPageStatusSchema', () => {
    it('accepts valid page statuses and exposes FacebookPageStatusEnum', () => {
      expect(FacebookPageStatusSchema.parse('active')).toBe('active');
      expect(FacebookPageStatusSchema.parse('paused')).toBe('paused');
      expect(FacebookPageStatusSchema.parse('fb_rate_limited')).toBe('fb_rate_limited');
      expect(FacebookPageStatusSchema.parse('page_checkpoint')).toBe('page_checkpoint');
      expect(FacebookPageStatusSchema.parse('invalid_token')).toBe('invalid_token');
      expect(FacebookPageStatusSchema.parse('disconnected')).toBe('disconnected');
      expect(FacebookPageStatusEnum.active).toBe('active');
      expect(FacebookPageStatusEnum.paused).toBe('paused');
      expect(FacebookPageStatusEnum.fb_rate_limited).toBe('fb_rate_limited');
      expect(FacebookPageStatusEnum.page_checkpoint).toBe('page_checkpoint');
      expect(FacebookPageStatusEnum.invalid_token).toBe('invalid_token');
      expect(FacebookPageStatusEnum.disconnected).toBe('disconnected');
    });

    it('rejects invalid statuses', () => {
      expect(FacebookPageStatusSchema.safeParse('active_live').success).toBe(false);
    });
  });

  describe('FacebookPageSchema', () => {
    const validPage = {
      id: pageId,
      userId,
      facebookAccountId: accountId,
      fbPageId: 'page_987654321',
      pageName: 'Tech Deals Daily',
      followersCount: 12500,
      status: 'active' as const,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };

    it('validates a correct Facebook page entity with composite identifiers', () => {
      const parsed = FacebookPageSchema.parse(validPage);
      expect(parsed.id).toBe(pageId);
      expect(parsed.userId).toBe(userId);
      expect(parsed.facebookAccountId).toBe(accountId);
      expect(parsed.followersCount).toBe(12500);
      expect(parsed.profilePictureUrl).toBeNull();
    });

    it('accepts profilePictureUrl on FacebookPageSchema, FacebookPageViewSchema, and DiscoveredPageSchema', () => {
      const picUrl = 'https://platform-lookaside.fbsbx.com/platform/profilepic/page.jpg';
      const parsedPage = FacebookPageSchema.parse({ ...validPage, profilePictureUrl: picUrl });
      expect(parsedPage.profilePictureUrl).toBe(picUrl);

      const parsedPageView = FacebookPageViewSchema.parse({
        id: pageId,
        facebookAccountId: accountId,
        fbPageId: 'page_987654321',
        pageName: 'Tech Deals Daily',
        profilePictureUrl: picUrl,
        status: 'active',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      expect(parsedPageView.profilePictureUrl).toBe(picUrl);

      const parsedDiscovered = DiscoveredPageSchema.parse({
        fbPageId: 'page_987654321',
        pageName: 'Tech Deals Daily',
        profilePictureUrl: picUrl,
      });
      expect(parsedDiscovered.profilePictureUrl).toBe(picUrl);
    });

    it('accepts accountPictureUrl on FacebookPageViewSchema and defaults it to null', () => {
      const picUrl = 'https://platform-lookaside.fbsbx.com/platform/profilepic/account.jpg';
      const withPic = FacebookPageViewSchema.parse({
        id: pageId,
        facebookAccountId: accountId,
        accountDisplayName: 'Alex Marketing',
        accountPictureUrl: picUrl,
        fbPageId: 'page_987654321',
        pageName: 'Tech Deals Daily',
        status: 'active',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      expect(withPic.accountPictureUrl).toBe(picUrl);

      const withoutPic = FacebookPageViewSchema.parse({
        id: pageId,
        facebookAccountId: accountId,
        fbPageId: 'page_987654321',
        pageName: 'Tech Deals Daily',
        status: 'active',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      });
      expect(withoutPic.accountPictureUrl).toBeNull();
    });

    it('defaults followersCount, startingFollowers, and currentFollowers to 0 and status to active', () => {
      const minimalPage = {
        id: pageId,
        userId,
        facebookAccountId: accountId,
        fbPageId: 'page_987654321',
        pageName: 'Tech Deals Daily',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const parsed = FacebookPageSchema.parse(minimalPage);
      expect(parsed.followersCount).toBe(0);
      expect(parsed.startingFollowers).toBe(0);
      expect(parsed.currentFollowers).toBe(0);
      expect(parsed.status).toBe('active');
    });

    it('supports startingFollowers, currentFollowers, and positive, zero, or negative followersGained in FacebookPageViewSchema', () => {
      const baseView = {
        id: pageId,
        facebookAccountId: accountId,
        fbPageId: 'page_987654321',
        pageName: 'Tech Deals Daily',
        status: 'active' as const,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      };

      const positiveGrowth = FacebookPageViewSchema.parse({
        ...baseView,
        startingFollowers: 10000,
        currentFollowers: 12450,
        followersGained: 2450,
        followersCount: 12450,
      });
      expect(positiveGrowth.startingFollowers).toBe(10000);
      expect(positiveGrowth.currentFollowers).toBe(12450);
      expect(positiveGrowth.followersGained).toBe(2450);

      const zeroGrowth = FacebookPageViewSchema.parse({
        ...baseView,
        startingFollowers: 10000,
        currentFollowers: 10000,
        followersGained: 0,
        followersCount: 10000,
      });
      expect(zeroGrowth.followersGained).toBe(0);

      const negativeGrowth = FacebookPageViewSchema.parse({
        ...baseView,
        startingFollowers: 10000,
        currentFollowers: 9880,
        followersGained: -120,
        followersCount: 9880,
      });
      expect(negativeGrowth.startingFollowers).toBe(10000);
      expect(negativeGrowth.currentFollowers).toBe(9880);
      expect(negativeGrowth.followersGained).toBe(-120);
    });

    it('rejects negative followersCount, startingFollowers, or currentFollowers', () => {
      expect(FacebookPageSchema.safeParse({ ...validPage, followersCount: -1 }).success).toBe(false);
      expect(FacebookPageSchema.safeParse({ ...validPage, startingFollowers: -1 }).success).toBe(false);
      expect(FacebookPageSchema.safeParse({ ...validPage, currentFollowers: -1 }).success).toBe(false);
    });

    it('rejects invalid foreign key UUIDs or empty fields', () => {
      expect(FacebookPageSchema.safeParse({ ...validPage, facebookAccountId: 'bad-id' }).success).toBe(false);
      expect(FacebookPageSchema.safeParse({ ...validPage, pageName: '' }).success).toBe(false);
      expect(FacebookPageSchema.safeParse({ ...validPage, fbPageId: '' }).success).toBe(false);
    });
  });

  describe('rateLimitedAt in FacebookPageViewSchema', () => {
    it('accepts valid date, null, and undefined for rateLimitedAt', () => {
      const now = new Date();
      const withDate = FacebookPageViewSchema.parse({
        id: pageId,
        facebookAccountId: accountId,
        accountDisplayName: 'Main Media Ops',
        fbPageId: 'page_1092837465',
        pageName: 'Engineering Insights',
        profilePictureUrl: null,
        category: null,
        startingFollowers: 100,
        currentFollowers: 150,
        followersGained: 50,
        followersCount: 150,
        status: 'fb_rate_limited',
        tasks: [],
        rateLimitedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      expect(withDate.rateLimitedAt).toEqual(now);

      const withNull = FacebookPageViewSchema.parse({
        id: pageId,
        facebookAccountId: accountId,
        accountDisplayName: 'Main Media Ops',
        fbPageId: 'page_1092837465',
        pageName: 'Engineering Insights',
        profilePictureUrl: null,
        category: null,
        startingFollowers: 100,
        currentFollowers: 150,
        followersGained: 50,
        followersCount: 150,
        status: 'active',
        tasks: [],
        rateLimitedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      expect(withNull.rateLimitedAt).toBeNull();
    });
  });

  // K11: the detail path passes `?? null` for a missing account
  // row and a stored avatar that is not a URL — neither may throw
  // the whole view parse (old code: accountDisplayName was
  // optional-only, so null threw; profilePictureUrl was .url(),
  // so a non-URL threw).
  describe('K11 detail-view null/non-URL fallbacks', () => {
    const baseView = {
      id: pageId,
      facebookAccountId: accountId,
      fbPageId: 'page_1092837465',
      pageName: 'Engineering Insights',
      status: 'active' as const,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    it('accepts a null accountDisplayName (missing account row)', () => {
      const parsed = FacebookPageViewSchema.parse({
        ...baseView,
        accountDisplayName: null,
      });
      expect(parsed.accountDisplayName).toBeNull();
    });
    it('falls back a non-URL profilePictureUrl to null instead of throwing', () => {
      const parsed = FacebookPageViewSchema.parse({
        ...baseView,
        profilePictureUrl: 'not-a-url',
      });
      expect(parsed.profilePictureUrl).toBeNull();
    });
    it('still keeps a valid profilePictureUrl', () => {
      const parsed = FacebookPageViewSchema.parse({
        ...baseView,
        profilePictureUrl: 'https://example.com/pic.jpg',
      });
      expect(parsed.profilePictureUrl).toBe('https://example.com/pic.jpg');
    });
  });

  describe('fetchAllFacebookPages helper', () => {
    it('fetches a single page of results with limit=100', async () => {
      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(input);
        expect(urlStr).toContain('limit=100');
        expect(urlStr).toContain('fields=id%2Cname');
        expect(init?.headers).toEqual({ Authorization: 'Bearer test-token' });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: 'p1', name: 'Page One' },
              { id: 'p2', name: 'Page Two' },
            ],
          }),
        } as Response;
      };

      const result = await fetchAllFacebookPages('test-token', 'id,name', 5, mockFetch as any);
      expect(result.pages).toHaveLength(2);
      expect(result.pages[0]?.id).toBe('p1');
      expect(result.pages[1]?.id).toBe('p2');
      expect(result.truncated).toBe(false);
      expect(result.partial).toBe(false);
    });

    it('follows cursor pagination paging.next across multiple pages', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: 'p1', name: 'Page One' }],
              paging: {
                next: 'https://graph.facebook.com/v26.0/me/accounts?after=cursor123',
              },
            }),
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: 'p2', name: 'Page Two' }],
          }),
        } as Response;
      };

      const result = await fetchAllFacebookPages('test-token', 'id,name', 5, mockFetch as any);
      expect(callCount).toBe(2);
      expect(result.pages).toHaveLength(2);
      expect(result.pages.map((p) => p.id)).toEqual(['p1', 'p2']);
      expect(result.truncated).toBe(false);
      expect(result.partial).toBe(false);
    });

    it('stops after maxPages limit is reached', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: `p${callCount}`, name: `Page ${callCount}` }],
            paging: {
              next: `https://graph.facebook.com/v26.0/me/accounts?after=cursor${callCount}`,
            },
          }),
        } as Response;
      };

      const result = await fetchAllFacebookPages('test-token', 'id,name', 2, mockFetch as any);
      expect(callCount).toBe(2);
      expect(result.pages).toHaveLength(2);
      // R14: the cap stopped us while Facebook still had another
      // page waiting, so the list must say it is truncated.
      expect(result.truncated).toBe(true);
      expect(result.partial).toBe(false);
    });

    it('throws when graph API returns an error response', async () => {
      const mockFetch = async () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      await expect(
        fetchAllFacebookPages('bad-token', 'id,name', 5, mockFetch as any)
      ).rejects.toThrow('Facebook Graph API returned 401');
    });

    it('reports a partial list (not a throw, not a complete list) when a mid-list page fails', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: 'p1', name: 'Page One' }],
              paging: {
                next: 'https://graph.facebook.com/v26.0/me/accounts?after=cursor1',
              },
            }),
          } as Response;
        }
        return {
          ok: false,
          status: 500,
          statusText: 'Server Error',
        } as Response;
      };

      const result = await fetchAllFacebookPages('test-token', 'id,name', 5, mockFetch as any);
      expect(callCount).toBe(2);
      expect(result.pages).toHaveLength(1);
      expect(result.pages[0]?.id).toBe('p1');
      // R14: the fetched prefix is kept, but it must not present
      // as the account's complete list. Unified semantics: the
      // error case is BOTH truncated (either-cause flag) and
      // partial (error-only flag) — the discover payload splits
      // them back into capped vs error warnings.
      expect(result.partial).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.truncationReason).toBe('page_error');
    });
  });

  // Unified helper (BG6 + R14 merged): truncation must be
  // reported, never silently complete.
  describe('fetchAllFacebookPages truncation', () => {
    it('reports page_limit when the cap is hit with a cursor remaining', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{ id: `p${callCount}`, name: `Page ${callCount}` }],
            paging: {
              next: `https://graph.facebook.com/v26.0/me/accounts?after=cursor${callCount}`,
            },
          }),
        } as Response;
      };

      const result = await fetchAllFacebookPages(
        'test-token',
        'id,name',
        2,
        mockFetch as any
      );
      expect(callCount).toBe(2);
      expect(result.pages).toHaveLength(2);
      expect(result.truncated).toBe(true);
      expect(result.truncationReason).toBe('page_limit');
      expect(result.partial).toBe(false);
    });

    it('reports page_error when a later page fails, keeping the pages already fetched', async () => {
      let callCount = 0;
      const mockFetch = async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: 'p1', name: 'Page One' }],
              paging: {
                next: 'https://graph.facebook.com/v26.0/me/accounts?after=cursor1',
              },
            }),
          } as Response;
        }
        return { ok: false, status: 500 } as Response;
      };

      const result = await fetchAllFacebookPages(
        'test-token',
        'id,name',
        5,
        mockFetch as any
      );
      expect(result.pages).toHaveLength(1);
      expect(result.truncated).toBe(true);
      expect(result.truncationReason).toBe('page_error');
      expect(result.partial).toBe(true);
    });

    it('reports not truncated when the last page has no cursor', async () => {
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'p1', name: 'Page One' }] }),
      });

      const result = await fetchAllFacebookPages(
        'test-token',
        'id,name',
        5,
        mockFetch as any
      );
      expect(result.pages).toHaveLength(1);
      expect(result.truncated).toBe(false);
      expect(result.truncationReason).toBeUndefined();
      expect(result.partial).toBe(false);
    });
  });

  describe('evaluateGraphApiError classification', () => {
    it('maps code 10 and codes 200-299 to expired and invalid_token requiring reauth', () => {
      const code10 = evaluateGraphApiError(10);
      expect(code10).not.toBeNull();
      expect(code10?.accountStatus).toBe('expired');
      expect(code10?.pageStatus).toBe('invalid_token');
      expect(code10?.isTransient).toBe(false);
      expect(code10?.requiresReauth).toBe(true);

      for (const code of [200, 250, 299]) {
        const evalRes = evaluateGraphApiError(code);
        expect(evalRes?.accountStatus).toBe('expired');
        expect(evalRes?.pageStatus).toBe('invalid_token');
        expect(evalRes?.isTransient).toBe(false);
        expect(evalRes?.requiresReauth).toBe(true);
      }
    });

    it('maps duplicate code 506 to active/active without reauth', () => {
      const evalRes = evaluateGraphApiError(506);
      expect(evalRes).not.toBeNull();
      expect(evalRes?.accountStatus).toBe('active');
      expect(evalRes?.pageStatus).toBe('active');
      expect(evalRes?.isTransient).toBe(false);
      expect(evalRes?.requiresReauth).toBe(false);
      expect(evalRes?.message).toContain('duplicate');
    });

    it('maps bad link code 1609005 to active/active without reauth', () => {
      const evalRes = evaluateGraphApiError(1609005);
      expect(evalRes).not.toBeNull();
      expect(evalRes?.accountStatus).toBe('active');
      expect(evalRes?.pageStatus).toBe('active');
      expect(evalRes?.isTransient).toBe(false);
      expect(evalRes?.requiresReauth).toBe(false);
      expect(evalRes?.message).toContain('link URL');
    });
  });
});
