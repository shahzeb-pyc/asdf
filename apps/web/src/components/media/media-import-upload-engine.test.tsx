/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { describe, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ApiError } from '@/lib/api';
import {
  useImportUpload,
  isNetworkUploadError,
} from './media-import-upload-engine';
import type { ImportQueueItem } from './media-types';

/**
 * Spec 215 — a flapping connection must not kill a large upload.
 * Shahzeb's 12.6 MB file died ~129 KB into part 1 and the old 3-retry
 * budget (~7s) gave up while the connection was still down. These
 * tests prove a transient network error on a part is retried and the
 * upload completes, that the network budget is 5 retries, and that
 * non-network errors keep the 3-retry budget.
 */

const apiMocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    kind: string;
    status: number | undefined;
    constructor(kind: string, message: string, options: { status?: number } = {}) {
      super(message);
      this.name = 'ApiError';
      this.kind = kind;
      this.status = options.status;
    }
  }
  return {
    api: { post: apiMocks.post, get: vi.fn() },
    buildTenantApiPath: (_subdomain: string, path: string) => path,
    isApiError: (value: unknown) => value instanceof ApiError,
    ApiError,
  };
});

vi.mock('./media-import-utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('./media-import-utils')>();
  return {
    ...original,
    generateThumbnailBlob: vi
      .fn()
      .mockResolvedValue({ blob: null, width: null, height: null, duration: null }),
    probeVideoMetadata: vi.fn().mockResolvedValue(null),
  };
});

/** 12.6 MB, like Shahzeb's file: 2 parts of 8 MiB. */
const FILE_SIZE = Math.round(12.6 * 1024 * 1024);

function makeItem(): ImportQueueItem {
  const file = new File([new ArrayBuffer(FILE_SIZE)], 'clip.mp4', {
    type: 'video/mp4',
  });
  return {
    id: 'item-1',
    file,
    name: 'clip.mp4',
    size: FILE_SIZE,
    mimeType: 'video/mp4',
    mediaType: 'video',
    destinationFolderId: null,
    status: 'queued',
    progressPercent: 0,
    isDuplicate: false,
    validationError: null,
    retryCount: 0,
  };
}

/** Minimal XHR: fails `onerror` N times per URL, then 200s. */
class FakeXHR {
  static puts: { url: string }[] = [];
  static failures = new Map<string, number>();
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  private url = '';
  open(_method: string, url: string): void {
    this.url = url;
  }
  setRequestHeader(): void {}
  abort(): void {}
  send(): void {
    FakeXHR.puts.push({ url: this.url });
    const remaining = FakeXHR.failures.get(this.url) ?? 0;
    if (remaining > 0) {
      FakeXHR.failures.set(this.url, remaining - 1);
      this.onerror?.();
    } else {
      this.status = 200;
      this.onload?.();
    }
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

function multipartApiResponse(
  path: string,
  body: Record<string, unknown>
): unknown {
  if (path.endsWith('/media/multipart/initiate')) {
    return {
      mediaId: 'media-1',
      mediaKey: 'key-1',
      uploadId: 'upload-1',
      thumbnailUploadUrl: null,
      thumbnailKey: null,
      publicMediaUrl: 'https://example.invalid/media-1',
      publicThumbnailUrl: null,
    };
  }
  if (path.endsWith('/media/multipart/part-url')) {
    return { uploadUrl: `https://r2.invalid/part-${body.partNumber}` };
  }
  if (path.endsWith('/media/multipart/complete')) {
    return { ok: true };
  }
  if (path.endsWith('/media/confirm')) {
    return {
      id: 'media-1',
      userId: 'user-1',
      folderId: null,
      name: 'clip.mp4',
      fileSize: FILE_SIZE,
      mimeType: 'video/mp4',
      mediaType: 'video',
      storageKey: 'key-1',
      url: 'https://example.invalid/media-1',
      thumbnailKey: null,
      thumbnailUrl: null,
      durationSeconds: null,
      aspectRatio: '16:9',
      captionText: 'clip',
      width: 1920,
      height: 1080,
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
    };
  }
  throw new Error(`unexpected api.post: ${path}`);
}

const queueRef: { current: ImportQueueItem[] } = { current: [] };
let successCount = 0;

/**
 * Drive the fake clock until the item reaches a terminal state.
 *
 * `advanceTimersByTimeAsync` alone does not flush the microtask chain
 * (an in-flight `api.post`) before the next timer fires, so a long
 * jump strands the attempt on its 30s step timeout — and the mocked
 * `api.post` ignores the abort signal, so it never settles. Flushing
 * microtasks with a 0ms advance between small clock steps keeps every
 * attempt's API calls resolving before any timeout can fire.
 */
async function driveUntilSettled(maxMs = 60_000, stepMs = 250): Promise<void> {
  let elapsed = 0;
  while (elapsed < maxMs) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const item = queueRef.current[0];
    if (item.status === 'completed' || item.status === 'failed') return;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(stepMs);
    });
    elapsed += stepMs;
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function Harness({ initialQueue }: { initialQueue: ImportQueueItem[] }) {
  const [queue, setQueue] = React.useState(initialQueue);
  const [step, setStep] = React.useState<'staging' | 'progress' | 'complete'>(
    'progress'
  );
  queueRef.current = queue;
  useImportUpload({
    subdomain: 'ws',
    selectedFolderId: null,
    queue,
    step,
    setQueue,
    setStep,
    updateItemProgress: (id, pct) =>
      setQueue((prev) =>
        prev.map((it) => (it.id === id ? { ...it, progressPercent: pct } : it))
      ),
    onUploadSuccess: () => {
      successCount += 1;
    },
  });
  return null;
}

const RealXHR = globalThis.XMLHttpRequest;

describe('multipart network-error retries (spec 215)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMocks.post.mockReset();
    apiMocks.post.mockImplementation(async (path: string, body: Record<string, unknown>) =>
      multipartApiResponse(path, body)
    );
    FakeXHR.puts = [];
    FakeXHR.failures = new Map();
    successCount = 0;
    queueRef.current = [];
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.XMLHttpRequest = RealXHR;
  });

  it('retries a transient network error on part 1 and completes', async () => {
    // Part 1 drops twice, then the connection recovers.
    FakeXHR.failures.set('https://r2.invalid/part-1', 2);
    render(<Harness initialQueue={[makeItem()]} />);
    await driveUntilSettled();

    const item = queueRef.current[0];
    expect(item.status).toBe('completed');
    expect(item.retryCount).toBe(2);
    expect(successCount).toBe(1);
    // Part 1 was PUT 3 times (2 failures + 1 success); part 2 once.
    // A completed part is never re-PUT: part 1 stops at 3.
    const part1Puts = FakeXHR.puts.filter((p) => p.url === 'https://r2.invalid/part-1');
    const part2Puts = FakeXHR.puts.filter((p) => p.url === 'https://r2.invalid/part-2');
    expect(part1Puts).toHaveLength(3);
    expect(part2Puts).toHaveLength(1);
  });

  it('fails only after 5 network retries when the connection stays down', async () => {
    FakeXHR.failures.set('https://r2.invalid/part-1', 99);
    render(<Harness initialQueue={[makeItem()]} />);
    await driveUntilSettled();

    const item = queueRef.current[0];
    expect(item.status).toBe('failed');
    expect(item.retryCount).toBe(5);
    expect(item.validationError).toBe(
      'Network error during upload. Check your connection and try again.'
    );
    // 6 attempts total (1 + 5 retries), then it gives up.
    expect(
      FakeXHR.puts.filter((p) => p.url === 'https://r2.invalid/part-1')
    ).toHaveLength(6);
    expect(successCount).toBe(0);
  });

  it('keeps the 3-retry budget for non-network errors', async () => {
    apiMocks.post.mockImplementation(async (path: string, body: Record<string, unknown>) => {
      if (path.endsWith('/media/multipart/part-url')) {
        throw new ApiError('http', 'Internal Server Error', { status: 500 });
      }
      return multipartApiResponse(path, body);
    });
    render(<Harness initialQueue={[makeItem()]} />);
    await driveUntilSettled();

    const item = queueRef.current[0];
    expect(item.status).toBe('failed');
    expect(item.retryCount).toBe(3);
    expect(item.validationError).toBe("Couldn't start the upload. Please try again.");
    // One presign per attempt (4 attempts), no part ever PUT, and the
    // initiate step ran once — retries resume the same upload.
    const partUrlCalls = apiMocks.post.mock.calls.filter(([p]) =>
      (p as string).endsWith('/media/multipart/part-url')
    );
    const initiateCalls = apiMocks.post.mock.calls.filter(([p]) =>
      (p as string).endsWith('/media/multipart/initiate')
    );
    expect(partUrlCalls).toHaveLength(4);
    expect(initiateCalls).toHaveLength(1);
    expect(FakeXHR.puts).toHaveLength(0);
    expect(successCount).toBe(0);
  });
});

describe('isNetworkUploadError', () => {
  it('classifies the XHR network error', () => {
    expect(
      isNetworkUploadError(
        new Error('Network error during upload. Check your connection and try again.')
      )
    ).toBe(true);
  });

  it('classifies typed-client network errors', () => {
    expect(
      isNetworkUploadError(new ApiError('network', 'The request could not be completed.'))
    ).toBe(true);
  });

  it('classifies fetch failures', () => {
    expect(isNetworkUploadError(new Error('Failed to fetch'))).toBe(true);
  });

  it('does not classify HTTP or timeout errors as network errors', () => {
    expect(
      isNetworkUploadError(new ApiError('http', 'Internal Server Error', { status: 500 }))
    ).toBe(false);
    expect(
      isNetworkUploadError(
        new Error('Upload failed (server responded 500). Please try again.')
      )
    ).toBe(false);
    expect(isNetworkUploadError(new Error('Upload timed out. Check your connection and try again.'))).toBe(
      false
    );
  });
});
