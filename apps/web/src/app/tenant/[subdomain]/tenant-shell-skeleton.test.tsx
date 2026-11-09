/** @vitest-environment jsdom */
import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TenantShellSkeleton } from './tenant-shell-skeleton';

/**
 * Spec 152 O2 — the streamed shell's first paint must be plan-blind.
 * The skeleton is what a user sees while the entitlement seed
 * resolves: it must never carry a plan word, a pill, or gate copy —
 * a paid flash to a free user (or a free flash to a paid user) is
 * exactly the bug this test exists to catch.
 */
describe('TenantShellSkeleton (spec 152 O2)', () => {
  it('renders the static shell chrome with no plan state', () => {
    const { container } = render(<TenantShellSkeleton />);
    expect(screen.getByTestId('tenant-shell-skeleton')).toBeTruthy();
    expect(screen.getByTestId('tenant-shell-skeleton').getAttribute('aria-busy')).toBe('true');
    // Geometry mirrors the real shell: rail + topbar + page bars.
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('contains no plan word, pill, or gate copy', () => {
    render(<TenantShellSkeleton />);
    const text = document.body.textContent ?? '';
    for (const forbidden of ['Paid', 'Free', 'Expired', 'Upgrade', 'days left']) {
      expect(text).not.toContain(forbidden);
    }
    expect(screen.queryByTestId('topbar-plan-pill')).toBeNull();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).toBeNull();
    expect(screen.queryByTestId('free-plan-gate-loading')).toBeNull();
  });
});
