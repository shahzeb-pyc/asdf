/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { describe, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDownloadJobs } from './download-jobs-data';

/**
 * Spec 152 O3 — the download tray must not poll when nothing is
 * downloading. The old idle 15s poll fired forever on every tenant
 * page. These tests prove the query fetches once on mount when idle
 * and stays quiet, while an active download still polls every 3s.
 */

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  api: apiMocks,
  buildTenantApiPath: (_subdomain: string, path: string) => `/api/tenant/ws${path}`,
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useDownloadJobs idle polling (spec 152 O3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMocks.get.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches once on mount and never polls while idle', async () => {
    apiMocks.get.mockResolvedValue({ jobs: [], consumerHealthy: true });
    renderHook(() => useDownloadJobs('ws'), { wrapper });
    // Flush the mount fetch (fake timers: waitFor would deadlock).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(apiMocks.get).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(apiMocks.get).toHaveBeenCalledTimes(1);
  });

  it('polls every 3s while a download is active', async () => {
    apiMocks.get.mockResolvedValue({
      jobs: [
        {
          id: 'job-1',
          sourceUrl: 'https://example.com/video.mp4',
          status: 'downloading',
          progressPercent: 10,
          downloadedBytes: 100,
          totalBytes: 1000,
          targetFolderId: null,
          errorCode: null,
          errorMessage: null,
        },
      ],
      consumerHealthy: true,
    });
    renderHook(() => useDownloadJobs('ws'), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(apiMocks.get).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    // Mount fetch + one poll per 3s window.
    expect(apiMocks.get.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
