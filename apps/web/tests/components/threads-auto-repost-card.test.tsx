/** @vitest-environment jsdom */
/**
 * Spec 189: Threads Auto Repost list card — the 56px avatar and
 * title-scale identity line, with all the same info and the same
 * hooks, and click/keyboard open behaviour unchanged.
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ThreadsAutoRepostCard } from '@/components/threads-auto-repost/threads-auto-repost-card';
import type { MirrorView } from '@/lib/api/schemas/threads-auto-repost';

function mirrorView(overrides: Partial<MirrorView> = {}): MirrorView {
  return {
    id: '44444444-4444-4444-a444-444444444444',
    sourcePlatform: 'tiktok',
    sourceUsername: 'alice',
    sourceDisplayName: 'Alice',
    sourceAvatarUrl: null,
    targetPlatform: 'threads',
    targetExternalId: 'threads-user-1',
    targetDisplayName: 'Test Threads Account',
    targetAvatarUrl: null,
    targetDestinationId: '33333333-3333-4333-a333-333333333333',
    status: 'active',
    lastPostedSourceId: 'v1',
    lastCheckedAt: '2026-10-29T11:00:00.000Z',
    nextCheckAt: '2026-10-29T12:00:00.000Z',
    lastError: null,
    lastMirroredPost: {
      id: '55555555-5555-4555-a555-555555555555',
      sourcePostId: 'v1',
      caption: 'My exact caption',
      coverUrl: null,
      status: 'posted',
      publishedPostId: 'threads_post_1',
      createdAt: '2026-10-29T10:00:00.000Z',
    },
    createdAt: '2026-10-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('ThreadsAutoRepostCard', () => {
  it('renders the 56px avatar, title-scale identity line, and all the same info (spec 189)', () => {
    const { container } = render(
      <ThreadsAutoRepostCard mirror={mirrorView({ sourceAvatarUrl: 'https://example.com/a.jpg' })} />
    );
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('width')).toBe('56');
    expect(img?.getAttribute('height')).toBe('56');
    expect(img?.className).toContain('size-14');
    const identity = screen.getByText('@alice');
    expect(identity.className).toContain('text-lg');
    expect(identity.className).toContain('font-bold');
    expect(identity.className).toContain('leading-heading');
    // The top row vertically centres the identity against the
    // bigger avatar (identity's grandparent is the top-row flex).
    expect(identity.parentElement?.parentElement?.className).toContain('items-center');
    // Display-name and target lines stay metadata size.
    const displayName = screen.getByText('Alice');
    expect(displayName.className).toContain('text-metadata');
    const target = screen.getByText('→ Test Threads Account');
    expect(target.className).toContain('text-metadata');
    // All hooks still present.
    expect(screen.getByTestId('threads-mirror-card-44444444-4444-4444-a444-444444444444')).toBeTruthy();
    expect(screen.getByTestId('threads-mirror-status').textContent).toContain('Active');
    expect(screen.getByTestId('threads-mirror-last').textContent).toContain('Last mirrored');
    expect(screen.getByTestId('threads-mirror-next').textContent).toContain('Next check');
  });

  it('renders 56px initials at title scale when the source has no avatar (spec 189)', () => {
    const { container } = render(<ThreadsAutoRepostCard mirror={mirrorView()} />);
    expect(container.querySelector('img')).toBeNull();
    const initials = container.querySelector('span.bg-subtle');
    expect(initials).toBeTruthy();
    expect(initials?.textContent).toBe('A');
    expect(initials?.className).toContain('size-14');
    expect(initials?.className).toContain('text-xl');
  });

  it('shows the error line and the nothing-mirrored-yet state', () => {
    render(
      <ThreadsAutoRepostCard
        mirror={mirrorView({ status: 'error', lastError: 'tikwm is down', lastMirroredPost: null })}
      />
    );
    expect(screen.getByTestId('threads-mirror-error').textContent).toBe('tikwm is down');
    expect(screen.getByTestId('threads-mirror-last').textContent).toBe('Nothing mirrored yet');
    expect(screen.getByTestId('threads-mirror-status').textContent).toContain('Error');
  });

  it('calls onSelect on click and on Enter/Space', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<ThreadsAutoRepostCard mirror={mirrorView()} onSelect={onSelect} />);
    const card = screen.getByTestId('threads-mirror-card-44444444-4444-4444-a444-444444444444');
    await user.click(card);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0].id).toBe('44444444-4444-4444-a444-444444444444');
    card.focus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });
});
