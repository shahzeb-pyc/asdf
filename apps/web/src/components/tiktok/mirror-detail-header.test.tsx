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
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { MirrorDetailHeader } from './mirror-detail-header';
import type { MirrorView } from '@/lib/api/schemas/tiktok-mirrors';

vi.mock('next/image', () => ({
  default: (props: { src?: string; alt?: string }) =>
    React.createElement('img', { src: props.src, alt: props.alt }),
}));

const MIRROR_ID = '00000000-0000-4000-8000-000000000001';

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
    targetDestinationId: null,
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

function renderHeader(m: MirrorView) {
  render(
    <MirrorDetailHeader
      mirror={m}
      backHref="/tiktok-mirrors"
      onPauseResume={vi.fn()}
      pausePending={false}
      onDeleteRequest={vi.fn()}
      accountsHref="/accounts"
    />
  );
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

describe('MirrorDetailHeader Resume lock (spec 155 B2)', () => {
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

  it('Resume is disabled while the live target still carries a Facebook error', () => {
    renderHeader(
      mirror({
        status: 'paused',
        fbStatus: null,
        targetFbStatus: 'missing_permission',
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
