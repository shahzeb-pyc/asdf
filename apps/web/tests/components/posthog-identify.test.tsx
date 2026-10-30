import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

/**
 * PostHogIdentify suite: the tenant shell's identify call. The SDK
 * module is mocked; what's tested is that the component identifies
 * with ids only, and renders nothing.
 */

const posthogMocks = vi.hoisted(() => ({
  identifyUser: vi.fn(),
}));

vi.mock('@/lib/posthog', () => posthogMocks);

import { PostHogIdentify } from '@/components/posthog-identify';

const USER_ID = 'user-123';
const TENANT_ID = 'acme';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PostHogIdentify', () => {
  it('identifies with the user id and tenant subdomain only', () => {
    const { container } = render(
      <PostHogIdentify userId={USER_ID} tenantId={TENANT_ID} />
    );
    expect(posthogMocks.identifyUser).toHaveBeenCalledWith(
      USER_ID,
      TENANT_ID
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('re-identifies when the user or workspace changes', () => {
    const { rerender } = render(
      <PostHogIdentify userId={USER_ID} tenantId={TENANT_ID} />
    );
    rerender(<PostHogIdentify userId={USER_ID} tenantId="other" />);
    expect(posthogMocks.identifyUser).toHaveBeenCalledTimes(2);
    expect(posthogMocks.identifyUser).toHaveBeenLastCalledWith(
      USER_ID,
      'other'
    );
  });
});
