/**
 * Mirror detail header — spec 155 SEND BACK fix (PR 199, B2).
 *
 * The banner replaces the raw-error box for a mapped Facebook error,
 * and Resume must NOT deadlock on the mirror's own stored detail:
 * error -> pause -> target recovers -> Resume is enabled again (the
 * live target detail is the authority while paused; the tick clears
 * the stale own detail on the first clean check after resume).
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { MirrorDetailHeader } from './mirror-detail-header';
import type { MirrorView } from '@/lib/api/schemas/tiktok-mirrors';

vi.mock('next/image', () => ({
  default: (props: { src?: string; alt?: string }) =>
    React.createElement('img', { src: props.src, alt: props.alt }),
}));

const MIRROR_ID = '00000000-0000-4000-8000-000000000001';
const TARGET_DESTINATION_ID = '00000000-0000-4000-8000-000000000002';

function mirror(overrides: Partial<MirrorView> = {}): MirrorView {
  return {
    id: MIRROR_ID,
    sourcePlatform: 'tiktok',
    sourceUsername: 'alice',
    sourceDisplayName: null,
    sourceAvatarUrl: null,
    targetPlatform: 'facebook',
    targetExternalId: 'fb-1',
    targetDisplayName: 'Test Page',
    targetAvatarUrl: null,
    targetDestinationId: TARGET_DESTINATION_ID,
    targetStatus: 'active',
    status: 'active',
    lastPostedSourceId: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    lastError: null,
    fbStatus: null,
    fbRateLimitedAt: null,
    targetFbStatus: null,
    lastMirroredPost: null,
    createdAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
}

function renderHeader(
  m: MirrorView,
  opts: { onPauseResume?: Mock<() => void>; pausePending?: boolean } = {}
) {
  const onPauseResume = opts.onPauseResume ?? vi.fn();
  const utils = render(
    <MirrorDetailHeader
      mirror={m}
      backHref="/tiktok-mirrors"
      onPauseResume={onPauseResume}
      pausePending={opts.pausePending ?? false}
      onDeleteRequest={vi.fn()}
      accountsHref="/accounts"
    />
  );
  return { ...utils, onPauseResume };
}

/** Opens the ••• menu and returns the Pause/Resume item. */
function openMenuResumeItem(): HTMLElement {
  fireEvent.click(screen.getByTestId('mirror-detail-menu-btn'));
  return screen.getByTestId('mirror-detail-menu-pause');
}

describe('MirrorDetailHeader Facebook banner (spec 155)', () => {
  it('shows the mapped banner instead of the raw-error box for a Facebook error', () => {
    renderHeader(
      mirror({
        status: 'error',
        fbStatus: 'missing_permission',
        lastError: 'Permissions error',
      })
    );
    expect(screen.getByTestId('mirror-status-banner-missing_permission')).toBeDefined();
    expect(screen.getByText('Missing Permission')).toBeDefined();
    expect(screen.queryByTestId('tiktok-detail-error')).toBeNull();
  });

  it('keeps the raw-error box for a generic error with no detail anywhere', () => {
    renderHeader(
      mirror({ status: 'error', fbStatus: null, targetFbStatus: null, lastError: 'boom' })
    );
    expect(screen.queryByTestId('tiktok-detail-error')).not.toBeNull();
    expect(document.querySelector('[data-testid^="mirror-status-banner-"]')).toBeNull();
  });
});

describe('MirrorDetailHeader Resume lock (spec 155 B2, spec 239)', () => {
  it('Resume stays enabled when the mirror carries its own detail but the target recovered', () => {
    renderHeader(
      mirror({
        status: 'paused',
        fbStatus: 'missing_permission',
        targetFbStatus: null,
      })
    );
    const item = openMenuResumeItem();
    expect(item.textContent).toContain('Resume');
    expect(item.hasAttribute('disabled')).toBe(false);
  });

  it('Resume is enabled while the live target carries a Facebook error (spec 239)', () => {
    renderHeader(
      mirror({
        status: 'paused',
        fbStatus: null,
        targetFbStatus: 'missing_permission',
        targetStatus: 'error',
      })
    );
    const item = openMenuResumeItem();
    expect(item.textContent).toContain('Resume');
    expect(item.hasAttribute('disabled')).toBe(false);
  });

  it('Resume is enabled while the live target is rate limited (spec 239)', () => {
    renderHeader(
      mirror({
        status: 'paused',
        fbStatus: null,
        targetFbStatus: 'fb_rate_limited',
        targetStatus: 'rate_limited',
      })
    );
    const item = openMenuResumeItem();
    expect(item.textContent).toContain('Resume');
    expect(item.hasAttribute('disabled')).toBe(false);
  });

  it('Resume is disabled while the target is missing (spec 239)', () => {
    renderHeader(
      mirror({
        status: 'paused',
        fbStatus: null,
        targetFbStatus: null,
        targetDestinationId: null,
        targetStatus: null,
      })
    );
    const item = openMenuResumeItem();
    expect(item.textContent).toContain('Resume');
    expect(item.hasAttribute('disabled')).toBe(true);
  });

  it('Resume is disabled while the target is disconnected (spec 239)', () => {
    renderHeader(
      mirror({
        status: 'paused',
        fbStatus: null,
        targetFbStatus: null,
        targetStatus: 'disconnected',
      })
    );
    const item = openMenuResumeItem();
    expect(item.textContent).toContain('Resume');
    expect(item.hasAttribute('disabled')).toBe(true);
  });

  it('Resume stays enabled for a plain paused mirror with no error anywhere', () => {
    renderHeader(mirror({ status: 'paused', fbStatus: null, targetFbStatus: null }));
    const item = openMenuResumeItem();
    expect(item.textContent).toContain('Resume');
    expect(item.hasAttribute('disabled')).toBe(false);
  });
});

describe('MirrorDetailHeader followers last-updated (spec 162)', () => {
  it('shows when the stored total was last updated once the worker stamped it', () => {
    renderHeader(
      mirror({
        targetFollowers: 5000,
        targetStartingFollowers: 4000,
        followersUpdatedAt: '2026-11-10T12:00:00.000Z',
      })
    );
    expect(screen.getByTestId('mirror-detail-followers')).toBeDefined();
    expect(screen.getByTestId('mirror-detail-followers-updated').textContent).toContain(
      'Updated 10 Nov 2026'
    );
  });

  it('shows no Updated line before the first worker run (timestamp null)', () => {
    renderHeader(
      mirror({
        targetFollowers: 5000,
        targetStartingFollowers: 4000,
        followersUpdatedAt: null,
      })
    );
    expect(screen.getByTestId('mirror-detail-followers')).toBeDefined();
    expect(screen.queryByTestId('mirror-detail-followers-updated')).toBeNull();
  });
});

describe('MirrorDetailHeader automation toggle (spec 255)', () => {
  /** Re-renders the header with the same props but a new pending state. */
  function rerenderWithPending(
    rerender: (ui: React.ReactElement) => void,
    m: MirrorView,
    onPauseResume: Mock<() => void>,
    pausePending: boolean
  ) {
    rerender(
      <MirrorDetailHeader
        mirror={m}
        backHref="/tiktok-mirrors"
        onPauseResume={onPauseResume}
        pausePending={pausePending}
        onDeleteRequest={vi.fn()}
        accountsHref="/accounts"
      />
    );
  }

  it('double-clicking Pause while the toggle is in flight fires exactly one onPauseResume call', () => {
    const onPauseResume = vi.fn<() => void>();
    renderHeader(mirror({ status: 'active' }), { onPauseResume });
    const item = openMenuResumeItem();
    expect(item.textContent).toContain('Pause');
    // Two rapid clicks while the first mutation is still in flight.
    fireEvent.click(item);
    fireEvent.click(item);
    expect(onPauseResume).toHaveBeenCalledTimes(1);
    // The menu stays open while the toggle runs, so the working
    // state is visible instead of the menu vanishing on click.
    expect(screen.getByTestId('mirror-detail-menu')).toBeDefined();
  });

  it('shows Updating... and disables the toggle while pending, then returns to Pause on settle', () => {
    const onPauseResume = vi.fn<() => void>();
    const m = mirror({ status: 'active' });
    const { rerender } = renderHeader(m, { onPauseResume });
    const item = openMenuResumeItem();
    fireEvent.click(item);
    expect(onPauseResume).toHaveBeenCalledTimes(1);
    // The shell re-renders with the mutation pending.
    rerenderWithPending(rerender, m, onPauseResume, true);
    const pendingItem = screen.getByTestId('mirror-detail-menu-pause');
    expect(pendingItem.textContent).toContain('Updating...');
    expect(pendingItem.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('mirror-detail-menu-btn').hasAttribute('disabled')).toBe(true);
    // Settle (success or failure): the menu closes and the toggle
    // is back at Pause, live again.
    rerenderWithPending(rerender, m, onPauseResume, false);
    expect(screen.queryByTestId('mirror-detail-menu')).toBeNull();
    const itemAgain = openMenuResumeItem();
    expect(itemAgain.textContent).toContain('Pause');
    expect(itemAgain.hasAttribute('disabled')).toBe(false);
    fireEvent.click(itemAgain);
    expect(onPauseResume).toHaveBeenCalledTimes(2);
  });
});
