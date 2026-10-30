/**
 * Query-key factory (spec 137 §3.2.3) — the ONLY source of React Query
 * cache keys in the app.
 *
 * Keys are hierarchical and tenant-scoped:
 * `['tenant', subdomain, 'pages', pageId, 'slots']`. Every consumer
 * (queries, mutations, invalidation, server prefetch + dehydration)
 * builds its keys here — never as string literals at call sites — so
 * every copy of the same data ages and invalidates together.
 */

export const queryKeys = {
  /** Root of the whole tenant cache. */
  all: ['tenant'] as const,

  tenant: (subdomain: string) => {
    const tenantRoot = ['tenant', subdomain] as const;
    return {
      all: tenantRoot,

      accounts: {
        all: [...tenantRoot, 'accounts'] as const,
        list: [...tenantRoot, 'accounts', 'list'] as const,
        /**
         * R16: the Pages shell's filter options need EVERY account,
         * not page 1 of the paginated accounts view. This key holds
         * that complete set (fetched page by page under the hood);
         * it stays under `list`, so accounts-list invalidation
         * (e.g. disconnect) refreshes it too.
         */
        listAll: [...tenantRoot, 'accounts', 'list', 'all'] as const,
        /** Paginated list key: page + limit + filters, so each page caches separately. */
        listPage: (params: {
          page: number;
          limit: number;
          search: string;
          status: string;
        }) => [...tenantRoot, 'accounts', 'list', params] as const,
        socialList: [...tenantRoot, 'accounts', 'social'] as const,
        detail: (accountId: string) =>
          [...tenantRoot, 'accounts', accountId] as const,
      },

      /**
       * Threads accounts list. A SEPARATE namespace from Facebook's
       * `accounts` keys on purpose: the two lists share the same
       * params shape, so reusing the Facebook key would serve
       * Facebook rows to the Threads page (and vice versa) from
       * the cache.
       */
      threadsAccounts: {
        all: [...tenantRoot, 'threads', 'accounts'] as const,
        list: [...tenantRoot, 'threads', 'accounts', 'list'] as const,
        /** Paginated list key: page + limit + filters, so each page caches separately. */
        listPage: (params: {
          page: number;
          limit: number;
          search: string;
          status: string;
        }) => [...tenantRoot, 'threads', 'accounts', 'list', params] as const,
      },

      pages: {
        all: [...tenantRoot, 'pages'] as const,
        list: [...tenantRoot, 'pages', 'list'] as const,
        /** Paginated list key: page + limit + filters, so each page caches separately. */
        listPage: (params: {
          page: number;
          limit: number;
          search: string;
          status: string;
          account: string;
        }) => [...tenantRoot, 'pages', 'list', params] as const,
        detail: (pageId: string) =>
          [...tenantRoot, 'pages', pageId] as const,
        slots: (pageId: string) =>
          [...tenantRoot, 'pages', pageId, 'slots'] as const,
      },

      /** Instagram Schedule: a separate namespace from Instagram
       * Accounts, so schedule rows never collide with account rows
       * in the cache. */
      instagramSchedule: {
        all: [...tenantRoot, 'instagram', 'schedule'] as const,
        list: [...tenantRoot, 'instagram', 'schedule', 'list'] as const,
        listPage: (params: {
          page: number;
          limit: number;
          search: string;
          status: string;
          account: string;
        }) => [...tenantRoot, 'instagram', 'schedule', 'list', params] as const,
        detail: (destinationId: string) =>
          [...tenantRoot, 'instagram', 'schedule', destinationId] as const,
        slots: (destinationId: string) =>
          [...tenantRoot, 'instagram', 'schedule', destinationId, 'slots'] as const,
        queue: (destinationId: string, params: Record<string, string>) =>
          [...tenantRoot, 'instagram', 'schedule', destinationId, 'queue', params] as const,
      },

      tiktokMirrors: {
        all: [...tenantRoot, 'tiktok-mirrors'] as const,
        list: [...tenantRoot, 'tiktok-mirrors', 'list'] as const,
        listPage: (params: { page: number }) =>
          [...tenantRoot, 'tiktok-mirrors', 'list', params] as const,
        detail: (mirrorId: string) =>
          [...tenantRoot, 'tiktok-mirrors', mirrorId] as const,
      },

      /**
       * Instagram Auto Repost mirrors. A separate key family from
       * tiktokMirrors (which carries no platform): reusing it would
       * collide the Facebook and Instagram list caches.
       */
      instagramAutoRepost: {
        all: [...tenantRoot, 'instagram-auto-repost'] as const,
        list: [...tenantRoot, 'instagram-auto-repost', 'list'] as const,
        listPage: (params: { page: number }) =>
          [...tenantRoot, 'instagram-auto-repost', 'list', params] as const,
        detail: (mirrorId: string) =>
          [...tenantRoot, 'instagram-auto-repost', mirrorId] as const,
      },

      destinations: {
        all: [...tenantRoot, 'destinations'] as const,
        detail: (destinationId: string) =>
          [...tenantRoot, 'destinations', destinationId] as const,
        // K10: the destinations queue key was deleted with the
        // destinations queue-list route it invalidated — no UI
        // queried that list (the Pages section uses queue.items).
        /** Unified posting slots for one destination (spec 134 PR-134-3). */
        slots: (destinationId: string) =>
          [...tenantRoot, 'destinations', destinationId, 'posting-slots'] as const,
      },

      queue: {
        all: [...tenantRoot, 'queue'] as const,
        items: (pageId: string) =>
          [...tenantRoot, 'queue', pageId, 'items'] as const,
        statusCounts: (pageId: string) =>
          [...tenantRoot, 'queue', pageId, 'status-counts'] as const,
      },

      media: {
        all: [...tenantRoot, 'media'] as const,
        list: [...tenantRoot, 'media', 'list'] as const,
        folders: [...tenantRoot, 'media', 'folders'] as const,
        detail: (mediaId: string) =>
          [...tenantRoot, 'media', mediaId] as const,
      },

      downloader: {
        all: [...tenantRoot, 'downloader'] as const,
        jobs: [...tenantRoot, 'downloader', 'jobs'] as const,
        job: (jobId: string) =>
          [...tenantRoot, 'downloader', 'jobs', jobId] as const,
      },

      settings: {
        all: [...tenantRoot, 'settings'] as const,
        byoc: [...tenantRoot, 'settings', 'byoc'] as const,
        platformCredentials: (platform: string) =>
          [...tenantRoot, 'settings', 'platform-credentials', platform] as const,
      },

      insights: {
        all: [...tenantRoot, 'insights'] as const,
        page: (pageId: string, range: string) =>
          [...tenantRoot, 'insights', pageId, range] as const,
      },

      workspaces: {
        all: [...tenantRoot, 'workspaces'] as const,
        list: [...tenantRoot, 'workspaces', 'list'] as const,
      },
    };
  },
};

export type TenantQueryKeys = ReturnType<typeof queryKeys.tenant>;
