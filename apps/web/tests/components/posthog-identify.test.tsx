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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PostHogIdentify', () => {
  it('identifies with the user id and tenant subdomain only', () => {
    const { container } = render(
      <PostHogIdentify userId="user-123" tenantId="acme" />
    );
    expect(posthogMocks.identifyUser).toHaveBeenCalledWith(
      'user-123',
      'acme'
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('re-identifies when the user or workspace changes', () => {
    const { rerender } = render(
      <PostHogIdentify userId="user-123" tenantId="acme" />
    );
    rerender(<PostHogIdentify userId="user-123" tenantId="other" />);
    expect(posthogMocks.identifyUser).toHaveBeenCalledTimes(2);
    expect(posthogMocks.identifyUser).toHaveBeenLastCalledWith(
      'user-123',
      'other'
    );
  });
});
