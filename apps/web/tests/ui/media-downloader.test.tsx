/**
 * @file media-downloader.test.tsx
 * @description Comprehensive UI & behavioral tests for Spec 031:
 * Cloud Media Downloader, Auto-Provisioned 'Downloads' Default Folder,
 * Nested Folder Selection & Inline 'New Folder' Creation, Intra-Batch URL
 * Deduplication, Unified Batch Progress Bar, Recent Downloads List with
 * Auto-Populated Captions, 'Open in Folder' Navigation, and Failed Link 'Retry'.
 *
 * Spec 140 PR-140-2 setup: the legacy `initial*` test-only prop API died
 * with the old component. The rebuilt surface
 * (`downloader-surface.tsx`) is rendered into jsdom through the
 * PR-140-1 data-layer pattern — a QueryClientProvider plus a fetch stub
 * serving the typed client's API responses — and driven with
 * user-event. Assertions are the pre-rebuild ones, re-expressed against
 * the live DOM (the two assertions that read legacy inline-style values
 * out of the static markup — a `border-radius` style and the raw
 * PALETTE hex — are replaced by their post-rebuild equivalents: the
 * palette hex must NOT appear in the rendered markup at all, because
 * styling now comes from token classes; the capsule-pill ban is kept).
 *
 * Spec 140 PR-140-4 (T22): the behavioural migration is completed here.
 * Every §3 parity item is driven through real interactions (surface
 * tests) or through the data module's public entry points with a
 * controllable fetch seam (batch-engine tests), including the amended
 * OD-140-1 contract — max 3 ingests in flight, per-item progress
 * preserved under concurrency, per-item failure isolation, abort that
 * leaves saved items saved and starts no new items, and Recent-list
 * order matching batch order under out-of-order completion — and the
 * OD-140-2 mount-hydration assertion. The PR-140-2 verification gate's
 * named gaps (abort behaviour, retry-failure path, UI-level
 * input-clearing) are covered by the PR-140-4 describes below.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MediaFolder, MediaItemResponse } from '@fbuploadpro/contracts';
import { PALETTE } from '@/lib/theme';
import { DownloaderSurface } from '@/components/downloader/downloader-surface';
import {
  initializeDownloaderFolders,
  createDownloaderFolder,
  executeDownloaderBatch,
  retryFailedDownloadEntry,
  useDownloaderFolders,
  type DownloaderBatchProgressState,
  type DownloaderFailedEntry,
} from '@/components/downloader/downloader-data';
import {
  mediaFoldersQuery,
  useMediaFolders,
} from '@/components/media/media-data';
import { createQueryClient } from '@/lib/data/query-client';
import {
  validateDownloaderBatchInput,
  buildMediaFolderHref,
} from '@/components/downloader/media-downloader-helpers';

// userEvent interaction tests run long under coverage instrumentation;
// the per-test budget below replaces the 5s default for this file's
// interaction cases only (assertions and waits are unchanged).
const INTERACTION_TIMEOUT = 20_000;

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
  }),
  useParams: () => ({
    subdomain: 'acme',
  }),
}));

const SAMPLE_FOLDERS: MediaFolder[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    userId: '00000000-0000-4000-8000-000000000001',
    parentId: null,
    name: 'Downloads',
    itemCount: 3,
    subfolderCount: 0,
    createdAt: '2026-10-11T08:00:00.000Z',
    updatedAt: '2026-10-11T08:00:00.000Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    userId: '00000000-0000-4000-8000-000000000001',
    parentId: null,
    name: 'Campaign A',
    itemCount: 2,
    subfolderCount: 1,
    createdAt: '2026-10-11T08:05:00.000Z',
    updatedAt: '2026-10-11T08:05:00.000Z',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    userId: '00000000-0000-4000-8000-000000000001',
    parentId: '22222222-2222-4222-8222-222222222222',
    name: 'TikTok Reels',
    itemCount: 5,
    subfolderCount: 0,
    createdAt: '2026-10-11T08:10:00.000Z',
    updatedAt: '2026-10-11T08:10:00.000Z',
  },
];

const SAMPLE_DOWNLOADED_ITEMS: MediaItemResponse[] = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    userId: '00000000-0000-4000-8000-000000000001',
    folderId: '11111111-1111-4111-8111-111111111111',
    name: 'tiktok_creator_hook.mp4',
    mediaType: 'video',
    mimeType: 'video/mp4',
    fileSize: 12582912, // 12.0 MB
    storageKey: 'users/u1/media/tiktok_creator_hook.mp4',
    url: 'https://media.fbuploadpro.com/users/u1/media/tiktok_creator_hook.mp4',
    thumbnailKey: 'users/u1/thumbnails/tiktok_creator_hook.webp',
    thumbnailUrl: 'https://media.fbuploadpro.com/users/u1/thumbnails/tiktok_creator_hook.webp',
    durationSeconds: 32,
    aspectRatio: '9:16',
    captionText: 'POV: You automated your entire content calendar 🚀 #growth',
    createdAt: '2026-10-11T08:30:00.000Z',
    updatedAt: '2026-10-11T08:30:00.000Z',
  },
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    userId: '00000000-0000-4000-8000-000000000001',
    folderId: '33333333-3333-4333-8333-333333333333',
    name: 'carousel_slide_1.jpg',
    mediaType: 'image',
    mimeType: 'image/jpeg',
    fileSize: 1572864, // 1.5 MB
    storageKey: 'users/u1/media/carousel_slide_1.jpg',
    url: 'https://media.fbuploadpro.com/users/u1/media/carousel_slide_1.jpg',
    thumbnailKey: null,
    thumbnailUrl: null,
    durationSeconds: null,
    aspectRatio: '4:5',
    captionText: '5 Frameworks for High-Retention Reels',
    createdAt: '2026-10-11T08:31:00.000Z',
    updatedAt: '2026-10-11T08:31:00.000Z',
  },
];

/* ------------------------------------------------------------------ */
/* Surface render harness (data-layer mocks via a fetch stub)          */
/* ------------------------------------------------------------------ */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface SurfaceStubOptions {
  /** Stored jobs served by GET …/downloader (recent-list hydration). */
  jobs?: unknown[];
  /**
   * POST …/downloader responder; defaults to "unstubbed". Receives the
   * request init too, so a responder can honour the batch AbortSignal
   * the way a real fetch would.
   */
  onIngestPost?: (
    body: { url: string; folderId: string | null },
    init?: RequestInit
  ) => Promise<Response>;
  /** POST …/media/folders responder (folder creation); defaults to "unstubbed". */
  onFolderPost?: (body: {
    name: string;
    parentId: string | null;
  }) => Promise<Response>;
}

let downloaderPostCalls: Array<{ url: string; folderId: string | null }> = [];
let folderPostCalls: Array<{ name: string; parentId: string | null }> = [];
let downloaderGetCalls = 0;

function installSurfaceFetchStub(options: SurfaceStubOptions = {}) {
  downloaderPostCalls = [];
  folderPostCalls = [];
  downloaderGetCalls = 0;
  const jobs = options.jobs ?? [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.includes('/media/folders') && method === 'GET') {
        return jsonResponse({ folders: SAMPLE_FOLDERS, unorganizedCount: 0 });
      }
      if (url.includes('/media/folders') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          name: string;
          parentId: string | null;
        };
        folderPostCalls.push(body);
        if (options.onFolderPost) return options.onFolderPost(body);
        throw new Error('Unstubbed folder POST');
      }
      if (url.includes('/downloader') && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as {
          url: string;
          folderId: string | null;
        };
        downloaderPostCalls.push(body);
        if (options.onIngestPost) return options.onIngestPost(body, init);
        throw new Error('Unstubbed downloader POST');
      }
      if (url.includes('/downloader') && method === 'GET') {
        downloaderGetCalls += 1;
        return jsonResponse({ success: true, jobs });
      }
      const mediaMatch = /\/media\/([0-9a-f-]+)$/.exec(url);
      if (mediaMatch && method === 'GET') {
        const item = SAMPLE_DOWNLOADED_ITEMS.find((i) => i.id === mediaMatch[1]);
        if (item) return jsonResponse(item);
      }
      throw new Error(`Unstubbed fetch: ${method} ${url}`);
    })
  );
}

function renderDownloader() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <DownloaderSurface subdomain="acme" />
    </QueryClientProvider>
  );
  // The QueryClient rides along so PR-140-4 tests can observe the
  // OD-140-3 invalidation contract on the surface's own client.
  return { ...view, queryClient };
}

beforeEach(() => {
  mockPush.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Spec 031: MediaDownloader — Default Downloads Folder, Nested Folder Selection & Inline New Folder (US2)', () => {
  it('auto-selects an existing root-level Downloads folder on load without issuing a POST request', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ folders: SAMPLE_FOLDERS, unorganizedCount: 0 }),
        {
          status: 200,
        }
      );
    }) as unknown as typeof fetch;

    const result = await initializeDownloaderFolders({
      subdomain: 'acme',
      fetchImpl: mockFetch,
    });

    expect(result.createdDefaultFolder).toBe(false);
    expect(result.selectedFolderId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.folders).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(
      (mockFetch as unknown as { mock: { calls: unknown[][] } }).mock
        .calls[0]?.[0]
    ).toBe('/api/tenant/acme/media/folders');
  });

  it('auto-creates a root-level Downloads folder via POST /api/tenant/acme/media/folders when not yet present and selects it', async () => {
    const foldersWithoutDownloads = SAMPLE_FOLDERS.slice(1);
    const createdDownloadsFolder: MediaFolder = {
      id: '99999999-9999-4999-8999-999999999999',
      userId: '00000000-0000-4000-8000-000000000001',
      parentId: null,
      name: 'Downloads',
      itemCount: 0,
      subfolderCount: 0,
      createdAt: '2026-10-11T08:40:00.000Z',
      updatedAt: '2026-10-11T08:40:00.000Z',
    };

    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          name: string;
          parentId: string | null;
        };
        expect(body).toEqual({ name: 'Downloads', parentId: null });
        return new Response(JSON.stringify(createdDownloadsFolder), {
          status: 201,
        });
      }
      return new Response(
        JSON.stringify({ folders: foldersWithoutDownloads, unorganizedCount: 0 }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const result = await initializeDownloaderFolders({
      subdomain: 'acme',
      fetchImpl: mockFetch,
    });

    expect(result.createdDefaultFolder).toBe(true);
    expect(result.selectedFolderId).toBe('99999999-9999-4999-8999-999999999999');
    expect(result.folders).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it(
    'renders destination folder selector with All Media (Root), Downloads default selected, nested ancestry paths, and inline New Folder dialog',
    async () => {
      installSurfaceFetchStub();
      const user = userEvent.setup();
      renderDownloader();

      const folderSelect = screen.getByTestId('downloader-folder-select');
      expect(folderSelect).toBeTruthy();
      expect(screen.getByTestId('downloader-new-folder-button')).toBeTruthy();

      // Downloads is the default selected folder (its label is what the
      // select trigger shows once the folder list has loaded).
      await waitFor(() => {
        expect(folderSelect.textContent).toContain('Downloads');
      });

      // Every folder is listed by its ancestry path.
      await user.click(folderSelect);
      expect(
        await screen.findByRole('option', { name: 'All Media (Root)' })
      ).toBeTruthy();
      expect(screen.getByRole('option', { name: 'Downloads' })).toBeTruthy();
      expect(screen.getByRole('option', { name: 'Campaign A' })).toBeTruthy();
      expect(
        screen.getByRole('option', { name: 'Campaign A / TikTok Reels' })
      ).toBeTruthy();
      await user.keyboard('{Escape}');

      // Verify inline New Folder modal controls
      await user.click(screen.getByTestId('downloader-new-folder-button'));
      expect(
        await screen.findByTestId('downloader-new-folder-dialog')
      ).toBeTruthy();
      const nameInput = screen.getByTestId('downloader-new-folder-input');
      expect(nameInput).toBeTruthy();
      expect(
        screen.getByTestId('downloader-new-folder-parent-select')
      ).toBeTruthy();
      expect(screen.getByTestId('downloader-new-folder-submit')).toBeTruthy();

      await user.type(nameInput, 'Q4 Viral Clips');
      expect((nameInput as HTMLInputElement).value).toBe('Q4 Viral Clips');
    },
    INTERACTION_TIMEOUT
  );

  it('creates a new folder inline via createDownloaderFolder and immediately returns its ID as selectedFolderId', async () => {
    const newFolderResponse: MediaFolder = {
      id: '44444444-4444-4444-8444-444444444444',
      userId: '00000000-0000-4000-8000-000000000001',
      parentId: '22222222-2222-4222-8222-222222222222',
      name: 'Instagram Carousels',
      itemCount: 0,
      subfolderCount: 0,
      createdAt: '2026-10-11T08:45:00.000Z',
      updatedAt: '2026-10-11T08:45:00.000Z',
    };

    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as {
        name: string;
        parentId: string | null;
      };
      expect(payload).toEqual({
        name: 'Instagram Carousels',
        parentId: '22222222-2222-4222-8222-222222222222',
      });
      return new Response(JSON.stringify(newFolderResponse), { status: 201 });
    }) as unknown as typeof fetch;

    const created = await createDownloaderFolder({
      subdomain: 'acme',
      name: '  Instagram Carousels  ',
      parentId: '22222222-2222-4222-8222-222222222222',
      existingFolders: SAMPLE_FOLDERS,
      fetchImpl: mockFetch,
    });

    expect(created.selectedFolderId).toBe('44444444-4444-4444-8444-444444444444');
    expect(created.folders).toHaveLength(4);
    expect(created.folder.name).toBe('Instagram Carousels');
  });
});

describe('Spec 031: MediaDownloader — Validation, Batch URL Deduplication & Unified Progress Bar (US3, US5)', () => {
  it(
    'validates empty or invalid URL inputs and renders inline role="alert" error state',
    async () => {
      const emptyCheck = validateDownloaderBatchInput('   \n  ');
      expect(emptyCheck.valid).toBe(false);
      expect(emptyCheck.errorMessage).toContain('Please paste at least one link');

      const invalidCheck = validateDownloaderBatchInput(
        'not-a-valid-url\nhttp://127.0.0.1/private.mp4'
      );
      expect(invalidCheck.valid).toBe(false);
      expect(invalidCheck.errorMessage).toContain('valid public link');

      installSurfaceFetchStub();
      const user = userEvent.setup();
      renderDownloader();

      const urlInput = screen.getByTestId('downloader-url-input');
      await user.type(urlInput, 'invalid-link');
      await user.click(screen.getByTestId('downloader-submit-button'));

      // Inline error (role="alert"), byte-identical copy, nothing submitted.
      const urlError = await screen.findByTestId('downloader-url-error');
      expect(urlError.getAttribute('role')).toBe('alert');
      expect(urlError.textContent).toBe(
        'Please enter at least one valid public link.'
      );
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
      expect(downloaderPostCalls).toHaveLength(0);

      // §3 item 2: typing clears the error.
      await user.type(urlInput, 'x');
      await waitFor(() => {
        expect(screen.queryByTestId('downloader-url-error')).toBeNull();
      });
    },
    INTERACTION_TIMEOUT
  );

  it('deduplicates identical URLs within a pasted batch, handles multi-item carousel responses, and emits unified progress updates', async () => {
    const rawBatchInput = [
      'https://www.tiktok.com/@creator/video/111',
      'https://www.tiktok.com/@creator/video/111', // Duplicate in batch!
      'https://www.instagram.com/p/CAROUSEL999/',
    ].join('\n');

    const validation = validateDownloaderBatchInput(rawBatchInput);
    expect(validation.valid).toBe(true);
    expect(validation.urls).toHaveLength(2);
    expect(validation.duplicateCount).toBe(1);

    const progressUpdates: DownloaderBatchProgressState[] = [];
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        url: string;
        folderId: string | null;
      };

      if (body.url.includes('tiktok.com')) {
        return new Response(
          JSON.stringify({
            sourceUrl: body.url,
            platform: 'tiktok',
            items: [SAMPLE_DOWNLOADED_ITEMS[0]],
          }),
          { status: 201 }
        );
      }

      // Multi-item carousel response (2 items from 1 Instagram post)
      return new Response(
        JSON.stringify({
          sourceUrl: body.url,
          platform: 'instagram',
          items: [
            SAMPLE_DOWNLOADED_ITEMS[1],
            {
              ...SAMPLE_DOWNLOADED_ITEMS[1],
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
              name: 'carousel_slide_2.jpg',
            },
          ],
        }),
        { status: 201 }
      );
    }) as unknown as typeof fetch;

    const batchResult = await executeDownloaderBatch({
      subdomain: 'acme',
      rawInput: rawBatchInput,
      folderId: '11111111-1111-4111-8111-111111111111',
      onProgress: (state) => progressUpdates.push(state),
      fetchImpl: mockFetch,
    });

    // Only 2 API calls made (duplicate skipped), and 3 total media items saved (1 TikTok + 2 Instagram carousel slides)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(batchResult.duplicateCount).toBe(1);
    expect(batchResult.savedEntries).toHaveLength(3);
    expect(batchResult.failedEntries).toHaveLength(0);

    // Verify progress state transitions from 0 of 2 -> 1 of 2 -> 2 of 2 completed
    expect(progressUpdates[0]?.completedLinks).toBe(0);
    expect(progressUpdates[0]?.totalLinks).toBe(2);
    expect(progressUpdates.at(-1)?.status).toBe('completed');
    expect(progressUpdates.at(-1)?.completedLinks).toBe(2);
  });

  it('completes an async 202 job through polling and saves the media item the job produced', async () => {
    const jobId = 'job-async-1';
    const completedJob = {
      id: jobId,
      status: 'completed',
      source_url: 'https://www.tiktok.com/@creator/video/111',
      source_platform: 'tiktok',
      media_id: SAMPLE_DOWNLOADED_ITEMS[0]!.id,
      folder_id: '11111111-1111-4111-8111-111111111111',
      progress_percent: 100,
      error_message: null,
    };

    const mockFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({ success: true, job: { id: jobId } }), {
            status: 202,
          });
        }
        if (url.includes('jobId=')) {
          return new Response(JSON.stringify({ success: true, job: completedJob }), {
            status: 200,
          });
        }
        // GET /media/<id> — the route returns the BARE item (no envelope)
        return new Response(JSON.stringify(SAMPLE_DOWNLOADED_ITEMS[0]), {
          status: 200,
        });
      }
    ) as unknown as typeof fetch;

    const batchResult = await executeDownloaderBatch({
      subdomain: 'acme',
      rawInput: 'https://www.tiktok.com/@creator/video/111',
      folderId: '11111111-1111-4111-8111-111111111111',
      fetchImpl: mockFetch,
    });

    expect(batchResult.failedEntries).toHaveLength(0);
    expect(batchResult.savedEntries).toHaveLength(1);
    expect(batchResult.savedEntries[0]?.item.id).toBe(SAMPLE_DOWNLOADED_ITEMS[0]!.id);
    expect(batchResult.savedEntries[0]?.platform).toBe('tiktok');
  });

  it(
    'renders a single unified Windows Copy-style batch progress bar and deduplication notice during active downloads',
    async () => {
      // Two links complete immediately; the remaining two stay in
      // flight (their POST never resolves), freezing the batch at
      // 2 of 4 — the state the legacy suite seeded via initial props.
      const neverResolves = new Promise<Response>(() => {});
      installSurfaceFetchStub({
        onIngestPost: async (body) => {
          if (
            body.url.includes('/video/111') ||
            body.url.includes('/video/222')
          ) {
            return jsonResponse(
              {
                sourceUrl: body.url,
                platform: 'tiktok',
                items: [SAMPLE_DOWNLOADED_ITEMS[0]],
              },
              201
            );
          }
          return neverResolves;
        },
      });
      const user = userEvent.setup();
      renderDownloader();

      const urlInput = screen.getByTestId('downloader-url-input');
      await user.type(
        urlInput,
        [
          'https://www.tiktok.com/@creator/video/111',
          'https://www.tiktok.com/@creator/video/111', // Duplicate in batch!
          'https://www.tiktok.com/@creator/video/222',
          'https://www.tiktok.com/@creator/video/333',
          'https://www.tiktok.com/@creator/video/444',
        ].join('\n')
      );
      await user.click(screen.getByTestId('downloader-submit-button'));

      expect(
        await screen.findByTestId('downloader-batch-progress')
      ).toBeTruthy();
      const dedupNotice = await screen.findByTestId('downloader-dedup-notice');
      expect(dedupNotice.textContent).toBe(
        'Skipped 1 duplicate link in batch'
      );
      expect(
        await screen.findByText('Saving 2 of 4 links to Media Library...')
      ).toBeTruthy();
      expect(screen.getByText('50%')).toBeTruthy();
      expect(screen.getByText('Saving to Media Library...')).toBeTruthy();

      // Must render a single semantic progress element
      const progressBars = document.querySelectorAll('progress');
      expect(progressBars).toHaveLength(1);
      expect(progressBars[0]!.getAttribute('value')).toBe('50');
      expect(progressBars[0]!.getAttribute('max')).toBe('100');
    },
    INTERACTION_TIMEOUT
  );
});

describe('Spec 031: MediaDownloader — Recent Downloads List, Open in Folder & Retry Failed Links (US5)', () => {
  it(
    'renders saved items with auto-populated captions, formatted sizes, target folder path, and Open in Folder navigation',
    async () => {
      // The Recent list hydrates from the stored jobs (OD-140-2): two
      // completed jobs (their media items served by GET /media/<id>)
      // and one failed job.
      installSurfaceFetchStub({
        jobs: [
          {
            id: 'job-saved-1',
            status: 'completed',
            source_url: 'https://www.tiktok.com/@creator/video/111',
            source_platform: 'tiktok',
            media_id: SAMPLE_DOWNLOADED_ITEMS[0]!.id,
            folder_id: SAMPLE_DOWNLOADED_ITEMS[0]!.folderId,
            progress_percent: 100,
            error_message: null,
          },
          {
            id: 'job-saved-2',
            status: 'completed',
            source_url: 'https://www.instagram.com/p/CAROUSEL999/',
            source_platform: 'instagram',
            media_id: SAMPLE_DOWNLOADED_ITEMS[1]!.id,
            folder_id: SAMPLE_DOWNLOADED_ITEMS[1]!.folderId,
            progress_percent: 100,
            error_message: null,
          },
          {
            id: 'job-failed-1',
            status: 'failed',
            source_url: 'https://www.tiktok.com/@private/video/999',
            source_platform: 'tiktok',
            media_id: null,
            folder_id: '11111111-1111-4111-8111-111111111111',
            progress_percent: 0,
            error_message:
              'This post is private or unavailable for cloud download.',
          },
        ],
      });
      const user = userEvent.setup();
      const { container } = renderDownloader();

      expect(screen.getByTestId('downloader-recent-list')).toBeTruthy();
      expect(
        await screen.findByTestId(
          `downloader-saved-item-${SAMPLE_DOWNLOADED_ITEMS[0]!.id}`
        )
      ).toBeTruthy();
      expect(
        screen.getByTestId(
          `downloader-item-caption-${SAMPLE_DOWNLOADED_ITEMS[0]!.id}`
        )
      ).toBeTruthy();
      expect(
        screen.getByTestId(
          `downloader-open-folder-${SAMPLE_DOWNLOADED_ITEMS[0]!.id}`
        )
      ).toBeTruthy();

      // Verify auto-populated post captions and folder ancestry paths
      expect(
        screen.getByText(
          'POV: You automated your entire content calendar 🚀 #growth'
        )
      ).toBeTruthy();
      expect(
        screen.getByText('5 Frameworks for High-Retention Reels')
      ).toBeTruthy();
      expect(screen.getByText('12.0 MB')).toBeTruthy();
      expect(screen.getByText('1.5 MB')).toBeTruthy();
      expect(
        screen.getByTestId(
          `downloader-item-folder-${SAMPLE_DOWNLOADED_ITEMS[1]!.id}`
        ).textContent
      ).toBe('Campaign A / TikTok Reels');
      expect(screen.getAllByText('Open in Folder')).toHaveLength(2);
      expect(screen.getByText('2 saved · 1 failed')).toBeTruthy();

      // Verify failed item & Retry button rendering
      expect(screen.getByTestId('downloader-failed-item')).toBeTruthy();
      expect(screen.getByTestId('downloader-retry-btn')).toBeTruthy();
      expect(
        screen.getByText(
          'This post is private or unavailable for cloud download.'
        )
      ).toBeTruthy();

      // Open in Folder navigates into the Media Library at that folder
      await user.click(
        screen.getByTestId(
          `downloader-open-folder-${SAMPLE_DOWNLOADED_ITEMS[1]!.id}`
        )
      );
      expect(mockPush).toHaveBeenCalledWith(
        '/tenant/acme/media?folder=33333333-3333-4333-8333-333333333333'
      );

      // Verify buildMediaFolderHref routes accurately to ?folder=<id> or /media for root
      expect(
        buildMediaFolderHref('acme', '33333333-3333-4333-8333-333333333333')
      ).toBe('/tenant/acme/media?folder=33333333-3333-4333-8333-333333333333');
      expect(buildMediaFolderHref('acme', null)).toBe('/tenant/acme/media');

      // Strict theme compliance: zero capsule pills (9999px), zero
      // decorative status dots, and no raw palette hex in the markup —
      // styling comes from token classes after the PR-140-2 rebuild.
      const html = container.innerHTML;
      expect(html).not.toContain('9999px');
      expect(html).not.toContain('data-slot="status-dot"');
      expect(html).not.toContain(PALETTE.primary);
    },
    INTERACTION_TIMEOUT
  );

  it('retries a failed link via retryFailedDownloadEntry and recovers the saved media item', async () => {
    const failedEntry: DownloaderFailedEntry = {
      id: 'failed-retry-1',
      url: 'https://www.tiktok.com/@creator/video/777',
      folderId: '11111111-1111-4111-8111-111111111111',
      errorMessage: 'Temporary timeout while contacting source platform.',
    };

    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        url: string;
        folderId: string | null;
      };
      expect(body).toEqual({
        url: 'https://www.tiktok.com/@creator/video/777',
        folderId: '33333333-3333-4333-8333-333333333333',
      });

      return new Response(
        JSON.stringify({
          sourceUrl: body.url,
          platform: 'tiktok',
          items: [SAMPLE_DOWNLOADED_ITEMS[0]],
        }),
        { status: 201 }
      );
    }) as unknown as typeof fetch;

    const retryResult = await retryFailedDownloadEntry({
      subdomain: 'acme',
      entry: failedEntry,
      targetFolderId: '33333333-3333-4333-8333-333333333333',
      fetchImpl: mockFetch,
    });

    expect(retryResult.ok).toBe(true);
    expect(retryResult.savedEntries).toHaveLength(1);
    expect(retryResult.savedEntries[0]?.item.id).toBe(
      SAMPLE_DOWNLOADED_ITEMS[0]!.id
    );
  });
});

/* ================================================================== */
/* PR-140-4 (T22) — completed behavioural coverage                      */
/*                                                                    */
/* Helpers below drive the batch engine through deferred, per-URL     */
/* fetch gates: each ingest POST parks on a promise the test resolves */
/* explicitly, and a counter records how many POSTs are in flight at  */
/* any moment — that counter is the OD-140-1 concurrency evidence.     */
/* ================================================================== */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeBatchItem(index: number): MediaItemResponse {
  return {
    ...SAMPLE_DOWNLOADED_ITEMS[0]!,
    id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index).padStart(12, '0')}`,
    name: `batch_item_${index}.mp4`,
    captionText: `Caption for batch item ${index}`,
  };
}

function ingestSuccessResponse(url: string, item: MediaItemResponse): Response {
  return new Response(
    JSON.stringify({ sourceUrl: url, platform: 'tiktok', items: [item] }),
    { status: 201 }
  );
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * A fetch seam whose promise never settles until the caller's
 * AbortSignal fires — the way a real in-flight fetch behaves when the
 * batch is aborted.
 */
function hangUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => reject(abortError()), {
      once: true,
    });
  });
}

describe('Spec 140 PR-140-4: MediaDownloader — Batch paste surface, empty state & folder availability (§3 items 1, 4, 12)', () => {
  it(
    'shows the example placeholder, the caption helper text, and the empty Recent state before any download',
    async () => {
      installSurfaceFetchStub();
      renderDownloader();

      const urlInput = screen.getByTestId(
        'downloader-url-input'
      ) as HTMLTextAreaElement;
      // §3 item 1: one link or many, one per line — the placeholder
      // carries the TikTok / Instagram / Google Drive examples.
      expect(urlInput.placeholder).toContain(
        'https://www.tiktok.com/@creator/video/1234567890'
      );
      expect(urlInput.placeholder).toContain(
        'https://www.instagram.com/reel/ABC123xyz/'
      );
      expect(urlInput.placeholder).toContain(
        'https://drive.google.com/file/d/1A2B3C/view'
      );
      // §3 item 1: helper text states captions are saved automatically.
      expect(
        screen.getByText(
          'Paste one link or multiple links (one per line). Original post captions are automatically saved with each video or image.'
        )
      ).toBeTruthy();

      // §3 item 12: the typed empty state, copy verbatim.
      expect(screen.getByTestId('downloader-empty-state')).toBeTruthy();
      expect(screen.getByText('Nothing downloaded yet')).toBeTruthy();
      expect(
        screen.getByText(
          'Paste a link above and it will appear here, ready for your library.'
        )
      ).toBeTruthy();
    },
    INTERACTION_TIMEOUT
  );

  it(
    'disables the folder select, the link input, and the submit button while a batch runs (§3 item 4)',
    async () => {
      installSurfaceFetchStub({
        onIngestPost: (_body, init) => hangUntilAbort(init),
      });
      const user = userEvent.setup();
      renderDownloader();

      const urlInput = screen.getByTestId('downloader-url-input');
      await user.type(urlInput, 'https://www.tiktok.com/@creator/video/111');
      await user.click(screen.getByTestId('downloader-submit-button'));

      // The batch is in flight: the progress banner is up and every
      // batch-scoped control is disabled.
      expect(
        await screen.findByTestId('downloader-batch-progress')
      ).toBeTruthy();
      const folderSelect = screen.getByTestId(
        'downloader-folder-select'
      ) as HTMLButtonElement;
      expect(folderSelect.disabled).toBe(true);
      expect(
        (screen.getByTestId('downloader-url-input') as HTMLTextAreaElement)
          .disabled
      ).toBe(true);
      expect(
        (screen.getByTestId(
          'downloader-submit-button'
        ) as HTMLButtonElement).disabled
      ).toBe(true);
      expect(
        (screen.getByTestId(
          'downloader-new-folder-button'
        ) as HTMLButtonElement).disabled
      ).toBe(true);

      // Settle the batch so no work outlives the test.
      await user.click(screen.getByTestId('abort-download-btn'));
      expect(
        await screen.findByTestId('downloader-progress-percent')
      ).toBeTruthy();
      expect(screen.getByTestId('downloader-progress-percent').textContent).toBe(
        'Cancelled'
      );
      // Cancelled percent sits in a Banner on bg-subtle, so the danger
      // tone must use the on-tint colour — plain signal fails on subtle.
      expect(
        screen.getByTestId('downloader-progress-percent').className.split(/\s+/)
      ).toContain('text-signal-critical-on-tint');
    },
    INTERACTION_TIMEOUT
  );
});

describe('Spec 140 PR-140-4: MediaDownloader — Folder provisioning edge paths & inline New Folder dialog (§3 items 5, 6)', () => {
  it('resolves the Downloads auto-provision 409 race by re-listing and selecting the matched folder', async () => {
    const foldersWithoutDownloads = SAMPLE_FOLDERS.slice(1);
    let getCount = 0;
    const mockFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return new Response(
            JSON.stringify({ error: 'A folder with this name already exists.' }),
            { status: 409 }
          );
        }
        getCount += 1;
        // First list: no Downloads yet. Re-list after the 409: the
        // racing request's Downloads folder is now present.
        return new Response(
          JSON.stringify({
            folders:
              getCount === 1 ? foldersWithoutDownloads : SAMPLE_FOLDERS,
            unorganizedCount: 0,
          }),
          { status: 200 }
        );
      }
    ) as unknown as typeof fetch;

    const result = await initializeDownloaderFolders({
      subdomain: 'acme',
      fetchImpl: mockFetch,
    });

    expect(result.createdDefaultFolder).toBe(false);
    expect(result.selectedFolderId).toBe(
      '11111111-1111-4111-8111-111111111111'
    );
    expect(result.folders).toHaveLength(3);
    expect(getCount).toBe(2);
  });

  it('falls back to All Media root (null selection) when folders can neither be loaded nor provisioned', async () => {
    const mockFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return new Response(
            JSON.stringify({ error: 'Storage unavailable.' }),
            { status: 500 }
          );
        }
        throw new Error('Network down');
      }
    ) as unknown as typeof fetch;

    const result = await initializeDownloaderFolders({
      subdomain: 'acme',
      fetchImpl: mockFetch,
    });

    // §3 item 5: silently usable at root — no folders, no selection.
    expect(result.folders).toEqual([]);
    expect(result.selectedFolderId).toBeNull();
    expect(result.createdDefaultFolder).toBe(false);
  });

  it('rejects an empty folder name and surfaces the server message verbatim from createDownloaderFolder', async () => {
    const noFetch = vi.fn() as unknown as typeof fetch;
    await expect(
      createDownloaderFolder({
        subdomain: 'acme',
        name: '   ',
        parentId: null,
        existingFolders: SAMPLE_FOLDERS,
        fetchImpl: noFetch,
      })
    ).rejects.toThrow('Please enter a folder name.');
    expect(noFetch).not.toHaveBeenCalled();

    const serverFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: 'A folder with this name already exists.' }),
        { status: 400 }
      );
    }) as unknown as typeof fetch;
    await expect(
      createDownloaderFolder({
        subdomain: 'acme',
        name: 'Downloads',
        parentId: null,
        existingFolders: SAMPLE_FOLDERS,
        fetchImpl: serverFetch,
      })
    ).rejects.toThrow('A folder with this name already exists.');
  });

  it(
    'shows "Please enter a folder name." in the dialog for an empty name and submits nothing',
    async () => {
      installSurfaceFetchStub();
      const user = userEvent.setup();
      renderDownloader();

      await user.click(screen.getByTestId('downloader-new-folder-button'));
      expect(
        await screen.findByTestId('downloader-new-folder-dialog')
      ).toBeTruthy();
      await user.click(screen.getByTestId('downloader-new-folder-submit'));

      // The message renders in both the error summary and the field
      // message — either surfacing satisfies §3 item 6.
      expect(
        (await screen.findAllByText('Please enter a folder name.')).length
      ).toBeGreaterThan(0);
      expect(folderPostCalls).toHaveLength(0);
      // The dialog stays open so the name can be corrected.
      expect(screen.getByTestId('downloader-new-folder-dialog')).toBeTruthy();
    },
    INTERACTION_TIMEOUT
  );

  it(
    'surfaces the server error verbatim in the dialog and keeps it open',
    async () => {
      installSurfaceFetchStub({
        onFolderPost: async () =>
          jsonResponse(
            { error: 'A folder with this name already exists.' },
            400
          ),
      });
      const user = userEvent.setup();
      renderDownloader();

      await user.click(screen.getByTestId('downloader-new-folder-button'));
      const nameInput = await screen.findByTestId(
        'downloader-new-folder-input'
      );
      await user.type(nameInput, 'Downloads');
      await user.click(screen.getByTestId('downloader-new-folder-submit'));

      expect(
        (await screen.findAllByText('A folder with this name already exists.'))
          .length
      ).toBeGreaterThan(0);
      expect(folderPostCalls).toHaveLength(1);
      expect(screen.getByTestId('downloader-new-folder-dialog')).toBeTruthy();
    },
    INTERACTION_TIMEOUT
  );

  it(
    'creates the folder from the dialog, closes it, and selects the new folder',
    async () => {
      const createdFolder: MediaFolder = {
        id: '44444444-4444-4444-8444-444444444444',
        userId: '00000000-0000-4000-8000-000000000001',
        parentId: '11111111-1111-4111-8111-111111111111',
        name: 'Q4 Viral Clips',
        itemCount: 0,
        subfolderCount: 0,
        createdAt: '2026-10-11T08:45:00.000Z',
        updatedAt: '2026-10-11T08:45:00.000Z',
      };
      installSurfaceFetchStub({
        onFolderPost: async () => jsonResponse(createdFolder, 201),
      });
      const user = userEvent.setup();
      renderDownloader();

      await user.click(screen.getByTestId('downloader-new-folder-button'));
      const nameInput = await screen.findByTestId(
        'downloader-new-folder-input'
      );
      await user.type(nameInput, 'Q4 Viral Clips');
      await user.click(screen.getByTestId('downloader-new-folder-submit'));

      // The dialog's preselected parent is the currently selected
      // folder (Downloads); the POST carries name + that parent.
      expect(folderPostCalls).toEqual([
        {
          name: 'Q4 Viral Clips',
          parentId: '11111111-1111-4111-8111-111111111111',
        },
      ]);
      // Success closes the dialog and selects the new folder.
      await waitFor(() => {
        expect(screen.queryByTestId('downloader-new-folder-dialog')).toBeNull();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('downloader-folder-select').textContent
        ).toContain('Q4 Viral Clips');
      });
    },
    INTERACTION_TIMEOUT
  );
});

describe('Spec 140 PR-140-4: MediaDownloader — OD-140-1 concurrency (data layer, §3 item 7 as amended)', () => {
  it('never runs more than 3 ingests in flight and starts the next item as a slot frees', async () => {
    const urls = [0, 1, 2, 3, 4, 5].map(
      (i) => `https://www.tiktok.com/@creator/video/90${i}`
    );
    const gates = new Map<string, Deferred<Response>>();
    let inFlight = 0;
    let maxInFlight = 0;

    const mockFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { url: string };
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const gate = createDeferred<Response>();
        gates.set(body.url, gate);
        try {
          return await gate.promise;
        } finally {
          inFlight -= 1;
        }
      }
    ) as unknown as typeof fetch;

    const batchPromise = executeDownloaderBatch({
      subdomain: 'acme',
      rawInput: urls.join('\n'),
      folderId: null,
      fetchImpl: mockFetch,
    });

    // Exactly 3 item flows start; the other 3 wait for a free slot.
    await vi.waitFor(() => expect(gates.size).toBe(3));
    expect(inFlight).toBe(3);
    expect(maxInFlight).toBe(3);

    // Freeing one slot starts exactly one more item.
    gates.get(urls[0]!)!.resolve(ingestSuccessResponse(urls[0]!, makeBatchItem(0)));
    await vi.waitFor(() => expect(gates.size).toBe(4));
    expect(maxInFlight).toBe(3);

    // Drain the rest; the cap holds for the whole batch.
    for (const url of urls.slice(1)) {
      await vi.waitFor(() =>
        expect(gates.has(url)).toBe(true)
      );
      gates
        .get(url)!
        .resolve(
          ingestSuccessResponse(url, makeBatchItem(urls.indexOf(url)))
        );
    }
    const result = await batchPromise;

    expect(maxInFlight).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(6);
    expect(result.failedEntries).toHaveLength(0);
    expect(result.savedEntries.map((entry) => entry.item.name)).toEqual(
      urls.map((_, i) => `batch_item_${i}.mp4`)
    );
  });

  it('returns saved entries in batch order even when items complete out of order', async () => {
    const urls = [0, 1, 2].map(
      (i) => `https://www.tiktok.com/@creator/video/80${i}`
    );
    const gates = new Map<string, Deferred<Response>>();
    const mockFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { url: string };
        const gate = createDeferred<Response>();
        gates.set(body.url, gate);
        return gate.promise;
      }
    ) as unknown as typeof fetch;

    const batchPromise = executeDownloaderBatch({
      subdomain: 'acme',
      rawInput: urls.join('\n'),
      folderId: null,
      fetchImpl: mockFetch,
    });
    await vi.waitFor(() => expect(gates.size).toBe(3));

    // Complete strictly out of order: last, first, middle.
    gates.get(urls[2]!)!.resolve(ingestSuccessResponse(urls[2]!, makeBatchItem(2)));
    gates.get(urls[0]!)!.resolve(ingestSuccessResponse(urls[0]!, makeBatchItem(0)));
    gates.get(urls[1]!)!.resolve(ingestSuccessResponse(urls[1]!, makeBatchItem(1)));

    const result = await batchPromise;
    expect(result.savedEntries.map((entry) => entry.item.id)).toEqual([
      makeBatchItem(0).id,
      makeBatchItem(1).id,
      makeBatchItem(2).id,
    ]);
  });

  it("isolates one item's failure: the batch completes, the others save, and the failure carries the server message", async () => {
    const urls = [0, 1, 2, 3].map(
      (i) => `https://www.tiktok.com/@creator/video/70${i}`
    );
    const gates = new Map<string, Deferred<Response>>();
    const mockFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { url: string };
        const gate = createDeferred<Response>();
        gates.set(body.url, gate);
        return gate.promise;
      }
    ) as unknown as typeof fetch;

    const batchPromise = executeDownloaderBatch({
      subdomain: 'acme',
      rawInput: urls.join('\n'),
      folderId: null,
      fetchImpl: mockFetch,
    });

    // All four items are attempted (3 in flight + 1 as a slot frees) —
    // the failure neither stalls nor short-circuits the batch.
    await vi.waitFor(() => expect(gates.size).toBe(3));
    gates.get(urls[1]!)!.resolve(
      new Response(JSON.stringify({ error: 'This link is private.' }), {
        status: 400,
      })
    );
    await vi.waitFor(() => expect(gates.size).toBe(4));
    for (const url of [urls[0]!, urls[2]!, urls[3]!]) {
      gates
        .get(url)!
        .resolve(
          ingestSuccessResponse(url, makeBatchItem(urls.indexOf(url)))
        );
    }

    const result = await batchPromise;
    expect(result.savedEntries.map((entry) => entry.item.name)).toEqual([
      'batch_item_0.mp4',
      'batch_item_2.mp4',
      'batch_item_3.mp4',
    ]);
    expect(result.failedEntries).toHaveLength(1);
    expect(result.failedEntries[0]?.url).toBe(urls[1]);
    expect(result.failedEntries[0]?.errorMessage).toBe('This link is private.');
  });

  it('preserves per-item progress under concurrency: each item reports its own resolving state and completedLinks never goes backwards', async () => {
    const urls = [0, 1, 2, 3].map(
      (i) => `https://www.tiktok.com/@creator/video/60${i}`
    );
    const gates = new Map<string, Deferred<Response>>();
    const progressUpdates: DownloaderBatchProgressState[] = [];
    const mockFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { url: string };
        const gate = createDeferred<Response>();
        gates.set(body.url, gate);
        return gate.promise;
      }
    ) as unknown as typeof fetch;

    const batchPromise = executeDownloaderBatch({
      subdomain: 'acme',
      rawInput: urls.join('\n'),
      folderId: null,
      onProgress: (state) => progressUpdates.push({ ...state }),
      fetchImpl: mockFetch,
    });
    await vi.waitFor(() => expect(gates.size).toBe(3));
    for (const url of urls) {
      await vi.waitFor(() => expect(gates.has(url)).toBe(true));
      gates
        .get(url)!
        .resolve(
          ingestSuccessResponse(url, makeBatchItem(urls.indexOf(url)))
        );
    }
    await batchPromise;

    // Every item surfaced as the in-flight URL with its own resolving
    // stage while the batch ran concurrently.
    for (const url of urls) {
      expect(
        progressUpdates.some(
          (state) => state.currentUrl === url && state.stage === 'resolving'
        )
      ).toBe(true);
    }
    const completedSequence = progressUpdates.map(
      (state) => state.completedLinks
    );
    expect(completedSequence).toEqual(
      [...completedSequence].sort((a, b) => a - b)
    );
    expect(progressUpdates.at(-1)?.status).toBe('completed');
    expect(progressUpdates.at(-1)?.completedLinks).toBe(4);
    expect(progressUpdates.at(-1)?.totalLinks).toBe(4);
  });

  it(
    'surfaces the streaming stage and its percent from job polling (§3 item 7 stage model)',
    async () => {
      const jobId = 'job-stage-1';
      const completedJob = {
        id: jobId,
        status: 'completed',
        source_url: 'https://www.tiktok.com/@creator/video/111',
        source_platform: 'tiktok',
        media_id: SAMPLE_DOWNLOADED_ITEMS[0]!.id,
        folder_id: null,
        progress_percent: 100,
        error_message: null,
      };
      let pollCount = 0;
      const progressUpdates: DownloaderBatchProgressState[] = [];
      const mockFetch = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (init?.method === 'POST') {
            return new Response(
              JSON.stringify({ success: true, job: { id: jobId } }),
              { status: 202 }
            );
          }
          if (url.includes('jobId=')) {
            pollCount += 1;
            const job =
              pollCount === 1
                ? {
                    ...completedJob,
                    status: 'processing',
                    progress_percent: 42,
                    media_id: null,
                  }
                : completedJob;
            return new Response(JSON.stringify({ success: true, job }), {
              status: 200,
            });
          }
          return new Response(JSON.stringify(SAMPLE_DOWNLOADED_ITEMS[0]), {
            status: 200,
          });
        }
      ) as unknown as typeof fetch;

      const result = await executeDownloaderBatch({
        subdomain: 'acme',
        rawInput: 'https://www.tiktok.com/@creator/video/111',
        folderId: null,
        onProgress: (state) => progressUpdates.push({ ...state }),
        fetchImpl: mockFetch,
      });

      expect(result.failedEntries).toHaveLength(0);
      expect(result.savedEntries).toHaveLength(1);
      // The processing poll (42%) maps to the streaming stage with its
      // percent preserved — not collapsed into a generic progress.
      expect(
        progressUpdates.some(
          (state) => state.stage === 'streaming' && state.stagePercent === 42
        )
      ).toBe(true);
    },
    INTERACTION_TIMEOUT
  );
});

describe('Spec 140 PR-140-4: MediaDownloader — Abort (§3 item 8)', () => {
  it('keeps already-saved items saved, cancels in-flight items, and starts no new items after abort', async () => {
    const urls = [0, 1, 2, 3, 4].map(
      (i) => `https://www.tiktok.com/@creator/video/50${i}`
    );
    const startedUrls: string[] = [];
    const progressUpdates: DownloaderBatchProgressState[] = [];
    const controller = new AbortController();

    const mockFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { url: string };
        startedUrls.push(body.url);
        if (body.url === urls[0]) {
          return ingestSuccessResponse(body.url, makeBatchItem(0));
        }
        return hangUntilAbort(init);
      }
    ) as unknown as typeof fetch;

    const batchPromise = executeDownloaderBatch({
      subdomain: 'acme',
      rawInput: urls.join('\n'),
      folderId: null,
      signal: controller.signal,
      onProgress: (state) => progressUpdates.push({ ...state }),
      fetchImpl: mockFetch,
    });

    // Item 0 saved; its freed slot started item 3. Items 1–3 in flight.
    await vi.waitFor(() => expect(startedUrls).toHaveLength(4));
    controller.abort();
    const result = await batchPromise;

    // No new item started after the abort — item 4 was never attempted.
    expect(startedUrls).toHaveLength(4);
    expect(startedUrls).not.toContain(urls[4]);
    // The already-saved item stays saved.
    expect(result.savedEntries.map((entry) => entry.item.id)).toEqual([
      makeBatchItem(0).id,
    ]);
    // The three in-flight items surface as cancelled failures.
    expect(result.failedEntries).toHaveLength(3);
    expect(
      result.failedEntries.every(
        (entry) => entry.errorMessage === 'Download was cancelled.'
      )
    ).toBe(true);
    expect(
      progressUpdates.some((state) => state.status === 'cancelled')
    ).toBe(true);
  });

  it(
    'ends the banner on Cancelled after a multi-item UI abort, keeps the saved item in Recent, and never starts the queued item (§3 item 8)',
    async () => {
      // PR-140-5: this is the UI abort test PR-140-4 had to exclude —
      // it exposed the abort end-state bug (the banner settled on
      // 'completed'/100% after a multi-item abort). 5 links: the
      // first saves instantly, the next 3 hang in flight, and the 5th
      // is still queued behind the 3-worker pool when Abort lands.
      const urls = [0, 1, 2, 3, 4].map(
        (i) => `https://www.tiktok.com/@creator/video/60${i}`
      );
      installSurfaceFetchStub({
        onIngestPost: (body, init) => {
          if (body.url === urls[0]) {
            return Promise.resolve(
              jsonResponse(
                {
                  sourceUrl: body.url,
                  platform: 'tiktok',
                  items: [SAMPLE_DOWNLOADED_ITEMS[0]],
                },
                201
              )
            );
          }
          return hangUntilAbort(init);
        },
      });
      const user = userEvent.setup();
      renderDownloader();

      const urlInput = screen.getByTestId('downloader-url-input');
      await user.type(urlInput, urls.join('\n'));
      await user.click(screen.getByTestId('downloader-submit-button'));

      // Item 0 saved, its freed slot started item 3 — 4 POSTs in
      // total, items 1–3 hanging, item 4 still queued.
      await vi.waitFor(() => expect(downloaderPostCalls).toHaveLength(4));

      await user.click(screen.getByTestId('abort-download-btn'));

      // Wait until the batch has fully unwound: the three in-flight
      // items surface as cancelled failures in Recent. Only then is
      // the banner's state the TERMINAL state (asserting right after
      // the click would pass even on the buggy code, whose last
      // unwinding worker overwrote 'cancelled' with 'completed').
      await waitFor(() => {
        expect(
          screen.getAllByTestId('downloader-failed-item')
        ).toHaveLength(3);
      });
      expect(screen.getByText('1 saved · 3 failed')).toBeTruthy();
      expect(
        screen
          .getAllByTestId('downloader-failed-item')
          .every((el) => el.textContent.includes('Download was cancelled.'))
      ).toBe(true);

      // The terminal banner state is Cancelled — never 100%/completed.
      expect(screen.getByTestId('downloader-progress-percent').textContent).toBe(
        'Cancelled'
      );
      // Same on-tint requirement as the abort path: the percent sits in
      // a Banner on bg-subtle.
      expect(
        screen.getByTestId('downloader-progress-percent').className.split(/\s+/)
      ).toContain('text-signal-critical-on-tint');

      // The already-saved item remains in Recent Downloads…
      expect(
        screen.getByTestId(
          `downloader-saved-item-${SAMPLE_DOWNLOADED_ITEMS[0]!.id}`
        )
      ).toBeTruthy();
      // …and the queued item was never started.
      expect(downloaderPostCalls).toHaveLength(4);
      expect(downloaderPostCalls.map((call) => call.url)).not.toContain(
        urls[4]
      );
    },
    INTERACTION_TIMEOUT
  );
});

describe('Spec 140 PR-140-4: MediaDownloader — Retry through the UI & the input-clearing rule (§3 items 10, 11)', () => {
  it('retries a failed entry against its original folder via retryFailedDownloadEntry when no target is given, and reports a retry failure', async () => {
    const failedEntry: DownloaderFailedEntry = {
      id: 'failed-retry-fallback',
      url: 'https://www.tiktok.com/@creator/video/888',
      folderId: '22222222-2222-4222-8222-222222222222',
      errorMessage: 'Temporary timeout while contacting source platform.',
    };

    // No targetFolderId → the entry's original folder is used.
    const seenBodies: Array<{ url: string; folderId: string | null }> = [];
    const okFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          url: string;
          folderId: string | null;
        };
        seenBodies.push(body);
        return new Response(
          JSON.stringify({
            sourceUrl: body.url,
            platform: 'tiktok',
            items: [SAMPLE_DOWNLOADED_ITEMS[0]],
          }),
          { status: 201 }
        );
      }
    ) as unknown as typeof fetch;

    const okResult = await retryFailedDownloadEntry({
      subdomain: 'acme',
      entry: failedEntry,
      fetchImpl: okFetch,
    });
    expect(okResult.ok).toBe(true);
    expect(seenBodies).toEqual([
      {
        url: failedEntry.url,
        folderId: '22222222-2222-4222-8222-222222222222',
      },
    ]);

    // A failed retry reports ok:false with the server's message.
    const failFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: 'Still unavailable from the source.' }),
        { status: 502 }
      );
    }) as unknown as typeof fetch;
    const failResult = await retryFailedDownloadEntry({
      subdomain: 'acme',
      entry: failedEntry,
      fetchImpl: failFetch,
    });
    expect(failResult.ok).toBe(false);
    expect(failResult.savedEntries).toHaveLength(0);
    expect(failResult.errorMessage).toBe('Still unavailable from the source.');
  });

  it(
    'moves a failed link to the saved list on a successful UI retry',
    async () => {
      let shouldFail = true;
      installSurfaceFetchStub({
        onIngestPost: async (body) => {
          if (shouldFail) {
            return jsonResponse(
              { error: 'This post is private or unavailable for cloud download.' },
              400
            );
          }
          return jsonResponse(
            {
              sourceUrl: body.url,
              platform: 'tiktok',
              items: [SAMPLE_DOWNLOADED_ITEMS[0]],
            },
            201
          );
        },
      });
      const user = userEvent.setup();
      renderDownloader();

      const failedUrl = 'https://www.tiktok.com/@private/video/999';
      const urlInput = screen.getByTestId('downloader-url-input');
      await user.type(urlInput, failedUrl);
      await user.click(screen.getByTestId('downloader-submit-button'));

      expect(await screen.findByTestId('downloader-failed-item')).toBeTruthy();
      expect(
        screen.getByText(
          'This post is private or unavailable for cloud download.'
        )
      ).toBeTruthy();
      expect(screen.getByText('0 saved · 1 failed')).toBeTruthy();

      shouldFail = false;
      await user.click(screen.getByTestId('downloader-retry-btn'));

      // The entry moves to the saved list; the failure is gone.
      expect(
        await screen.findByTestId(
          `downloader-saved-item-${SAMPLE_DOWNLOADED_ITEMS[0]!.id}`
        )
      ).toBeTruthy();
      await waitFor(() => {
        expect(screen.queryByTestId('downloader-failed-item')).toBeNull();
      });
      // The retry POST targeted the entry's original folder (the
      // Downloads folder the batch ran against).
      expect(downloaderPostCalls.at(-1)).toEqual({
        url: failedUrl,
        folderId: '11111111-1111-4111-8111-111111111111',
      });
    },
    INTERACTION_TIMEOUT
  );

  it(
    'keeps the failed entry and updates its error message in place on a failed UI retry',
    async () => {
      let attempt = 0;
      installSurfaceFetchStub({
        onIngestPost: async () => {
          attempt += 1;
          return jsonResponse(
            {
              error:
                attempt === 1
                  ? 'Original failure reason.'
                  : 'Retry failure reason.',
            },
            400
          );
        },
      });
      const user = userEvent.setup();
      renderDownloader();

      const urlInput = screen.getByTestId('downloader-url-input');
      await user.type(urlInput, 'https://www.tiktok.com/@private/video/999');
      await user.click(screen.getByTestId('downloader-submit-button'));

      expect(await screen.findByTestId('downloader-failed-item')).toBeTruthy();
      expect(screen.getByText('Original failure reason.')).toBeTruthy();

      await user.click(screen.getByTestId('downloader-retry-btn'));

      // Same single failed entry, error updated in place (§3 item 10).
      expect(await screen.findByText('Retry failure reason.')).toBeTruthy();
      expect(screen.queryByText('Original failure reason.')).toBeNull();
      expect(screen.getAllByTestId('downloader-failed-item')).toHaveLength(1);
      expect(screen.getByText('0 saved · 1 failed')).toBeTruthy();
      expect(attempt).toBe(2);
    },
    INTERACTION_TIMEOUT
  );

  it(
    'clears the textarea after a zero-failure batch, saves the caption with the item, invalidates the media queries, and dispatches no window event (§3 items 1, 11, 14)',
    async () => {
      installSurfaceFetchStub({
        onIngestPost: async (body) =>
          jsonResponse(
            {
              sourceUrl: body.url,
              platform: 'tiktok',
              items: [SAMPLE_DOWNLOADED_ITEMS[0]],
            },
            201
          ),
      });
      const completedListener = vi.fn();
      window.addEventListener(
        'fbuploadpro:download-completed',
        completedListener
      );
      try {
        const user = userEvent.setup();
        const { queryClient } = renderDownloader();
        const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

        const urlInput = screen.getByTestId(
          'downloader-url-input'
        ) as HTMLTextAreaElement;
        await user.type(
          urlInput,
          'https://www.tiktok.com/@creator/video/111'
        );
        await user.click(screen.getByTestId('downloader-submit-button'));

        expect(
          await screen.findByTestId(
            `downloader-saved-item-${SAMPLE_DOWNLOADED_ITEMS[0]!.id}`
          )
        ).toBeTruthy();
        // §3 item 1: the original post caption persisted on the item.
        expect(
          screen.getByText(
            'POV: You automated your entire content calendar 🚀 #growth'
          )
        ).toBeTruthy();
        // §3 item 11: zero failures → the textarea clears.
        await waitFor(() => expect(urlInput.value).toBe(''));
        // §3 item 14 / OD-140-3: completion is signalled by React
        // Query invalidation of the media + downloader queries; the
        // legacy window event is never dispatched.
        await waitFor(() => {
          const keys = invalidateSpy.mock.calls.map((call) =>
            JSON.stringify(
              (call[0] as { queryKey?: unknown } | undefined)?.queryKey ?? []
            )
          );
          expect(keys.some((key) => key.includes('"media"'))).toBe(true);
          expect(keys.some((key) => key.includes('"downloader"'))).toBe(true);
        });
        expect(completedListener).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener(
          'fbuploadpro:download-completed',
          completedListener
        );
      }
    },
    INTERACTION_TIMEOUT
  );

  it(
    'keeps the textarea content when a batch has any failure (§3 item 11)',
    async () => {
      installSurfaceFetchStub({
        onIngestPost: async (body) => {
          if (body.url.includes('/video/222')) {
            return jsonResponse({ error: 'This link is private.' }, 400);
          }
          return jsonResponse(
            {
              sourceUrl: body.url,
              platform: 'tiktok',
              items: [SAMPLE_DOWNLOADED_ITEMS[0]],
            },
            201
          );
        },
      });
      const user = userEvent.setup();
      renderDownloader();

      const rawInput = [
        'https://www.tiktok.com/@creator/video/111',
        'https://www.tiktok.com/@creator/video/222',
      ].join('\n');
      const urlInput = screen.getByTestId(
        'downloader-url-input'
      ) as HTMLTextAreaElement;
      await user.type(urlInput, rawInput);
      await user.click(screen.getByTestId('downloader-submit-button'));

      // The batch settles with one save and one failure…
      expect(await screen.findByTestId('downloader-failed-item')).toBeTruthy();
      expect(
        screen.getByTestId(
          `downloader-saved-item-${SAMPLE_DOWNLOADED_ITEMS[0]!.id}`
        )
      ).toBeTruthy();
      expect(screen.getByText('1 saved · 1 failed')).toBeTruthy();
      // …and the input is NOT cleared, so the failed link can be fixed.
      expect(urlInput.value).toBe(rawInput);
    },
    INTERACTION_TIMEOUT
  );
});

describe('Spec 140 PR-140-4: MediaDownloader — Mount hydration & Recent order (OD-140-2, OD-140-1)', () => {
  it(
    'hydrates the Recent list from the stored-jobs GET on mount, before any interaction (OD-140-2)',
    async () => {
      installSurfaceFetchStub({
        jobs: [
          {
            id: 'job-hydrated-1',
            status: 'completed',
            source_url: 'https://www.tiktok.com/@creator/video/111',
            source_platform: 'tiktok',
            media_id: SAMPLE_DOWNLOADED_ITEMS[0]!.id,
            folder_id: SAMPLE_DOWNLOADED_ITEMS[0]!.folderId,
            progress_percent: 100,
            error_message: null,
          },
        ],
      });
      renderDownloader();

      // The stored job's saved row renders from the mount fetch alone.
      expect(
        await screen.findByTestId(
          `downloader-saved-item-${SAMPLE_DOWNLOADED_ITEMS[0]!.id}`
        )
      ).toBeTruthy();
      expect(screen.getByText('1 saved')).toBeTruthy();
      // Hydration is a read: the jobs GET ran, no ingest POST happened.
      expect(downloaderGetCalls).toBeGreaterThan(0);
      expect(downloaderPostCalls).toHaveLength(0);
    },
    INTERACTION_TIMEOUT
  );

  it(
    'renders the Recent list in batch order in the UI even when items complete out of order (OD-140-1)',
    async () => {
      const urls = [0, 1, 2].map(
        (i) => `https://www.tiktok.com/@creator/video/40${i}`
      );
      const gates = new Map<string, Deferred<Response>>();
      installSurfaceFetchStub({
        onIngestPost: (body) => {
          const gate = createDeferred<Response>();
          gates.set(body.url, gate);
          return gate.promise;
        },
      });
      const user = userEvent.setup();
      const { container } = renderDownloader();

      const urlInput = screen.getByTestId('downloader-url-input');
      await user.type(urlInput, urls.join('\n'));
      await user.click(screen.getByTestId('downloader-submit-button'));
      await vi.waitFor(() => expect(gates.size).toBe(3));

      // Complete out of order: last, first, middle.
      await act(async () => {
        gates
          .get(urls[2]!)!
          .resolve(
            jsonResponse(
              {
                sourceUrl: urls[2],
                platform: 'tiktok',
                items: [makeBatchItem(2)],
              },
              201
            )
          );
      });
      await act(async () => {
        gates
          .get(urls[0]!)!
          .resolve(
            jsonResponse(
              {
                sourceUrl: urls[0],
                platform: 'tiktok',
                items: [makeBatchItem(0)],
              },
              201
            )
          );
      });
      await act(async () => {
        gates
          .get(urls[1]!)!
          .resolve(
            jsonResponse(
              {
                sourceUrl: urls[1],
                platform: 'tiktok',
                items: [makeBatchItem(1)],
              },
              201
            )
          );
      });

      await waitFor(() => {
        expect(
          container.querySelectorAll(
            '[data-testid^="downloader-saved-item-"]'
          )
        ).toHaveLength(3);
      });
      const renderedIds = Array.from(
        container.querySelectorAll('[data-testid^="downloader-saved-item-"]')
      ).map((el) => el.getAttribute('data-testid'));
      expect(renderedIds).toEqual([
        `downloader-saved-item-${makeBatchItem(0).id}`,
        `downloader-saved-item-${makeBatchItem(1).id}`,
        `downloader-saved-item-${makeBatchItem(2).id}`,
      ]);
    },
    INTERACTION_TIMEOUT
  );
});

describe('Spec 140 PR-140-5: Downloader ↔ Media Library folders cache shape (bug #2 regression)', () => {
  // One shared QueryClient per test, built by the production factory
  // (60s reference staleTime): within the freshness window the second
  // surface reads the first surface's cached value WITHOUT refetching
  // — exactly the SPA-navigation read that crashed the explorer when
  // the downloader cached the `{ folders, unorganizedCount }` envelope
  // under the key whose canonical shape is `MediaFolder[]`.
  function sharedWrapper(queryClient: QueryClient) {
    return function Wrapper({
      children,
    }: {
      children: React.ReactNode;
    }) {
      return (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
    };
  }

  it(
    '(a) downloader-first: the folders cache populated through the downloader reads back as an array through the library query',
    async () => {
      installSurfaceFetchStub();
      const queryClient = createQueryClient('acme');
      const wrapper = sharedWrapper(queryClient);

      const downloader = renderHook(() => useDownloaderFolders('acme'), {
        wrapper,
      });
      await waitFor(() =>
        expect(downloader.result.current.folders).toHaveLength(3)
      );
      expect(downloader.result.current.autoSelectedFolderId).toBe(
        SAMPLE_FOLDERS[0]!.id
      );

      // Read the cache through the library's own query definition:
      // an array must come back and array operations must work (the
      // explorer calls `.filter` on this value during render).
      const cached = queryClient.getQueryData(
        mediaFoldersQuery('acme').queryKey
      );
      expect(Array.isArray(cached)).toBe(true);
      const folders = cached as MediaFolder[];
      expect(
        folders.filter((folder) => folder.parentId === null).map((f) => f.name)
      ).toEqual(expect.arrayContaining(['Downloads', 'Campaign A']));

      // The library hook on the same client sees the same array.
      const library = renderHook(() => useMediaFolders('acme'), { wrapper });
      expect(Array.isArray(library.result.current.data)).toBe(true);
      expect(library.result.current.data?.map((folder) => folder.id)).toEqual(
        SAMPLE_FOLDERS.map((folder) => folder.id)
      );
    },
    INTERACTION_TIMEOUT
  );

  it(
    '(b) library-first: the downloader still provisions and selects Downloads from a library-populated array cache',
    async () => {
      installSurfaceFetchStub();
      const queryClient = createQueryClient('acme');
      const wrapper = sharedWrapper(queryClient);

      // Populate the shared cache through the library's query first.
      const libraryFolders = await queryClient.fetchQuery(
        mediaFoldersQuery('acme')
      );
      expect(Array.isArray(libraryFolders)).toBe(true);
      expect(libraryFolders).toHaveLength(3);

      const downloader = renderHook(() => useDownloaderFolders('acme'), {
        wrapper,
      });
      // The downloader reads the array shape directly: every folder
      // is listed and the existing root Downloads folder is selected
      // by the provisioning pass (no creation POST needed).
      await waitFor(() =>
        expect(downloader.result.current.folders).toHaveLength(3)
      );
      expect(downloader.result.current.folders.map((folder) => folder.id)).toEqual(
        SAMPLE_FOLDERS.map((folder) => folder.id)
      );
      await waitFor(() =>
        expect(downloader.result.current.autoSelectedFolderId).toBe(
          SAMPLE_FOLDERS[0]!.id
        )
      );
      expect(folderPostCalls).toHaveLength(0);
      // …and the cache still holds the canonical array shape.
      expect(
        Array.isArray(
          queryClient.getQueryData(mediaFoldersQuery('acme').queryKey)
        )
      ).toBe(true);
    },
    INTERACTION_TIMEOUT
  );
});
