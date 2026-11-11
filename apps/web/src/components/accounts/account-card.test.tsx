/** @vitest-environment jsdom */
/**
 * AccountCard avatar (spec 170 F4): the Facebook profile photo must load
 * directly from its stored URL — never through the Vercel image optimiser
 * (`/_next/image`), which 402s on these URLs
 * (OPTIMIZED_IMAGE_REQUEST_PAYMENT_REQUIRED) and left every card on
 * initials. These tests pin the direct `<img>`: the rendered src is the
 * stored URL verbatim, at 44px in the coloured status ring, with the
 * initials fallback intact when the URL is absent or the image fails.
 */
import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AccountCard, type FacebookAccountItem } from './account-card';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ subdomain: 'acme' }),
}));

const AVATAR_URL = 'https://graph.facebook.com/1234567890/picture?type=large';
const PAGE_AVATAR_URL = 'https://graph.facebook.com/0987654321/picture?type=small';

function makeAccount(
  overrides: Partial<FacebookAccountItem> = {}
): FacebookAccountItem {
  return {
    id: '11111111-1111-4111-a111-111111111111',
    fbAccountId: '1234567890',
    displayName: 'Shahzeb Malik',
    profilePictureUrl: AVATAR_URL,
    status: 'active',
    tokenExpiresAt: '2099-01-01T00:00:00.000Z',
    connectedPagesCount: 0,
    createdAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('AccountCard avatar (spec 170 F4)', () => {
  it('renders the stored avatar URL directly, never via /_next/image', () => {
    const { container } = render(<AccountCard account={makeAccount()} />);
    const img = screen.getByTestId('account-avatar-img');
    expect(img.tagName).toBe('IMG');
    // A next/image optimiser URL would be /_next/image?url=... — the
    // direct load keeps the stored URL verbatim.
    expect(img.getAttribute('src')).toBe(AVATAR_URL);
    expect(container.innerHTML).not.toContain('/_next/image');
  });

  it('keeps the 44px circle and the connected status ring', () => {
    render(<AccountCard account={makeAccount()} />);
    const img = screen.getByTestId('account-avatar-img');
    expect(img.getAttribute('width')).toBe('44');
    expect(img.getAttribute('height')).toBe('44');
    expect(img.className).toContain('size-11');
    expect(img.className).toContain('rounded-full');
    expect(img.className).toContain('border-signal-operational');
  });

  it('falls back to initials when no avatar URL is stored', () => {
    render(
      <AccountCard
        account={makeAccount({ profilePictureUrl: null })}
      />
    );
    expect(screen.queryByTestId('account-avatar-img')).not.toBeInTheDocument();
    const initials = screen.getByTestId('account-avatar-initials');
    expect(initials).toHaveTextContent('SM');
    expect(initials.className).toContain('size-11');
    expect(initials.className).toContain('rounded-full');
    expect(initials.className).toContain('border-signal-operational');
  });

  it('falls back to initials when the avatar image fails to load', () => {
    render(<AccountCard account={makeAccount()} />);
    const img = screen.getByTestId('account-avatar-img');
    fireEvent.error(img);
    expect(screen.queryByTestId('account-avatar-img')).not.toBeInTheDocument();
    expect(screen.getByTestId('account-avatar-initials')).toHaveTextContent('SM');
  });

  it('shows initials when the avatar is forced into error', () => {
    render(<AccountCard account={makeAccount()} forceAvatarError />);
    expect(screen.queryByTestId('account-avatar-img')).not.toBeInTheDocument();
    expect(screen.getByTestId('account-avatar-initials')).toHaveTextContent('SM');
  });
});

describe('AccountCard linked-page avatars (spec 170 F4)', () => {
  it('renders a linked page photo directly, never via /_next/image', () => {
    const { container } = render(
      <AccountCard
        account={makeAccount({
          connectedPagesCount: 1,
          connectedPages: [
            {
              id: 'page-1',
              pageName: 'Baby Boss Diaries',
              profilePictureUrl: PAGE_AVATAR_URL,
            },
          ],
        })}
        defaultPagesExpanded
      />
    );
    const row = screen.getByTestId('account-linked-page-page-1');
    const img = row.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(PAGE_AVATAR_URL);
    expect(container.innerHTML).not.toContain('/_next/image');
  });

  it('falls back to page initials when the linked page photo fails to load', () => {
    render(
      <AccountCard
        account={makeAccount({
          connectedPagesCount: 1,
          connectedPages: [
            {
              id: 'page-1',
              pageName: 'Baby Boss Diaries',
              profilePictureUrl: PAGE_AVATAR_URL,
            },
          ],
        })}
        defaultPagesExpanded
      />
    );
    const row = screen.getByTestId('account-linked-page-page-1');
    const img = row.querySelector('img');
    expect(img).not.toBeNull();
    fireEvent.error(img!);
    expect(row.querySelector('img')).toBeNull();
    expect(row.textContent).toContain('BB');
  });
});
