/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ZERO_PLATFORM_COUNTS, type EntitlementResponse } from '@fbuploadpro/contracts';

import { TikTokShell } from './tiktok-shell';

vi.mock('next/image', () => ({
  default: (props: { src?: string; alt?: string }) =>
    React.createElement('img', { src: props.src, alt: props.alt }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

const getMock = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      get: (...args: unknown[]) => getMock(...args),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  };
});

// The real useFeatureCap derives both caps from this shared
// entitlement — only the provider is mocked, so the tests prove
// the shell shows the numbers the server gates enforce.
const entitlementState = vi.hoisted(() => ({
  value: null as EntitlementResponse | null,
}));

vi.mock('@/components/billing/entitlement-provider', () => ({
  useSharedEntitlement: () => ({ entitlement: entitlementState.value, isLoading: false }),
}));

function entitlement(partial: Partial<EntitlementResponse>): EntitlementResponse {
  return {
    plan: 'paid',
    active: true,
    counts: ZERO_PLATFORM_COUNTS,
    usage: ZERO_PLATFORM_COUNTS,
    periodEndsAt: null,
    periodStartsAt: null,
    canPost: true,
    readOnly: false,
    reason: null,
    hasPriorPeriod: true,
    ...partial,
  };
}

let mirrorId = 0;
function mirror(overrides: Record<string, unknown> = {}) {
  mirrorId += 1;
  return {
    id: `00000000-0000-4000-8000-0000000000${String(mirrorId).padStart(2, '0')}`,
    sourcePlatform: 'tiktok',
    sourceUsername: 'someone',
    sourceDisplayName: null,
    sourceAvatarUrl: null,
    targetPlatform: 'facebook',
    targetExternalId: 'fb-1',
    targetDisplayName: 'Page One',
    targetAvatarUrl: null,
    targetDestinationId: null,
    targetAddedAt: null,
    targetFollowers: null,
    targetCategory: null,
    targetAccountDisplayName: null,
    targetAccountAvatarUrl: null,
    targetStartingFollowers: null,
    status: 'active',
    lastPostedSourceId: null,
    lastCheckedAt: null,
    lastError: null,
    createdAt: '2026-10-12T00:00:00.000Z',
    postCounts: { posted: 1, failed: 0 },
    postCountsError: false,
    ...overrides,
  };
}

function listResponse(mirrors: ReturnType<typeof mirror>[]) {
  return {
    mirrors,
    total: mirrors.length,
    totalPages: 1,
    page: 1,
  };
}

afterEach(() => { cleanup(); });

beforeEach(() => {
  vi.clearAllMocks();
  mirrorId = 0;
  entitlementState.value = null;
  getMock.mockResolvedValue(listResponse([]));
});

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TikTokShell subdomain="creatorstack" />
    </QueryClientProvider>
  );
}

function capTexts() {
  return screen.getAllByTestId('feature-cap-text').map((el) => el.textContent);
}

describe('TikTokShell plan cap (B2)', () => {
  it('shows the Facebook cap for Facebook-target mirrors', async () => {
    entitlementState.value = entitlement({
      counts: { ...ZERO_PLATFORM_COUNTS, facebook: 5, instagram: 3 },
      usage: { ...ZERO_PLATFORM_COUNTS, facebook: 2, instagram: 1 },
    });
    getMock.mockResolvedValue(listResponse([mirror({ targetPlatform: 'facebook' })]));
    renderShell();
    await waitFor(() => {
      expect(screen.getByTestId('tiktok-mirrors-grid')).toBeInTheDocument();
    });
    expect(capTexts()).toEqual(['2 of 5 pages used · 3 remaining']);
    expect(screen.getByTestId('header-add-mirror-btn')).not.toBeDisabled();
  });

  it('shows the Instagram cap — not the Facebook cap — for Instagram-target mirrors', async () => {
    // This is the B2 bug: the server gates a TikTok→Instagram
    // mirror on Instagram's cap, but the shell used to display
    // Facebook's numbers for it.
    entitlementState.value = entitlement({
      counts: { ...ZERO_PLATFORM_COUNTS, facebook: 5, instagram: 3 },
      usage: { ...ZERO_PLATFORM_COUNTS, facebook: 2, instagram: 1 },
    });
    getMock.mockResolvedValue(listResponse([mirror({ targetPlatform: 'instagram' })]));
    renderShell();
    await waitFor(() => {
      expect(screen.getByTestId('tiktok-mirrors-grid')).toBeInTheDocument();
    });
    expect(capTexts()).toEqual(['1 of 3 accounts used · 2 remaining']);
    expect(capTexts().join(' ')).not.toContain('pages used');
  });

  it('shows one cap line per target when the list mixes Facebook and Instagram mirrors', async () => {
    entitlementState.value = entitlement({
      counts: { ...ZERO_PLATFORM_COUNTS, facebook: 5, instagram: 3 },
      usage: { ...ZERO_PLATFORM_COUNTS, facebook: 2, instagram: 1 },
    });
    getMock.mockResolvedValue(
      listResponse([
        mirror({ targetPlatform: 'facebook' }),
        mirror({ targetPlatform: 'instagram', targetExternalId: 'ig-1', targetDisplayName: 'IG One' }),
      ])
    );
    renderShell();
    await waitFor(() => {
      expect(screen.getByTestId('tiktok-mirrors-grid')).toBeInTheDocument();
    });
    expect(capTexts()).toEqual([
      '2 of 5 pages used · 3 remaining',
      '1 of 3 accounts used · 2 remaining',
    ]);
  });

  it('shows the Facebook cap when there are no mirrors yet — that is the target being added', async () => {
    entitlementState.value = entitlement({
      counts: { ...ZERO_PLATFORM_COUNTS, facebook: 5, instagram: 3 },
      usage: { ...ZERO_PLATFORM_COUNTS, facebook: 2, instagram: 1 },
    });
    getMock.mockResolvedValue(listResponse([]));
    renderShell();
    await waitFor(() => {
      expect(screen.getByTestId('tiktok-empty-state')).toBeInTheDocument();
    });
    // Header line + empty-state line, both the Facebook cap: the
    // Add dialog only creates Facebook-target mirrors.
    expect(capTexts()).toEqual([
      '2 of 5 pages used · 3 remaining',
      '2 of 5 pages used · 3 remaining',
    ]);
    expect(screen.getByTestId('header-add-mirror-btn')).not.toBeDisabled();
    expect(screen.getByTestId('tiktok-empty-add-btn')).not.toBeDisabled();
  });

  it('disables Add at the Facebook cap even when the Instagram cap still has room', async () => {
    entitlementState.value = entitlement({
      counts: { ...ZERO_PLATFORM_COUNTS, facebook: 2, instagram: 3 },
      usage: { ...ZERO_PLATFORM_COUNTS, facebook: 2, instagram: 1 },
    });
    getMock.mockResolvedValue(listResponse([mirror({ targetPlatform: 'facebook' })]));
    renderShell();
    await waitFor(() => {
      expect(screen.getByTestId('tiktok-mirrors-grid')).toBeInTheDocument();
    });
    expect(capTexts()).toEqual(['2 of 2 pages used · Limit reached']);
    expect(screen.getByTestId('header-add-mirror-btn')).toBeDisabled();
  });

  it('keeps Add enabled at the Instagram cap when the Facebook cap still has room', async () => {
    // The Add dialog creates a Facebook-target mirror, so only the
    // Facebook cap gates it — an Instagram cap must not block it.
    entitlementState.value = entitlement({
      counts: { ...ZERO_PLATFORM_COUNTS, facebook: 5, instagram: 1 },
      usage: { ...ZERO_PLATFORM_COUNTS, facebook: 2, instagram: 1 },
    });
    getMock.mockResolvedValue(listResponse([mirror({ targetPlatform: 'instagram' })]));
    renderShell();
    await waitFor(() => {
      expect(screen.getByTestId('tiktok-mirrors-grid')).toBeInTheDocument();
    });
    expect(capTexts()).toEqual(['1 of 1 accounts used · Limit reached']);
    expect(screen.getByTestId('header-add-mirror-btn')).not.toBeDisabled();
  });

  it('shows no cap line when the entitlement is unproven', async () => {
    entitlementState.value = null;
    getMock.mockResolvedValue(listResponse([mirror({ targetPlatform: 'facebook' })]));
    renderShell();
    await waitFor(() => {
      expect(screen.getByTestId('tiktok-mirrors-grid')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('feature-cap-text')).not.toBeInTheDocument();
    expect(screen.getByTestId('header-add-mirror-btn')).not.toBeDisabled();
  });
});
