/** @vitest-environment jsdom */
/**
 * FreePlanGate behavioural tests: the hard-block upgrade dialog for users
 * who cannot post. Free users on gated routes see the dialog and never
 * reach section content; exempt routes, admins, and paying users see no
 * dialog; Upgrade goes to Billing Purchase and Back to Home goes home;
 * Esc and outside pointer-down do not dismiss; entitlement loading holds
 * content; an entitlement fetch error renders content (fail-open, reported).
 */

import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  pathname: '/tenant/acme/accounts',
  push: vi.fn(),
  apiGet: vi.fn(),
  reportError: vi.fn(),
}));
const mockPush = mocks.push;
const mockApiGet = mocks.apiGet;
const mockReportError = mocks.reportError;

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return { ...original, apiGet: mocks.apiGet };
});

vi.mock('@/lib/report-error', () => ({ reportError: mocks.reportError }));

import { FreePlanGate } from '@/components/billing/free-plan-gate';

function entitlement(canPost: boolean) {
  return {
    plan: canPost ? 'paid' : 'free',
    active: canPost,
    counts: {
      facebook: 0,
      instagram: 0,
      threads: 0,
      x: 0,
      tiktok: 0,
      youtube: 0,
    },
    usage: {
      facebook: 0,
      instagram: 0,
      threads: 0,
      x: 0,
      tiktok: 0,
      youtube: 0,
    },
    periodEndsAt: null,
    periodStartsAt: null,
    canPost,
    readOnly: !canPost,
    reason: canPost ? null : 'Free plan',
  };
}

function renderGate(props: { isAdmin?: boolean; useCleanPaths?: boolean } = {}) {
  return render(
    <FreePlanGate
      subdomain="acme"
      useCleanPaths={props.useCleanPaths ?? false}
      isAdmin={props.isAdmin ?? false}
    >
      <div>Section content</div>
    </FreePlanGate>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pathname = '/tenant/acme/accounts';
  mockApiGet.mockResolvedValue(entitlement(false));
});

describe('FreePlanGate', () => {
  it('shows the hard-block dialog and hides section content for a Free user on a gated route', async () => {
    renderGate();
    expect(screen.getByTestId('free-plan-gate-loading')).toBeInTheDocument();
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();
    expect(await screen.findByTestId('free-plan-upgrade-dialog')).toBeInTheDocument();
    expect(screen.getByText("You're on the Free plan")).toBeInTheDocument();
    expect(
      screen.getByText('This feature needs a paid plan. Upgrade to use it.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();
    // Hard block: no close button at all.
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('shows no dialog on exempt routes and never fetches entitlement', async () => {
    for (const path of ['/tenant/acme', '/tenant/acme/', '/prompts', '/tenant/acme/prompts', '/tenant/acme/billing', '/tenant/acme/billing/payments']) {
      mocks.pathname = path;
      const { unmount } = renderGate();
      expect(screen.getByText('Section content')).toBeInTheDocument();
      expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
      unmount();
    }
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  it('shows no dialog for an admin on a gated route and never fetches entitlement', () => {
    renderGate({ isAdmin: true });
    expect(screen.getByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  it('shows section content and no dialog for a paying user on a gated route', async () => {
    mockApiGet.mockResolvedValue(entitlement(true));
    renderGate();
    expect(await screen.findByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
  });

  it('Upgrade navigates to Billing Purchase and Back to Home navigates home', async () => {
    renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    fireEvent.click(screen.getByTestId('free-plan-upgrade-btn'));
    expect(mockPush).toHaveBeenCalledWith('/tenant/acme/billing?view=purchase');
    fireEvent.click(screen.getByTestId('free-plan-home-btn'));
    expect(mockPush).toHaveBeenCalledWith('/tenant/acme/');
  });

  it('uses clean-path hrefs when clean paths are on', async () => {
    renderGate({ useCleanPaths: true });
    await screen.findByTestId('free-plan-upgrade-dialog');
    fireEvent.click(screen.getByTestId('free-plan-upgrade-btn'));
    expect(mockPush).toHaveBeenCalledWith('/billing?view=purchase');
    fireEvent.click(screen.getByTestId('free-plan-home-btn'));
    expect(mockPush).toHaveBeenCalledWith('/');
  });

  it('Esc does not dismiss the dialog', async () => {
    renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('free-plan-upgrade-dialog')).toBeInTheDocument();
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();
  });

  it('outside pointer-down does not dismiss the dialog', async () => {
    renderGate();
    await screen.findByTestId('free-plan-upgrade-dialog');
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId('free-plan-upgrade-dialog')).toBeInTheDocument();
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();
  });

  it('holds a neutral loading state until entitlement resolves', async () => {
    let resolveEntitlement!: (value: unknown) => void;
    mockApiGet.mockImplementation(
      () => new Promise((resolve) => { resolveEntitlement = resolve; }),
    );
    renderGate();
    expect(screen.getByTestId('free-plan-gate-loading')).toBeInTheDocument();
    expect(screen.queryByText('Section content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
    resolveEntitlement(entitlement(false));
    await screen.findByTestId('free-plan-upgrade-dialog');
    expect(screen.queryByTestId('free-plan-gate-loading')).not.toBeInTheDocument();
  });

  it('renders content on entitlement fetch error (fail-open, reported)', async () => {
    mockApiGet.mockRejectedValue(new Error('entitlement down'));
    renderGate();
    expect(await screen.findByText('Section content')).toBeInTheDocument();
    expect(screen.queryByTestId('free-plan-upgrade-dialog')).not.toBeInTheDocument();
    expect(mockReportError).toHaveBeenCalled();
  });

  it('renders the panel with phone-width geometry from the shared dialog', async () => {
    renderGate();
    const panel = await screen.findByTestId('free-plan-upgrade-dialog');
    expect(panel.className).toContain('inset-x-4');
    expect(panel.className).toContain('sm:max-w-lg');
  });
});
