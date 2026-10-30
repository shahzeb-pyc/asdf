import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

/**
 * PostHogProvider suite: init once with server props and a $pageview
 * on mount and on navigation. The SDK module and next/navigation are
 * mocked; the provider's own wiring (effects, Suspense boundary, prop
 * passing) is what's tested. Identify is NOT the provider's job — it
 * lives in PostHogIdentify (see posthog-identify.test.tsx).
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
  it('inits and captures the initial pageview', () => {
    render(
      <PostHogProvider apiKey="test-key" host="US">
        <div>child</div>
      </PostHogProvider>
    );
    expect(posthogMocks.initPostHog).toHaveBeenCalledWith('test-key', 'US');
    expect(posthogMocks.capturePageview).toHaveBeenCalledWith('/pages');
    expect(posthogMocks.identifyUser).not.toHaveBeenCalled();
  });

  it('captures a new pageview when the route changes', () => {
    const { rerender } = render(
      <PostHogProvider apiKey="test-key" host="US">
        <div>child</div>
      </PostHogProvider>
    );
    expect(posthogMocks.capturePageview).toHaveBeenCalledWith('/pages');
    navState.pathname = '/pages';
    navState.search = 'tab=queue';
    rerender(
      <PostHogProvider apiKey="test-key" host="US">
        <div>child</div>
      </PostHogProvider>
    );
    expect(posthogMocks.capturePageview).toHaveBeenCalledWith(
      '/pages?tab=queue'
    );
  });
});
