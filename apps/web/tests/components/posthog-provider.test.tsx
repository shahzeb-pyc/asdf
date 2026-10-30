import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

/**
 * PostHogProvider suite: init once with server props, identify for a
 * signed-in user only, and a $pageview on mount and on navigation.
 * The SDK module and next/navigation are mocked; the provider's own
 * wiring (effects, Suspense boundary, prop passing) is what's tested.
 */

const posthogMocks = vi.hoisted(() => ({
  initPostHog: vi.fn(),
  identifyUser: vi.fn(),
  capturePageview: vi.fn(),
}));

vi.mock('@/lib/posthog', () => posthogMocks);

const navState = vi.hoisted(() => ({
  pathname: '/pages',
  search: '',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navState.pathname,
  useSearchParams: () => new URLSearchParams(navState.search),
}));

import { PostHogProvider } from '@/components/posthog-provider';

beforeEach(() => {
  vi.clearAllMocks();
  navState.pathname = '/pages';
  navState.search = '';
});

describe('PostHogProvider', () => {
  it('inits, identifies a signed-in user, and captures the initial pageview', () => {
    render(
      <PostHogProvider
        apiKey="test-key"
        host="US"
        userId="user-123"
        tenantId="acme"
      >
        <div>child</div>
      </PostHogProvider>
    );
    expect(posthogMocks.initPostHog).toHaveBeenCalledWith('test-key', 'US');
    expect(posthogMocks.identifyUser).toHaveBeenCalledWith('user-123', 'acme');
    expect(posthogMocks.capturePageview).toHaveBeenCalledWith('/pages');
  });

  it('captures a new pageview when the route changes', () => {
    const { rerender } = render(
      <PostHogProvider
        apiKey="test-key"
        host="US"
        userId="user-123"
        tenantId="acme"
      >
        <div>child</div>
      </PostHogProvider>
    );
    expect(posthogMocks.capturePageview).toHaveBeenCalledWith('/pages');
    navState.pathname = '/pages';
    navState.search = 'tab=queue';
    rerender(
      <PostHogProvider
        apiKey="test-key"
        host="US"
        userId="user-123"
        tenantId="acme"
      >
        <div>child</div>
      </PostHogProvider>
    );
    expect(posthogMocks.capturePageview).toHaveBeenCalledWith(
      '/pages?tab=queue'
    );
  });

  it('does not identify when logged out', () => {
    render(
      <PostHogProvider
        apiKey="test-key"
        host="US"
        userId={undefined}
        tenantId={undefined}
      >
        <div>child</div>
      </PostHogProvider>
    );
    expect(posthogMocks.initPostHog).toHaveBeenCalled();
    expect(posthogMocks.identifyUser).not.toHaveBeenCalled();
    expect(posthogMocks.capturePageview).toHaveBeenCalledWith('/pages');
  });
});
