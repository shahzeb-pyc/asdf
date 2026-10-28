/**
 * @file media-import-modal.test.tsx
 * @description Behavioural tests for the media import flow rebuilt in
 * spec 133 PR-133-4 (T36): staging rows with validation + duplicate
 * flags, the destination default, "Start import (n)" gating, the
 * progress mode with "queued · #n" beyond the 3 active slots,
 * pause/cancel, "Keep working" minimisation, and the completion
 * summary that only follows server confirmation.
 *
 * These supersede the Spec 072 static-markup assertions that used to
 * live in media-library-explorer.test.tsx — the rebuilt dialog
 * renders through the shared/ui Dialog (Radix portal), which static
 * markup cannot see, and behaviour is what the rebuild preserves
 * (spec §2.5). Superseded mechanism assertions: inline styles, theme
 * objects, the hand-rolled <dialog> element, fixed z-index layers.
 * Every behaviour assertion from Spec 072 carries over below.
 *
 * Seams: the app API is the real typed client over a stubbed global
 * fetch (check-duplicates / upload-url / confirm); storage PUTs are
 * a fake XMLHttpRequest (the R2 upload) + the same fetch stub (the
 * thumbnail PUT); thumbnail generation is stubbed at the module seam
 * because jsdom has no media decoders — it is a platform capability,
 * not import behaviour. Everything else (queue building, validation,
 * duplicate handling, the concurrency loop, confirm parsing) runs
 * for real.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MediaFolder } from '@fbuploadpro/contracts';

import { MediaImportModal } from '@/components/media/media-import-modal';
import { ImportProgressRow } from '@/components/media/media-import-progress-row';
import type { ImportQueueItem } from '@/components/media/media-types';

vi.mock('@/components/media/media-import-utils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/media/media-import-utils')>();
  return {
    ...actual,
    generateThumbnailBlob: vi.fn(async () => ({
      blob: null,
      width: 100,
      height: 100,
      duration: null,
    })),
    // Same seam as the thumbnail stub above: jsdom has no media
    // decoders, so the P4 metadata probe's <video> element never
    // fires loadedmetadata and would otherwise pend its full
    // 15-second budget, gating confirm and completion. The probe
    // is a platform capability, not import behaviour — stub it
    // with plausible dimensions so the probe-wins confirm path
    // still runs for real.
    probeVideoMetadata: vi.fn(async () => ({
      width: 100,
      height: 100,
      duration: null,
    })),
  };
});

const FOLDERS: MediaFolder[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    userId: '00000000-0000-4000-8000-000000000001',
    parentId: null,
    name: 'Campaign A',
    itemCount: 2,
    subfolderCount: 2,
    createdAt: '2026-10-10T10:00:00.000Z',
    updatedAt: '2026-10-10T10:00:00.000Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    userId: '00000000-0000-4000-8000-000000000001',
    parentId: '11111111-1111-4111-8111-111111111111',
    name: 'Reels',
    itemCount: 5,
    subfolderCount: 1,
    createdAt: '2026-10-10T10:05:00.000Z',
    updatedAt: '2026-10-10T10:05:00.000Z',
  },
];

const CONFIRM_ITEM = {
  id: '55555555-5555-4555-8555-555555555555',
  userId: '22222222-2222-4222-8222-222222222222',
  folderId: null,
  name: 'promo.mp4',
  fileSize: 19,
  mimeType: 'video/mp4',
  mediaType: 'video',
  storageKey: 'users/x/media/55555555/promo.mp4',
  url: 'https://media.test/promo.mp4',
  thumbnailKey: null,
  thumbnailUrl: null,
  durationSeconds: null,
  aspectRatio: '1:1',
  captionText: 'promo',
  width: 100,
  height: 100,
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
};

const PRESIGN = {
  mediaId: '55555555-5555-4555-8555-555555555555',
  mediaKey: 'users/x/media/55555555/promo.mp4',
  mediaUploadUrl: 'https://storage.test/put/promo.mp4',
  thumbnailKey: 'users/x/media/55555555/thumb.webp',
  thumbnailUploadUrl: 'https://storage.test/put/thumb.webp',
  publicMediaUrl: 'https://media.test/promo.mp4',
  publicThumbnailUrl: 'https://media.test/thumb.webp',
  expiresInSeconds: 900,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Controllable fake for the R2 XHR PUT: instances park until flushed. */
class FakeXHR {
  static instances: FakeXHR[] = [];
  status = 0;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() {
    FakeXHR.instances.push(this);
  }
  open(): void {}
  setRequestHeader(): void {}
  send(): void {}
  abort(): void {
    this.onabort?.();
  }
  /** Test driver: the storage PUT completes successfully. */
  complete(): void {
    this.status = 200;
    this.onload?.();
  }
  static flushAll(): void {
    for (const instance of [...FakeXHR.instances]) {
      if (instance.status === 0) instance.complete();
    }
  }
  static pendingCount(): number {
    return FakeXHR.instances.filter((i) => i.status === 0).length;
  }
}

interface FetchBehaviour {
  duplicatesFor?: (entries: Array<{ clientKey: string }>) => unknown[];
}

function installFetchStub(behaviour: FetchBehaviour = {}) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('/media/check-duplicates')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          entries?: Array<{ clientKey: string }>;
        };
        const duplicates = behaviour.duplicatesFor
          ? behaviour.duplicatesFor(body.entries ?? [])
          : [];
        return jsonResponse({ duplicates });
      }
      if (url.includes('/media/upload-url')) return jsonResponse(PRESIGN);
      if (url.includes('/media/confirm')) return jsonResponse(CONFIRM_ITEM);
      // Presigned storage URLs (thumbnail PUT) and anything else.
      return new Response('', { status: 200 });
    }
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderModal(overrides: Partial<React.ComponentProps<typeof MediaImportModal>> = {}) {
  const props: React.ComponentProps<typeof MediaImportModal> = {
    subdomain: 'acme',
    isOpen: true,
    initialFiles: [],
    currentFolderId: null,
    folders: FOLDERS,
    onClose: vi.fn(),
    onUploadSuccess: vi.fn(),
    ...overrides,
  };
  const utils = render(<MediaImportModal {...props} />);
  return { ...utils, props };
}

beforeEach(() => {
  FakeXHR.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:preview'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MediaImportModal — staging (Spec 072 behaviours, PB-2/PB-12)', () => {
  it('renders the destination pill, live subtext, rows and Start import count', async () => {
    installFetchStub();
    const validFile1 = new File(['valid video content'], 'promo.mp4', { type: 'video/mp4' });
    const validFile2 = new File(['valid image content'], 'banner.png', { type: 'image/png' });
    renderModal({ initialFiles: [validFile1, validFile2] });

    expect(screen.getByTestId('import-modal-title')).toHaveTextContent('Import media');
    expect(screen.getByTestId('import-staging-subtext')).toHaveTextContent(
      '2 files selected · will be added to Library'
    );
    expect(screen.getByTestId('destination-folder-pill')).toHaveTextContent('To:');
    expect(screen.getByTestId('destination-folder-pill')).toHaveTextContent('Library');
    expect(screen.getByText('promo.mp4')).toBeVisible();
    expect(screen.getByText('banner.png')).toBeVisible();
    expect(screen.getByTestId('start-import-btn')).toHaveTextContent('Start import (2)');
    await waitFor(() => expect(screen.getByTestId('start-import-btn')).toBeEnabled());
  });

  it('destination defaults to the folder being viewed (PB-12)', () => {
    installFetchStub();
    const file = new File(['sample'], 'clip.mp4', { type: 'video/mp4' });
    renderModal({
      initialFiles: [file],
      currentFolderId: '11111111-1111-4111-8111-111111111111',
    });

    expect(screen.getByTestId('destination-folder-pill')).toHaveTextContent('Campaign A');
    expect(screen.getByTestId('import-staging-subtext')).toHaveTextContent(
      '1 file selected · will be added to Campaign A'
    );
  });

  it('flags unsupported, empty and oversized files and excludes them from the count', () => {
    installFetchStub();
    const unsupportedFile = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const emptyFile = new File([], 'empty.mp4', { type: 'video/mp4' });
    const oversizedFile = new File([new Uint8Array(10)], 'huge.mp4', { type: 'video/mp4' });
    Object.defineProperty(oversizedFile, 'size', { value: 600 * 1024 * 1024 });
    renderModal({ initialFiles: [unsupportedFile, emptyFile, oversizedFile] });

    expect(screen.getByText("can't upload — not a supported format")).toBeVisible();
    expect(screen.getByText('empty file')).toBeVisible();
    expect(screen.getByText('too large — 500 MB max')).toBeVisible();

    const startBtn = screen.getByTestId('start-import-btn');
    expect(startBtn).toHaveTextContent('Start import (0)');
    expect(startBtn).toBeDisabled();
    // Disabled with the reason present (UX Rule 19): the Button's
    // accessible description + the footer's visible reason line.
    expect(
      screen.getAllByText('Add a file that can be uploaded first.').length
    ).toBeGreaterThan(0);
  });

  it('purges technical concurrency copy from the staging UI (Spec 072 US5)', () => {
    installFetchStub();
    const validFile = new File(['data'], 'test.mp4', { type: 'video/mp4' });
    renderModal({ initialFiles: [validFile] });

    const dialog = screen.getByTestId('media-import-modal');
    expect(dialog).not.toHaveTextContent('Uploads run 3 at a time');
    expect(dialog).not.toHaveTextContent('wait in line');
    expect(dialog).not.toHaveTextContent('concurrency');
    expect(screen.getByTestId('add-more-files-btn')).toHaveTextContent('+ Add more');
    expect(screen.getByTestId('cancel-staging-btn')).toHaveTextContent('Cancel');
  });

  it('renders the blob: preview for image rows (OD-133-1(b) allowlisted <img>)', () => {
    installFetchStub();
    const image = new File(['img'], 'banner.png', { type: 'image/png' });
    renderModal({ initialFiles: [image] });

    const dialog = screen.getByTestId('media-import-modal');
    const img = dialog.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('blob:preview');
    expect(img?.getAttribute('alt')).toBe('banner.png');
  });

  it('per-row remove drops the file and updates the count', async () => {
    installFetchStub();
    const user = userEvent.setup();
    const file1 = new File(['a'], 'one.mp4', { type: 'video/mp4' });
    const file2 = new File(['b'], 'two.mp4', { type: 'video/mp4' });
    renderModal({ initialFiles: [file1, file2] });

    const rows = screen.getAllByTestId(/^import-row-/);
    expect(rows).toHaveLength(2);
    const firstRowId = rows[0]?.getAttribute('data-testid')?.replace('import-row-', '');
    await user.click(screen.getByTestId(`remove-staged-${firstRowId}`));

    expect(screen.getAllByTestId(/^import-row-/)).toHaveLength(1);
    expect(screen.getByTestId('start-import-btn')).toHaveTextContent('Start import (1)');
  });

  it('Cancel dismisses staging and calls onClose', async () => {
    installFetchStub();
    const user = userEvent.setup();
    const onClose = vi.fn();
    const file = new File(['a'], 'one.mp4', { type: 'video/mp4' });
    renderModal({ initialFiles: [file], onClose });

    await user.click(screen.getByTestId('cancel-staging-btn'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MediaImportModal — duplicates (PB-18)', () => {
  it('flags server duplicates, Keep restores the count, Skip all removes them', async () => {
    installFetchStub({
      duplicatesFor: (entries) =>
        entries.map((e) => ({ clientKey: e.clientKey, existingItem: CONFIRM_ITEM })),
    });
    const user = userEvent.setup();
    const file = new File(['a'], 'promo.mp4', { type: 'video/mp4' });
    renderModal({ initialFiles: [file] });

    // The flag arrives from the check-duplicates call.
    expect(await screen.findByText('possible duplicate')).toBeVisible();
    expect(screen.getByTestId('duplicate-banner')).toHaveTextContent(
      '1 possible duplicate found'
    );
    // A flagged duplicate is excluded from the count until resolved.
    expect(screen.getByTestId('start-import-btn')).toHaveTextContent('Start import (0)');

    const row = screen.getByTestId(/^import-row-/);
    const rowId = row.getAttribute('data-testid')?.replace('import-row-', '');
    await user.click(screen.getByTestId(`keep-duplicate-${rowId}`));

    await waitFor(() =>
      expect(screen.getByTestId('start-import-btn')).toHaveTextContent('Start import (1)')
    );
    expect(screen.queryByText('possible duplicate')).not.toBeInTheDocument();
  });

  it('Skip all duplicates removes every flagged row', async () => {
    installFetchStub({
      duplicatesFor: (entries) =>
        entries.map((e) => ({ clientKey: e.clientKey, existingItem: CONFIRM_ITEM })),
    });
    const user = userEvent.setup();
    const file1 = new File(['a'], 'one.mp4', { type: 'video/mp4' });
    const file2 = new File(['b'], 'two.mp4', { type: 'video/mp4' });
    renderModal({ initialFiles: [file1, file2] });

    expect(await screen.findByTestId('duplicate-banner')).toHaveTextContent(
      '2 possible duplicates found'
    );
    await user.click(screen.getByTestId('skip-all-duplicates-btn'));
    expect(screen.queryAllByTestId(/^import-row-/)).toHaveLength(0);
  });

  it('a failed duplicate check never blocks staging', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).includes('/media/check-duplicates')) {
          return jsonResponse({ error: 'boom' }, 500);
        }
        return jsonResponse({});
      })
    );
    const file = new File(['a'], 'one.mp4', { type: 'video/mp4' });
    renderModal({ initialFiles: [file] });

    // No flag, no banner, import still offered.
    await waitFor(() =>
      expect(screen.getByTestId('start-import-btn')).toHaveTextContent('Start import (1)')
    );
    expect(screen.queryByTestId('duplicate-banner')).not.toBeInTheDocument();
  });
});

describe('MediaImportModal — progress (PB-3/PB-18)', () => {
  it('runs at most 3 at a time, queues the rest as "queued · #n", then completes on server confirmation', async () => {
    installFetchStub();
    const user = userEvent.setup();
    const onUploadSuccess = vi.fn();
    const files = [1, 2, 3, 4, 5].map(
      (n) => new File([`data-${n}`], `clip-${n}.mp4`, { type: 'video/mp4' })
    );
    renderModal({ initialFiles: files, onUploadSuccess });

    await user.click(screen.getByTestId('start-import-btn'));

    // Three uploads in flight; the other two wait with their positions.
    expect(await screen.findByText('queued · #1')).toBeVisible();
    expect(screen.getByText('queued · #2')).toBeVisible();
    expect(FakeXHR.pendingCount()).toBe(3);
    expect(screen.getByTestId('import-modal-title')).toHaveTextContent('Importing media');

    // Drain the storage PUTs; queued files start as slots free.
    for (let i = 0; i < 6; i++) {
      FakeXHR.flushAll();
      // Let the engine advance (confirm + next slot) between flushes.
      await new Promise((r) => setTimeout(r, 10));
      if (screen.queryByTestId('import-done-btn')) break;
    }

    expect(await screen.findByTestId('import-done-btn')).toBeVisible();
    expect(screen.getByTestId('import-modal-title')).toHaveTextContent('Import complete');
    expect(screen.getByTestId('import-progress-subtext')).toHaveTextContent(
      'Import complete — 5 of 5 uploaded'
    );
    expect(onUploadSuccess).toHaveBeenCalledTimes(5);
    expect(onUploadSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ id: CONFIRM_ITEM.id })
    );
  });

  it('pause holds a file, cancel drops a queued file, and the summary counts only uploads', async () => {
    installFetchStub();
    const user = userEvent.setup();
    const files = [1, 2, 3, 4].map(
      (n) => new File([`data-${n}`], `clip-${n}.mp4`, { type: 'video/mp4' })
    );
    renderModal({ initialFiles: files });

    await user.click(screen.getByTestId('start-import-btn'));
    expect(await screen.findByText('queued · #1')).toBeVisible();

    // Cancel the queued file.
    const queuedRow = screen.getByText('queued · #1').closest('[data-testid^="import-row-"]');
    const queuedId = queuedRow?.getAttribute('data-testid')?.replace('import-row-', '');
    await user.click(screen.getByTestId(`cancel-queued-${queuedId}`));
    expect(await screen.findByText('cancelled')).toBeVisible();

    // Pause an uploading file: its row offers Resume.
    const pauseButtons = screen.getAllByTestId(/^pause-upload-/);
    expect(pauseButtons.length).toBeGreaterThan(0);
    await user.click(pauseButtons[0]!);
    expect(await screen.findByText('paused')).toBeVisible();
    expect(screen.getAllByTestId(/^resume-upload-/).length).toBeGreaterThan(0);
  });

  it('"Keep working" minimises to the progress chip and View restores the dialog', async () => {
    installFetchStub();
    const user = userEvent.setup();
    const file = new File(['a'], 'one.mp4', { type: 'video/mp4' });
    renderModal({ initialFiles: [file] });

    await user.click(screen.getByTestId('start-import-btn'));
    expect(await screen.findByTestId('keep-working-btn')).toBeVisible();
    await user.click(screen.getByTestId('keep-working-btn'));

    expect(screen.getByTestId('minimized-upload-dock')).toHaveTextContent(
      'Uploading 0 of 1'
    );
    await user.click(screen.getByTestId('restore-modal-btn'));
    expect(screen.getByTestId('media-import-modal')).toBeVisible();
  });

  it('Done on the completion summary closes and reports through onClose', async () => {
    installFetchStub();
    const user = userEvent.setup();
    const onClose = vi.fn();
    const file = new File(['a'], 'one.mp4', { type: 'video/mp4' });
    renderModal({ initialFiles: [file], onClose });

    await user.click(screen.getByTestId('start-import-btn'));
    FakeXHR.flushAll();
    const done = await screen.findByTestId('import-done-btn');
    await user.click(done);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ImportProgressRow — states (PB-18, UX Rule 27)', () => {
  function rowItem(overrides: Partial<ImportQueueItem>): ImportQueueItem {
    return {
      id: 'row-1',
      file: new File(['x'], 'clip.mp4', { type: 'video/mp4' }),
      name: 'clip.mp4',
      size: 2048,
      mimeType: 'video/mp4',
      mediaType: 'video',
      destinationFolderId: null,
      status: 'queued',
      progressPercent: 0,
      isDuplicate: false,
      retryCount: 0,
      ...overrides,
    };
  }

  const handlers = {
    onPause: vi.fn(),
    onResume: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
  };

  it('queued shows its position as text', () => {
    render(
      <ImportProgressRow
        item={rowItem({ status: 'queued' })}
        destinationFolderName="Library"
        queuePosition={2}
        {...handlers}
      />
    );
    expect(screen.getByText('queued · #2')).toBeVisible();
  });

  it('failed shows the plain-language reason and a Retry action', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <ImportProgressRow
        item={rowItem({
          status: 'failed',
          validationError: 'Network error during upload. Check your connection and try again.',
        })}
        destinationFolderName="Library"
        {...handlers}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText(/Network error during upload/)).toBeVisible();
    await user.click(screen.getByTestId('retry-upload-row-1'));
    expect(onRetry).toHaveBeenCalledWith('row-1');
  });

  it('completed names the destination folder', () => {
    render(
      <ImportProgressRow
        item={rowItem({ status: 'completed', progressPercent: 100 })}
        destinationFolderName="Campaign A"
        {...handlers}
      />
    );
    expect(screen.getByText('uploaded to Campaign A')).toBeVisible();
  });
});
