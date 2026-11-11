/**
 * ADU hub cards — followers last-updated line (spec 162).
 *
 * The card shows "Updated <date time>" under the follower total
 * once the daily worker (or ADU creation) has stamped
 * followers_updated_at, in the config's posting timezone — and
 * nothing at all before the first stamp, never a faked time.
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AduHubPage } from './adu-hub-page';

vi.mock('next/image', () => ({
  default: (props: { src?: string; alt?: string }) =>
    React.createElement('img', { src: props.src, alt: props.alt }),
}));

vi.mock('@/components/billing/entitlement-provider', () => ({
  useSharedEntitlement: () => ({ entitlement: null, isLoading: false }),
}));

function config(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    destinationId: 'dest-1',
    destinationName: 'Ellie Blossom',
    destinationExternalId: 'fb-page-101',
    destinationAvatarUrl: null,
    sourcePlatform: 'tiktok',
    sourceUsername: 'someone',
    sourceIdentity: '@someone',
    sourceLink: 'https://tiktok.com/@someone',
    destinationStatus: 'active',
    accountName: 'Shahzeb Malik',
    status: 'active',
    displayStatus: 'Active',
    followersCount: 1000,
    followersGained: 5000,
    followersUpdatedAt: '2026-11-10T22:00:00.000Z',
    timezone: 'Asia/Karachi',
    createdAt: '2026-10-12T00:00:00.000Z',
    postedCount: 3,
    pendingCount: 1,
    failedCount: 0,
    postedToday: 1,
    pendingToday: 0,
    failedToday: 0,
    postsPerDay: 3,
    ...overrides,
  };
}

function stubFetch(configs: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        configs,
        stats: { totalPages: configs.length, followersGained: 4000, totalFollowers: 5000 },
        totalPages: 1,
        migrationMissing: false,
      }),
    }))
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AduHubPage followers last-updated (spec 162)', () => {
  it('shows when the stored total was last updated, in the posting timezone', async () => {
    stubFetch([config()]);
    render(<AduHubPage subdomain="testws" />);
    // 22:00 UTC = 03:00 next day in Asia/Karachi.
    const line = await screen.findByTestId('adu-page-followers-updated');
    expect(line.textContent).toContain('Updated 11 Nov 2026, 03:00');
  });

  it('shows no Updated line before the first stamp (timestamp null)', async () => {
    stubFetch([config({ followersUpdatedAt: null })]);
    render(<AduHubPage subdomain="testws" />);
    await screen.findByTestId('adu-page-followers-line');
    expect(screen.queryByTestId('adu-page-followers-updated')).toBeNull();
  });
});
