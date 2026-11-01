/**
 * Browser-boundary API fixtures (spec 137-A3, T33).
 *
 * `installApiFixtures` intercepts every app API call the four critical
 * flows can make and answers from the mutable fixture state, so tests can
 * assert on state changes (e.g. a post created in the composer appears in
 * the queue GET that follows). Third-party traffic (Facebook OAuth/Graph,
 * storage signed URLs) is intercepted here or in the specs via
 * `page.route` — nothing leaves the test machine.
 *
 * What still runs for real: the production build itself — routing,
 * middleware session verification, the tenant layout, every component and
 * client code path. The session cookie is a genuine signed token
 * (fixtures/tenant.ts).
 */

import type { Page, Route } from '@playwright/test';
import {
  CONNECTED_ACCOUNT,
  FACEBOOK_DESTINATION,
  FACEBOOK_PAGE,
  mediaItemFixture,
  queueItemFixture,
  TENANT,
} from './tenant';

export interface FixtureState {
  accounts: Array<Record<string, unknown>>;
  queue: Array<Record<string, unknown>>;
  media: Array<Record<string, unknown>>;
  /** Paths of API requests no fixture handled (for debugging failures). */
  unhandled: string[];
}

export function createFixtureState(
  initial: Partial<FixtureState> = {}
): FixtureState {
  return {
    accounts: [],
    queue: [],
    media: [],
    unhandled: [],
    ...initial,
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * Paginated fixture list, mirroring the production list contract
 * (page/limit/totalPages alongside total). The client now sends
 * ?page=&limit= (plus search/status/account filters) on every list
 * read, so fixtures must answer on the exact pathname — a bare glob
 * for the list path does NOT match a URL carrying a query string,
 * and the request would fall through to the catch-all empty object.
 * The filter mirrors the production list semantics: search matches
 * the display name, status matches exactly (or the needs_attention
 * group for pages), account matches display name or account id.
 */
export function paginateFixtureList<T extends Record<string, unknown>>(
  route: Route,
  items: T[],
  filter: (item: T, params: URLSearchParams) => boolean
): { items: T[]; total: number; page: number; limit: number; totalPages: number } {
  const params = new URL(route.request().url()).searchParams;
  const filtered = items.filter((item) => filter(item, params));
  const limitRaw = Number.parseInt(params.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? limitRaw : 30;
  const pageRaw = Number.parseInt(params.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const totalPages = Math.max(1, Math.ceil(filtered.length / limit));
  const clamped = Math.min(page, totalPages);
  return {
    items: filtered.slice((clamped - 1) * limit, clamped * limit),
    total: filtered.length,
    page: clamped,
    limit,
    totalPages,
  };
}

function filterFixturePages(
  page: Record<string, unknown>,
  params: URLSearchParams
): boolean {
  const search = params.get('search')?.trim().toLowerCase();
  if (search && !String(page.pageName ?? '').toLowerCase().includes(search)) {
    return false;
  }
  const status = params.get('status');
  if (status && status !== 'all') {
    if (status === 'needs_attention') {
      if (
        !['invalid_token', 'page_checkpoint', 'fb_rate_limited'].includes(
          String(page.status ?? '')
        )
      ) {
        return false;
      }
    } else if (page.status !== status) {
      return false;
    }
  }
  const account = params.get('account');
  if (account && account !== 'all') {
    if (
      page.accountDisplayName !== account &&
      page.facebookAccountId !== account
    ) {
      return false;
    }
  }
  return true;
}

function filterFixtureAccounts(
  account: Record<string, unknown>,
  params: URLSearchParams
): boolean {
  const search = params.get('search')?.trim().toLowerCase();
  if (
    search &&
    !String(account.displayName ?? '').toLowerCase().includes(search)
  ) {
    return false;
  }
  const status = params.get('status');
  if (status && status !== 'all' && account.status !== status) {
    return false;
  }
  return true;
}

const SUB = TENANT.subdomain;

export async function installApiFixtures(
  page: Page,
  state: FixtureState
): Promise<void> {
  // Registered FIRST so the specific handlers below take precedence
  // (Playwright matches routes in reverse registration order). Any API
  // call without a fixture gets an empty 200 and is recorded.
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    state.unhandled.push(`${route.request().method()} ${url.pathname}`);
    return json(route, {});
  });

  // Settings: BYOC Facebook app configured (gates the connect modal).
  await page.route(`**/api/tenant/${SUB}/settings/byoc`, (route) =>
    json(route, {
      workspaceId: '11111111-1111-4111-8111-111111111111',
      subdomain: SUB,
      fbAppId: '123456789012345',
      fbAppSecretHint: '••••cret',
      fbAppName: 'E2E Facebook App',
      hasSecret: true,
      status: 'valid',
      lastTestedAt: null,
      connectedAt: null,
    })
  );

  // Accounts list (connect flow reads its post-connect state from here).
  // Exact-pathname predicate: the client sends ?page=&limit=, which a
  // bare glob would not match (see paginateFixtureList).
  await page.route(
    (url) => url.pathname === `/api/tenant/${SUB}/accounts`,
    (route) => {
      const { items, total, page, limit, totalPages } =
        paginateFixtureList(
          route,
          state.accounts as Array<Record<string, unknown>>,
          filterFixtureAccounts
        );
      return json(route, { accounts: items, total, page, limit, totalPages });
    }
  );
  await page.route(`**/api/tenant/${SUB}/accounts/magic-link`, (route) =>
    json(route, { magicUrl: 'https://connect.e2e.invalid/magic' })
  );

  // Unified social accounts list: the composer's destination
  // resolution reads the Facebook destination from here (its external
  // id is the seeded page's Facebook id).
  await page.route(`**/api/tenant/${SUB}/accounts/social`, (route) =>
    json(route, {
      accounts: [
        {
          id: CONNECTED_ACCOUNT.id,
          platform: 'facebook',
          externalAccountId: CONNECTED_ACCOUNT.fbAccountId,
          displayName: CONNECTED_ACCOUNT.displayName,
          avatarUrl: null,
          status: 'active',
          tokenExpiresAt: CONNECTED_ACCOUNT.tokenExpiresAt,
          destinations: [FACEBOOK_DESTINATION],
        },
      ],
    })
  );

  // Pages: the page-detail route and the fallback list.
  // Schema-complete for the typed client (spec 131 PR-131-3): the
  // detail response carries `queueCounts`, and the page view carries
  // the fields PageDetailResponseSchema / ListFacebookPagesResponseSchema
  // require.
  const completePage = {
    ...FACEBOOK_PAGE,
    followersCount: FACEBOOK_PAGE.currentFollowers,
    tasks: [],
    updatedAt: FACEBOOK_PAGE.createdAt,
  };
  await page.route(`**/api/tenant/${SUB}/pages/${FACEBOOK_PAGE.id}`, (route) =>
    json(route, {
      page: completePage,
      queueCounts: { queued: 0, publishing: 0, published: 0, failed: 0 },
    })
  );
  await page.route(
    (url) => url.pathname === `/api/tenant/${SUB}/pages`,
    (route) => {
      // Schema-complete for the typed client (spec 131 PR-131-2): the
      // list response carries `total`, and the page view carries the
      // fields ListFacebookPagesResponseSchema requires.
      const { items, total, page, limit, totalPages } =
        paginateFixtureList(
          route,
          [
            {
              ...FACEBOOK_PAGE,
              followersCount: FACEBOOK_PAGE.currentFollowers,
              tasks: [],
              updatedAt: FACEBOOK_PAGE.createdAt,
            } as Record<string, unknown>,
          ],
          filterFixturePages
        );
      return json(route, { pages: items, total, page, limit, totalPages });
    }
  );

  // Page insights (rebuilt 2026-10-27): schema-complete response in the
  // new PageInsightsResponseSchema shape so the insights tab renders its
  // content state in the click-through flow.
  await page.route(
    `**/api/tenant/${SUB}/pages/${FACEBOOK_PAGE.id}/insights**`,
    (route) =>
      json(route, {
        success: true,
        pageId: FACEBOOK_PAGE.id,
        range: '28d',
        fetchedAt: new Date().toISOString(),
        kpis: {
          followers: 132,
          mediaViews: 540,
          uniqueViewersDailySum: 420,
          engagements: 38,
          engagementRatePct: 7,
          netFollowerGrowth: 3,
          videoWatchTimeMinutes: 90,
        },
        trend: [{ date: '2026-10-22', views: 120, viewers: 90 }],
        reactions: [
          { kind: 'like', count: 25, sharePct: 69.4 },
          { kind: 'love', count: 8, sharePct: 22.2 },
          { kind: 'wow', count: 2, sharePct: 5.6 },
          { kind: 'haha', count: 1, sharePct: 2.8 },
          { kind: 'sad', count: 0, sharePct: 0 },
          { kind: 'angry', count: 0, sharePct: 0 },
        ],
        topCountries: [{ name: 'United States', count: 60, sharePct: 45 }],
        topCities: [{ name: 'New York, NY', count: 20, sharePct: 15 }],
      })
  );
  // One active daily 09:00 UTC slot: the composer's default intent is
  // "queue" and a covering slot exists for every format.
  await page.route(`**/api/tenant/${SUB}/pages/${FACEBOOK_PAGE.id}/slots`, (route) =>
    json(route, {
      slots: ['09:00', '10:00'].map((slotTime, i) => ({
        id: `66666666-6666-4666-8666-66666666666${i}`,
        userId: TENANT.userId,
        pageId: FACEBOOK_PAGE.id,
        slotTime,
        timezone: 'UTC',
        isActive: true,
        allowedFormats: ['text', 'image', 'video', 'reel', 'story'],
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
      })),
      total: 2,
    })
  );

  // Publishing queue: list + create. A created post is prepended to the
  // fixture state, so the queue refetch after submit returns it — the
  // composer→queue assertion reads real app rendering of that state.
  // The list honors the panel's status filter and pagination: when the
  // caller sends no limit (the shell's summary query), the full list
  // is returned, preserving the composer behaviour. Counts are computed
  // from the full fixture state, like the real API's page-wide counts.
  await page.route(`**/api/tenant/${SUB}/publishing/queue**`, async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const item = queueItemFixture({
        caption: typeof body.caption === 'string' ? body.caption : '',
        postFormat: typeof body.postFormat === 'string' ? body.postFormat : 'text',
        scheduledTime:
          typeof body.scheduledTime === 'string'
            ? body.scheduledTime
            : '2026-12-01T09:00:00.000Z',
      });
      state.queue = [item, ...state.queue];
      return json(route, item, 201);
    }
    const url = new URL(req.url());
    const status = url.searchParams.get('status');
    const filtered = status
      ? state.queue.filter((q) => q.status === status)
      : [...state.queue];
    const limitParam = url.searchParams.get('limit');
    const offsetParam = url.searchParams.get('offset');
    const limit = limitParam === null ? filtered.length : Number(limitParam);
    const offset = offsetParam === null ? 0 : Number(offsetParam);
    const count = (value: string) => state.queue.filter((q) => q.status === value).length;
    return json(route, {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      limit,
      offset,
      queuedCount: count('queued'),
      publishedCount: count('published'),
      failedCount: count('failed'),
      cancelledCount: count('cancelled'),
      skippedCount: count('skipped'),
    });
  });

  // Per-item queue actions (spec 134 PR-134-1 fixture addition): PATCH
  // applies the body to the fixture item (reorder/reschedule/retry read
  // it back on refetch), DELETE removes it, publish-now acks. Registered
  // after the list handler so it wins for item paths.
  await page.route(`**/api/tenant/${SUB}/publishing/queue/*`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const itemId = url.pathname.split('/publishing/queue/')[1] ?? '';
    if (req.method() === 'PATCH') {
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      const idx = state.queue.findIndex((q) => q.id === itemId);
      if (idx >= 0) {
        state.queue[idx] = { ...state.queue[idx], ...body };
        return json(route, state.queue[idx]);
      }
      return json(route, { error: 'Queue item not found' }, 404);
    }
    if (req.method() === 'DELETE') {
      state.queue = state.queue.filter((q) => q.id !== itemId);
      return json(route, { success: true, itemId });
    }
    return json(route, {});
  });

  // Queue reorder (Queue section rebuild): POST reorders the fixture
  // queue per body.itemIds and acks the contracts shape. Registered
  // AFTER the per-item handler so it wins over the `publishing/queue/*`
  // glob, which would otherwise swallow the reorder path.
  await page.route(`**/api/tenant/${SUB}/publishing/queue/reorder`, async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    const ids = Array.isArray(body.itemIds) ? (body.itemIds as string[]) : [];
    const byId = new Map(state.queue.map((q) => [q.id as string, q]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((q) => q !== undefined);
    const rest = state.queue.filter((q) => !ids.includes(q.id as string));
    state.queue = [...ordered, ...rest];
    return json(route, { success: true, itemIds: ids });
  });

  // Destination-scoped queue retry (Queue section rebuild): a failed
  // item goes back to queued, keeping its place in the fixture list.
  await page.route(`**/api/tenant/${SUB}/destinations/*/queue/*/retry`, async (route) => {
    const url = new URL(route.request().url());
    const itemId = url.pathname.split('/queue/')[1]?.split('/')[0] ?? '';
    const idx = state.queue.findIndex((q) => q.id === itemId);
    if (idx >= 0) {
      state.queue[idx] = { ...state.queue[idx], status: 'queued' };
      return json(route, state.queue[idx]);
    }
    return json(route, { error: 'Queue item not found' }, 404);
  });

  // Unified destination enqueue (Phase 7 G4 retarget): the composer +
  // bulk create paths POST here now. The created item joins the same
  // fixture queue state (in the legacy list shape the queue panel still
  // reads), so composer→queue assertions read real app rendering of it,
  // and the response carries the contracts enqueue shape the typed
  // client validates.
  await page.route(`**/api/tenant/${SUB}/publishing/destination-queue`, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return json(route, {});
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    const kind = typeof body.kind === 'string' ? body.kind : 'text';
    const platformFormat =
      typeof body.platformFormat === 'string' ? body.platformFormat : null;
    const scheduledTime =
      typeof body.scheduledAt === 'string' ? body.scheduledAt : '2026-12-01T09:00:00.000Z';
    const item = queueItemFixture({
      caption: typeof body.caption === 'string' ? body.caption : '',
      postFormat: platformFormat ?? kind,
      scheduledTime,
      mediaId:
        Array.isArray(body.mediaItemIds) && typeof body.mediaItemIds[0] === 'string'
          ? body.mediaItemIds[0]
          : null,
    });
    state.queue = [item, ...state.queue];
    return json(
      route,
      {
        id: item.id,
        workspaceId: '99999999-9999-4999-8999-999999999999',
        destinationId: FACEBOOK_DESTINATION.id,
        platform: 'facebook',
        kind,
        platformFormat,
        status: 'queued',
        scheduledTime,
        slotId: null,
        createdAt: '2026-10-20T00:00:00.000Z',
      },
      201
    );
  });

  // Media library: list, folders, and the import pipeline
  // (check-duplicates → upload-url → signed PUT → confirm).
  // PR-133-1: the library now reads through the typed client, whose
  // schemas require the full list envelopes the real API returns —
  // the fixtures serve those shapes (folders + unorganizedCount;
  // items + total/limit/offset/nextCursor).
  await page.route(`**/api/tenant/${SUB}/media/folders`, (route) =>
    json(route, { folders: [], unorganizedCount: 0 })
  );
  await page.route(`**/api/tenant/${SUB}/media/check-duplicates`, (route) =>
    json(route, { duplicates: [] })
  );
  await page.route(`**/api/tenant/${SUB}/media/upload-url`, (route) => {
    const item = mediaItemFixture();
    return json(route, {
      mediaId: item.id,
      mediaKey: item.storageKey,
      mediaUploadUrl: 'https://storage.e2e.invalid/put/e2e-sunset.png',
      thumbnailUploadUrl: 'https://storage.e2e.invalid/put/e2e-sunset-thumb.webp',
      thumbnailKey: 'e2e/e2e-sunset-thumb.webp',
      publicMediaUrl: item.url,
      publicThumbnailUrl: 'https://storage.e2e.invalid/e2e/e2e-sunset-thumb.webp',
      // The real route returns this (900s presign lifetime); PR-133-4's
      // engine validates the response through the typed client's
      // UploadUrlResponseSchema, which requires it.
      expiresInSeconds: 900,
    });
  });
  await page.route(`**/api/tenant/${SUB}/media/confirm`, (route) => {
    const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    const item = mediaItemFixture({
      name: typeof body.name === 'string' ? body.name : 'e2e-sunset.png',
      captionText:
        typeof body.captionText === 'string' ? body.captionText : null,
    });
    state.media = [item, ...state.media.filter((m) => m.id !== item.id)];
    return json(route, item);
  });
  await page.route(/\/api\/tenant\/[^/]+\/media\?/, (route) =>
    json(route, {
      items: state.media,
      total: state.media.length,
      limit: 500,
      offset: 0,
      nextCursor: null,
    })
  );
  await page.route(`**/api/tenant/${SUB}/media`, (route) =>
    json(route, {
      items: state.media,
      total: state.media.length,
      limit: 500,
      offset: 0,
      nextCursor: null,
    })
  );
  // Single-item PATCH (caption edits — inline, preview save, and the
  // batch-caption flow, which PATCHes each selected item; PR-133-3).
  // Registered after the collection routes above; non-PATCH requests
  // fall back to them (folders, check-duplicates, upload-url, …).
  await page.route(`**/api/tenant/${SUB}/media/*`, async (route) => {
    const req = route.request();
    if (req.method() !== 'PATCH') return route.fallback();
    const id = new URL(req.url()).pathname.split('/').at(-1);
    const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
    const index = state.media.findIndex((m) => m.id === id);
    if (index === -1) return json(route, { error: 'not found' }, 404);
    const updated = {
      ...state.media[index],
      ...(typeof body.captionText === 'string'
        ? { captionText: body.captionText }
        : {}),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
    };
    state.media[index] = updated;
    return json(route, updated);
  });

  // Storage signed URLs: the PUT itself is answered 200 — no real storage.
  await page.route('https://storage.e2e.invalid/**', (route) =>
    route.fulfill({ status: 200, body: '' })
  );
}

export { CONNECTED_ACCOUNT };
