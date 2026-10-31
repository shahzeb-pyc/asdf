/**
 * Feature-section cap display — behavioural tests for the
 * entitlement-backed hook and text. The hook reads the billing
 * entitlement endpoint (counts purchased vs usage registered), so
 * the numbers it shows are the numbers the server add endpoints
 * enforce. It renders nothing while loading, on error, for
 * Free/expired users, and for admins (who are never capped) — the
 * shells only ever see a cap for an active paid plan.
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const apiGet = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
  },
  buildTenantApiPath: (subdomain: string, path: string) =>
    `/api/tenant/${encodeURIComponent(subdomain)}${path.startsWith('/') ? path : `/${path}`}`,
  buildUrl: (path: string) => path,
  isApiError: () => false,
}));

import { FeatureCapText, useFeatureCap } from '@/components/billing/feature-cap';

const ZERO = { facebook: 0, instagram: 0, threads: 0, x: 0, tiktok: 0, youtube: 0 };

function entitlement(overrides: Record<string, unknown> = {}) {
  return {
    plan: 'paid',
    active: true,
    counts: { ...ZERO, facebook: 5, instagram: 2, threads: 2 },
    usage: { ...ZERO, facebook: 3, instagram: 1, threads: 0 },
    periodEndsAt: '2099-01-01T00:00:00.000Z',
    periodStartsAt: '2026-01-01T00:00:00.000Z',
    canPost: true,
    readOnly: false,
    reason: null,
    ...overrides,
  };
}

function Probe({
  subdomain = 'acme',
  platform = 'facebook',
}: {
  subdomain?: string;
  platform?: 'facebook' | 'instagram' | 'threads';
}) {
  const { cap, isLoading } = useFeatureCap(subdomain, platform);
  if (isLoading || !cap) return null;
  return <FeatureCapText cap={cap} platform={platform} />;
}

function renderProbe(props: React.ComponentProps<typeof Probe> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Probe {...props} />
    </QueryClientProvider>
  );
}

describe('useFeatureCap + FeatureCapText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Facebook used/remaining in plain language', async () => {
    apiGet.mockResolvedValue(entitlement());
    renderProbe({ platform: 'facebook' });
    expect(await screen.findByTestId('feature-cap-text')).toHaveTextContent(
      '3 of 5 pages used · 2 remaining'
    );
  });

  it('shows accounts (not pages) for Instagram and Threads', async () => {
    apiGet.mockResolvedValue(entitlement());
    renderProbe({ platform: 'instagram' });
    expect(await screen.findByTestId('feature-cap-text')).toHaveTextContent(
      '1 of 2 accounts used · 1 remaining'
    );
  });

  it('shows Limit reached at the cap', async () => {
    apiGet.mockResolvedValue(entitlement({ usage: { ...ZERO, facebook: 5 } }));
    renderProbe({ platform: 'facebook' });
    expect(await screen.findByTestId('feature-cap-text')).toHaveTextContent(
      '5 of 5 pages used · Limit reached'
    );
  });

  it('renders nothing for a Free user', async () => {
    apiGet.mockResolvedValue(entitlement({ plan: 'free', active: false, counts: { ...ZERO } }));
    renderProbe({ platform: 'facebook' });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(screen.queryByTestId('feature-cap-text')).toBeNull();
  });

  it('renders nothing for an expired (inactive) period', async () => {
    apiGet.mockResolvedValue(entitlement({ active: false, canPost: false }));
    renderProbe({ platform: 'facebook' });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(screen.queryByTestId('feature-cap-text')).toBeNull();
  });

  it('renders nothing while loading, then the text once resolved', async () => {
    let resolve!: (value: unknown) => void;
    apiGet.mockImplementation(() => new Promise((r) => { resolve = r; }));
    renderProbe({ platform: 'facebook' });
    expect(screen.queryByTestId('feature-cap-text')).toBeNull();
    resolve(entitlement());
    expect(await screen.findByTestId('feature-cap-text')).toHaveTextContent('3 of 5 pages');
  });

  it('renders nothing on fetch error', async () => {
    apiGet.mockRejectedValue(new Error('boom'));
    renderProbe({ platform: 'facebook' });
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    // Let the rejected query settle into its error state.
    await waitFor(() =>
      expect(screen.queryByTestId('feature-cap-text')).toBeNull()
    );
    expect(screen.queryByTestId('feature-cap-text')).toBeNull();
  });

  it('fetches the entitlement endpoint for the tenant', async () => {
    apiGet.mockResolvedValue(entitlement());
    renderProbe({ subdomain: 'acme', platform: 'threads' });
    await screen.findByTestId('feature-cap-text');
    expect(apiGet).toHaveBeenCalledWith(
      '/api/tenant/acme/billing/entitlement',
      expect.objectContaining({ schema: expect.anything() })
    );
  });
});
