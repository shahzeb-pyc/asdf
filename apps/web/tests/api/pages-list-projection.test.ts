/**
 * Pages list projection tests (spec 211).
 *
 * The Supabase path must select only the metadata keys the list renders
 * — never the whole `metadata` object — while the wire rows still carry
 * every field the screen renders. The mock double
 * (`mock-supabase-pages.ts`) applies the recorded select list
 * PostgREST-style, so a key the route stops selecting arrives as
 * `undefined` and the assertions below fail: this test fails on the old
 * whole-`metadata` select only via the select-string assertions, and
 * fails on a dropped key via the wire-field assertions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { signSessionToken } from '@fbuploadpro/contracts';
import { handleListPages } from '../../src/app/api/tenant/[subdomain]/pages/route';
import { createMockSupabasePages } from '../helpers/mock-supabase-pages';

const TEST_SECRET = 'super-secret-session-signing-key-minimum-32-chars-long';
const userId = '11111111-1111-4111-a111-111111111111';
const accountId = '22222222-2222-4222-a222-222222222222';

const ACTIVE_ID = '33333333-3333-4333-a333-333333333333';
const PAUSED_ID = '44444444-4444-4334-a444-444444444444';
const DISCONNECTED_ID = '55555555-5555-4335-a555-555555555555';
const RATE_LIMITED_ID = '66666666-6666-4336-a666-666666666666';

describe('Pages list slim projection (spec 211)', () => {
  let validSessionCookie: string;

  beforeEach(async () => {
    process.env.SESSION_SECRET = TEST_SECRET;
    const token = await signSessionToken(
      {
        userId,
        email: 'alexander@gmail.com',
        name: 'Alex Acme',
        subdomain: 'acme',
        role: 'user',
        status: 'active',
      },
      TEST_SECRET
    );
    validSessionCookie = `fbup_session=${token}`;
  });

  function listRequest() {
    return new NextRequest('http://localhost:3000/api/tenant/acme/pages', {
      headers: { cookie: validSessionCookie },
    });
  }

  it('renders every field from the slim projection and never selects whole metadata', async () => {
    const now = new Date().toISOString();
    const mockSupabase = createMockSupabasePages([
      {
        id: ACTIVE_ID,
        account_id: accountId,
        external_destination_id: 'page_active',
        name: 'Active Shop',
        avatar_url: 'https://example.com/page.jpg',
        timezone: 'Asia/Karachi',
        metadata: {
          category: 'Retail Company',
          starting_followers: 1000,
          current_followers: 1050,
          followers_updated_at: now,
          tasks: ['CREATE_CONTENT', 'MANAGE'],
          unmatched_post_types: ['story'],
          rate_limited_at: null,
          fb_status: null,
          // Wide keys the list never renders — must not be fetched.
          claim_limits: [{ metric: 'calls', window_seconds: 60, cap: 5 }],
        },
        status: 'active',
        section: 'schedule',
        created_at: '2026-10-10T10:00:00.000Z',
        updated_at: now,
        social_accounts: {
          display_name: 'Alex Marketing',
          avatar_url: 'https://example.com/account.jpg',
        },
      },
      {
        id: PAUSED_ID,
        account_id: accountId,
        external_destination_id: 'page_paused',
        name: 'Paused Shop',
        avatar_url: null,
        timezone: 'Asia/Karachi',
        metadata: { fb_status: 'paused', category: 'Retail Company' },
        status: 'disconnected',
        section: 'schedule',
        created_at: '2026-10-09T10:00:00.000Z',
        updated_at: now,
        social_accounts: { display_name: 'Alex Marketing', avatar_url: null },
      },
      {
        id: DISCONNECTED_ID,
        account_id: accountId,
        external_destination_id: 'page_gone',
        name: 'Removed Shop',
        avatar_url: null,
        timezone: 'Asia/Karachi',
        metadata: { category: 'Retail Company' },
        status: 'disconnected',
        section: 'schedule',
        created_at: '2026-10-08T10:00:00.000Z',
        updated_at: now,
        social_accounts: { display_name: 'Alex Marketing', avatar_url: null },
      },
      {
        id: RATE_LIMITED_ID,
        account_id: accountId,
        external_destination_id: 'page_limited',
        name: 'Limited Shop',
        avatar_url: null,
        timezone: 'Asia/Karachi',
        metadata: {
          category: 'Retail Company',
          rate_limited_at: now,
        },
        status: 'rate_limited',
        section: 'schedule',
        created_at: '2026-10-07T10:00:00.000Z',
        updated_at: now,
        social_accounts: { display_name: 'Alex Marketing', avatar_url: null },
      },
    ]);

    const res = await handleListPages(listRequest(), 'acme', mockSupabase as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    const byId = new Map<string, Record<string, unknown>>(
      (json.pages as Array<Record<string, unknown>>).map((p) => [p.id as string, p])
    );

    // The disconnected non-paused page stays hidden; the paused one lists.
    expect(byId.has(DISCONNECTED_ID)).toBe(false);
    expect(byId.has(PAUSED_ID)).toBe(true);
    expect(byId.has(ACTIVE_ID)).toBe(true);
    expect(byId.has(RATE_LIMITED_ID)).toBe(true);

    const active = byId.get(ACTIVE_ID) as Record<string, unknown>;
    expect(active.pageName).toBe('Active Shop');
    expect(active.fbPageId).toBe('page_active');
    expect(active.facebookAccountId).toBe(accountId);
    expect(active.accountDisplayName).toBe('Alex Marketing');
    expect(active.accountPictureUrl).toBe('https://example.com/account.jpg');
    expect(active.profilePictureUrl).toBe('https://example.com/page.jpg');
    expect(active.timezone).toBe('Asia/Karachi');
    expect(active.category).toBe('Retail Company');
    expect(active.startingFollowers).toBe(1000);
    expect(active.currentFollowers).toBe(1050);
    expect(active.followersGained).toBe(50);
    // followers_updated_at is selected (parity with the SQL path,
    // which computes the same field) but the wire schema
    // (FacebookPageViewSchema) carries no followersUpdatedAt field —
    // the screen's "Updated" label reads rateLimitedAt instead.
    expect(active.rateLimitedAt).toBeNull();
    expect(active.status).toBe('active');
    expect(active.tasks).toEqual(['CREATE_CONTENT', 'MANAGE']);
    expect(active.unmatchedPostTypes).toEqual(['story']);
    expect(active.createdAt).toBe('2026-10-10T10:00:00.000Z');

    expect(byId.get(PAUSED_ID)?.status).toBe('paused');
    expect(byId.get(RATE_LIMITED_ID)?.status).toBe('fb_rate_limited');
    expect(byId.get(RATE_LIMITED_ID)?.rateLimitedAt).toBe(now);

    // No data select requests the whole metadata object: every
    // `metadata` token in a select is a `metadata->key` projection.
    // (The `'*'` head/count selects carry no rows and are exempt.)
    const dataSelects = mockSupabase.selects.filter((s) => s !== '*');
    expect(dataSelects.length).toBeGreaterThan(0);
    for (const select of dataSelects) {
      const withoutProjections = select.replace(/metadata->>?[A-Za-z0-9_]+/g, '');
      expect(withoutProjections).not.toContain('metadata');
    }
    // And the rendered keys are actually projected.
    const joined = dataSelects.join(',');
    for (const key of [
      'metadata->category',
      'metadata->starting_followers',
      'metadata->current_followers',
      'metadata->followers_updated_at',
      'metadata->tasks',
      'metadata->unmatched_post_types',
      'metadata->rate_limited_at',
      'metadata->fb_status',
    ]) {
      expect(joined).toContain(key);
    }
  });

  it('metacharacter-search fallback also uses the slim projection', async () => {
    const now = new Date().toISOString();
    const mockSupabase = createMockSupabasePages([
      {
        id: ACTIVE_ID,
        account_id: accountId,
        external_destination_id: 'old_page',
        name: 'Old,Page Shop',
        avatar_url: null,
        timezone: 'Asia/Karachi',
        metadata: { category: 'Shop', starting_followers: 5, current_followers: 7 },
        status: 'active',
        section: 'schedule',
        created_at: '2025-01-01T10:00:00.000Z',
        updated_at: now,
        social_accounts: { display_name: 'Alex', avatar_url: null },
      },
    ]);
    const req = new NextRequest(
      'http://localhost:3000/api/tenant/acme/pages?search=Old%2CPage',
      { headers: { cookie: validSessionCookie } }
    );
    const res = await handleListPages(req, 'acme', mockSupabase as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.total).toBe(1);
    expect(json.pages[0].pageName).toBe('Old,Page Shop');
    expect(json.pages[0].category).toBe('Shop');
    expect(json.pages[0].startingFollowers).toBe(5);
    expect(json.pages[0].currentFollowers).toBe(7);
    const dataSelects = mockSupabase.selects.filter((s) => s !== '*');
    expect(dataSelects.length).toBeGreaterThan(0);
    for (const select of dataSelects) {
      expect(select.replace(/metadata->>?[A-Za-z0-9_]+/g, '')).not.toContain('metadata');
    }
  });
});
