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

const INAPP_SCHEDULE_PATH = '/inapp-schedule';
const HOST_REGION = 'US';

const navState = vi.hoisted(() => ({
  // Literal here, not INAPP_SCHEDULE_PATH: hoisted factories run before the
  // module's top-level consts initialize (TDZ). beforeEach resets
  // this to INAPP_SCHEDULE_PATH anyway, so both stay the same value.
  pathname: '/inapp-schedule',
  search: '',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navState.pathname,
  useSearchParams: () => new URLSearchParams(navState.search),
}));

import { PostHogProvider } from '@/components/posthog-provider';

beforeEach(() => {
  vi.clearAllMocks();
  navState.pathname = INAPP_SCHEDULE_PATH;
  navState.search = '';
});

describe('PostHogProvider', () => {
  it('inits and captures the initial pageview', () => {
    render(
      <PostHogProvider apiKey="test-key" host={HOST_REGION}>
        <div>child</div>
      </PostHogProvider>
    );
    expect(posthogMocks.initPostHog).toHaveBeenCalledWith('test-key', 'US');
    expect(posthogMocks.capturePageview).toHaveBeenCalledWith(INAPP_SCHEDULE_PATH);
    expect(posthogMocks.identifyUser).not.toHaveBeenCalled();
  });

  it('captures a new pageview when the route changes', () => {
    const { rerender } = render(
      <PostHogProvider apiKey="test-key" host={HOST_REGION}>
        <div>child</div>
      </PostHogProvider>
    );
    expect(posthogMocks.capturePageview).toHaveBeenCalledWith(INAPP_SCHEDULE_PATH);
    navState.pathname = INAPP_SCHEDULE_PATH;
    navState.search = 'tab=queue';
    rerender(
      <PostHogProvider apiKey="test-key" host={HOST_REGION}>
        <div>child</div>
      </PostHogProvider>
    );
    expect(posthogMocks.capturePageview).toHaveBeenCalledWith(`${INAPP_SCHEDULE_PATH}?tab=queue`);
  });
});
