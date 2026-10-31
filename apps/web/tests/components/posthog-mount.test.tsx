import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * Mount-order integration suite: the initial pageview and the
 * initial identify must actually LAND on first load — not merely be
 * called. This is the test the mocked-provider suite cannot provide:
 * it mocks `@/lib/posthog`, so it asserts `capturePageview` was
 * called, not that the call survived the real client's guards.
 *
 * The defect this pins: React runs child effects before parent
 * effects on mount, so the tracker's and identify's mount-time
 * calls execute BEFORE the provider's init effect starts the load.
 * When `whenReady` dropped pre-init calls, the initial pageview
 * never landed, and the initial identify never landed either — and
 * identify does not re-fire on navigation, so the user stayed
 * anonymous. This test FAILS on that old code (capture/identify
 * never called) and PASSES once pre-init calls are buffered and
 * flushed on load.
 *
 * Only `posthog-js` and `next/navigation` are mocked; the provider,
 * the identify component, and the real `lib/posthog.ts` all run.
 * One test only, so the lib module's once-only init state (fresh
 * per test file) is not reused across tests.
 */

const fake = vi.hoisted(() => ({
  init: vi.fn(),
  identify: vi.fn(),
  capture: vi.fn(),
}));

vi.mock('posthog-js', () => ({
  default: {
    init: fake.init,
    identify: fake.identify,
    capture: fake.capture,
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/pages',
  useSearchParams: () => new URLSearchParams(''),
}));

import { PostHogProvider } from '@/components/posthog-provider';
import { PostHogIdentify } from '@/components/posthog-identify';

describe('PostHog mount (real client module)', () => {
  it('lands the initial pageview and the initial identify on mount', async () => {
    render(
      <PostHogProvider apiKey="test-key" host="US">
        <PostHogIdentify userId="user-123" tenantId="acme" />
      </PostHogProvider>
    );

    // Both calls are issued before init starts (child effects run
    // first) and must be delivered once the load resolves.
    await waitFor(() => {
      expect(fake.capture).toHaveBeenCalledWith('$pageview', {
        $current_url: 'http://localhost:3000/pages',
      });
    });
    await waitFor(() => {
      expect(fake.identify).toHaveBeenCalledWith('user-123', {
        tenant_id: 'acme',
      });
    });
    // Identify carries ids only — no email, no name.
    const props = fake.identify.mock.calls[0][1] as Record<string, unknown>;
    expect(props).not.toHaveProperty('email');
    expect(props).not.toHaveProperty('name');
  });
});
