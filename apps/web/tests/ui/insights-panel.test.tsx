import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PageTabInsights } from '@/components/pages/dedicated/insights-panel';
import { insightsCacheKey } from '@/lib/insights/insights-local-cache';

function livePayload(fetchedAt: string, mediaViews = 500) {
  return {
    success: true,
    pageId: 'page-1',
    range: '28d',
    fetchedAt,
    kpis: {
      followers: 100,
      mediaViews,
      uniqueViewersDailySum: 300,
      engagements: 40,
      engagementRatePct: 8,
      netFollowerGrowth: 5,
      videoWatchTimeMinutes: 90,
    },
    trend: [{ date: '2026-10-27', views: 10, viewers: 8 }],
    reactions: [{ kind: 'like', count: 30, sharePct: 100 }],
    topCountries: [{ name: 'US', count: 50, sharePct: 50 }],
    topCities: [],
  };
}

describe('rebuilt insights panel (local 1-hour cache + Sync)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  function renderPanel() {
    return render(
      <PageTabInsights page={{ id: 'page-1' }} subdomain="acme" />,
    );
  }

  it('shows fresh local data immediately without fetching', async () => {
    localStorage.setItem(
      insightsCacheKey('page-1', '28d'),
      JSON.stringify(livePayload(new Date().toISOString(), 500)),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    expect(await screen.findByTestId('insights-kpi-grid')).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches live when the local entry is older than one hour', async () => {
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    localStorage.setItem(insightsCacheKey('page-1', '28d'), JSON.stringify(livePayload(old, 111)));
    const fetchMock = vi.fn(async (): Promise<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }> => ({
      ok: true,
      status: 200,
      json: async () => livePayload(new Date().toISOString(), 777),
    }));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    expect(await screen.findByTestId('insights-kpi-grid')).toBeInTheDocument();
    expect(screen.getByText('777')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The fresh payload overwrote the stale local entry.
    const stored = JSON.parse(localStorage.getItem(insightsCacheKey('page-1', '28d')) as string);
    expect(stored.kpis.mediaViews).toBe(777);
  });

  it('Sync always fetches live even with fresh local data, and Retry recovers from failure', async () => {
    localStorage.setItem(
      insightsCacheKey('page-1', '28d'),
      JSON.stringify(livePayload(new Date().toISOString(), 500)),
    );
    const fetchMock = vi.fn(async (): Promise<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }> => ({
      ok: true,
      status: 200,
      json: async () => livePayload(new Date().toISOString(), 999),
    }));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel();
    expect(await screen.findByTestId('insights-kpi-grid')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('insights-sync-btn'));
    await waitFor(() => expect(screen.getByText('999')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Now fail, then recover via Retry.
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 502, json: async () => ({}) }));
    fireEvent.click(screen.getByTestId('insights-sync-btn'));
    expect(await screen.findByText(/Couldn't load insights/)).toBeInTheDocument();
    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => livePayload(new Date().toISOString(), 4242),
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('4,242')).toBeInTheDocument());
  });
});
