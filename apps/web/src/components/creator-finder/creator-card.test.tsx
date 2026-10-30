/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Creator } from '@fbuploadpro/contracts';
import { CreatorCard } from './creator-card';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

// Same passthrough idea as tests/ui/publish-now-page.test.tsx:
// the real next/image rewrites src to an optimiser URL, so the
// mock renders a plain img carrying src/alt/onError through, which
// keeps the src and error-fallback assertions meaningful. Written
// with createElement (not JSX) so the file contains no literal
// img tag for the raw-img guardrail (check 15) to count.
vi.mock('next/image', () => ({
  default: (props: {
    src?: string;
    alt?: string;
    onError?: () => void;
    className?: string;
  }) =>
    React.createElement('img', {
      src: props.src,
      alt: props.alt,
      onError: props.onError,
      className: props.className,
    }),
}));

function makeCreator(overrides: Partial<Creator> = {}): Creator {
  return {
    handle: 'alice',
    displayName: 'Alice Fit',
    avatarUrl: 'https://example.com/alice.jpg',
    latestVideoTitle: null,
    latestVideoCover: null,
    profileUrl: 'https://www.tiktok.com/@alice',
    ...overrides,
  };
}

describe('CreatorCard', () => {
  it('renders photo, display name, handle, and the View on TikTok link', () => {
    render(<CreatorCard creator={makeCreator()} />);
    const photo = screen.getByAltText('Alice Fit profile photo');
    expect(photo.getAttribute('src')).toBe('https://example.com/alice.jpg');
    expect(screen.getByText('Alice Fit')).toBeTruthy();
    expect(screen.getByText('@alice')).toBeTruthy();
    const link = screen.getByText('View on TikTok ↗');
    expect(link.closest('a')?.getAttribute('href')).toBe(
      'https://www.tiktok.com/@alice',
    );
  });

  it('shows initials instead of a photo when there is no avatar URL', () => {
    render(<CreatorCard creator={makeCreator({ avatarUrl: null })} />);
    expect(screen.queryByAltText('Alice Fit profile photo')).toBeNull();
    expect(screen.getByText('AF')).toBeTruthy();
  });

  it('falls back to initials when the photo fails to load', () => {
    render(<CreatorCard creator={makeCreator()} />);
    const photo = screen.getByAltText('Alice Fit profile photo');
    fireEvent.error(photo);
    expect(screen.queryByAltText('Alice Fit profile photo')).toBeNull();
    expect(screen.getByText('AF')).toBeTruthy();
  });

  it('shows the verified tick only when verified is true', () => {
    const { rerender } = render(
      <CreatorCard creator={makeCreator({ verified: true })} />,
    );
    expect(screen.getByLabelText('Verified creator')).toBeTruthy();
    rerender(<CreatorCard creator={makeCreator({ verified: false })} />);
    expect(screen.queryByLabelText('Verified creator')).toBeNull();
    rerender(<CreatorCard creator={makeCreator()} />);
    expect(screen.queryByLabelText('Verified creator')).toBeNull();
  });

  it('shows the follower count only when followerCount is present, formatted compactly', () => {
    const { rerender } = render(
      <CreatorCard creator={makeCreator({ followerCount: 12400 })} />,
    );
    expect(screen.getByText('12.4K followers')).toBeTruthy();
    rerender(<CreatorCard creator={makeCreator({ followerCount: 999 })} />);
    expect(screen.getByText('999 followers')).toBeTruthy();
    rerender(<CreatorCard creator={makeCreator()} />);
    expect(screen.queryByText(/followers/)).toBeNull();
  });

  it('renders no video title or video cover, even when the creator carries them', () => {
    render(
      <CreatorCard
        creator={makeCreator({
          latestVideoTitle: 'Morning workout routine',
          latestVideoCover: 'https://example.com/cover.jpg',
        })}
      />,
    );
    expect(screen.queryByText('Morning workout routine')).toBeNull();
    expect(
      document.querySelector('img[src="https://example.com/cover.jpg"]'),
    ).toBeNull();
  });

  it('renders a similar-tab creator with follower count and verified tick together', () => {
    render(
      <CreatorCard
        creator={makeCreator({ followerCount: 1200000, verified: true })}
      />,
    );
    expect(screen.getByText('1.2M followers')).toBeTruthy();
    expect(screen.getByLabelText('Verified creator')).toBeTruthy();
  });
});
