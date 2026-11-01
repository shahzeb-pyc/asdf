import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { BillingView } from '@/components/billing/billing-view';
import { AdminApprovalsView } from '@/components/billing/admin-approvals-view';

/**
 * Billing Purchase behaviour: the pending-payment block, the
 * purchasable platform list, the plan inclusions, the Binance
 * manual method, and the checkout submit flicker regression.
 *
 * Rendered against mocked @/lib/api — no real backend. The flicker
 * test holds the post-submit refetch open and asserts the UI never
 * returns to the screenshot-upload state while it waits.
 */

const { mockApiGet, mockApiPost } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/tenant/acme/billing',
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, apiGet: mockApiGet, apiPost: mockApiPost };
});

const ZERO_COUNTS = {
  facebook: 0,
  instagram: 0,
  threads: 0,
  x: 0,
  tiktok: 0,
  youtube: 0,
};

function freeEntitlement() {
  return {
    plan: 'free',
    active: false,
    counts: { ...ZERO_COUNTS },
    usage: { ...ZERO_COUNTS },
    periodEndsAt: null,
    periodStartsAt: null,
    canPost: false,
    readOnly: true,
    reason: 'Your plan is Free, which covers the Prompt Library only.',
  };
}

function paymentItem(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-4111-a111-111111111111',
    method: 'bank',
    bankMethod: 'easypaisa',
    status: 'pending',
    counts: { ...ZERO_COUNTS, facebook: 1 },
    amountPkr: 70,
    isUpgrade: false,
    screenshotStorageKey: 'billing-screenshots/user-1/shot.png',
    nowpaymentsPaymentId: null,
    nowpaymentsPayAddress: null,
    nowpaymentsPayAmount: null,
    nowpaymentsNetwork: null,
    createdAt: '2026-10-31T12:00:00.000Z',
    approvedAt: null,
    ...overrides,
  };
}

function statusFixture(payments: unknown[] = []) {
  return { entitlement: freeEntitlement(), payments };
}

async function goToCheckout() {
  // The builder renders after the billing load resolves (the view
  // shows a "Loading billing" skeleton first): wait for it before
  // clicking, or the stepper lookup throws on the skeleton.
  await screen.findByText('Choose your pages and accounts');
  fireEvent.click(screen.getByLabelText('Increase Facebook'));
  fireEvent.click(screen.getByRole('button', { name: 'Continue to checkout' }));
}

describe('Billing Purchase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue(statusFixture());
    mockApiPost.mockResolvedValue(paymentItem({ status: 'pending' }));
  });

  it('pending payment shows the banner and disables checkout', async () => {
    mockApiGet.mockResolvedValue(statusFixture([paymentItem()]));
    render(<BillingView subdomain="acme" initialSection="purchase" />);
    expect(await screen.findByText('Payment in progress')).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getAllByText(/70 PKR/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to checkout' })).toBeDisabled();
  });

  it('Purchase shows only Facebook, Instagram, Threads steppers', async () => {
    render(<BillingView subdomain="acme" initialSection="purchase" />);
    await screen.findByText('Choose your pages and accounts');
    expect(screen.getByLabelText('Increase Facebook')).toBeInTheDocument();
    expect(screen.getByLabelText('Increase Instagram')).toBeInTheDocument();
    expect(screen.getByLabelText('Increase Threads')).toBeInTheDocument();
    expect(screen.queryByLabelText('Increase X')).toBeNull();
    expect(screen.queryByLabelText('Increase TikTok')).toBeNull();
    expect(screen.queryByLabelText('Increase YouTube')).toBeNull();
  });

  it('Purchase shows all three inclusions and a dynamic storage total', async () => {
    render(<BillingView subdomain="acme" initialSection="purchase" />);
    await screen.findByText('Included with your plan');
    expect(
      screen.getByText('5 GB of Media Library storage per page or account')
    ).toBeInTheDocument();
    expect(screen.getByText('Creator Finder included free')).toBeInTheDocument();
    expect(
      screen.getByText('Unlimited posts — no cap on the number of posts')
    ).toBeInTheDocument();
    expect(screen.getByText('Media Library storage included')).toBeInTheDocument();
    expect(screen.getByText('0 GB')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Increase Facebook'));
    fireEvent.click(screen.getByLabelText('Increase Facebook'));
    fireEvent.click(screen.getByLabelText('Increase Instagram'));
    await waitFor(() => expect(screen.getByText('15 GB')).toBeInTheDocument());
  });

  it('My Plan still shows all six platforms', async () => {
    // Free users get a deliberately shorter My Plan (no per-platform
    // list — all zeros, useless for Free), so this needs a paid
    // entitlement: the Purchase platform filter must not leak here.
    mockApiGet.mockResolvedValue({
      entitlement: {
        plan: 'paid',
        active: true,
        counts: { facebook: 2, instagram: 1, threads: 1, x: 1, tiktok: 1, youtube: 1 },
        usage: { ...ZERO_COUNTS },
        periodEndsAt: '2026-11-30T00:00:00.000Z',
        periodStartsAt: '2026-10-31T00:00:00.000Z',
        canPost: true,
        readOnly: false,
        reason: null,
      },
      payments: [],
    });
    render(<BillingView subdomain="acme" initialSection="my-plan" />);
    await screen.findByText('Pages and accounts by platform');
    expect(screen.getByText('Facebook')).toBeInTheDocument();
    expect(screen.getByText('Instagram')).toBeInTheDocument();
    expect(screen.getByText('Threads')).toBeInTheDocument();
    expect(screen.getByText('X')).toBeInTheDocument();
    expect(screen.getByText('TikTok')).toBeInTheDocument();
    expect(screen.getByText('YouTube')).toBeInTheDocument();
  });

  it('My Plan shows Free for a never-paid user and Expired for a lapsed user', async () => {
    mockApiGet.mockResolvedValue(statusFixture());
    const { unmount } = render(<BillingView subdomain="acme" initialSection="my-plan" />);
    expect(await screen.findByText('Free')).toBeInTheDocument();
    unmount();

    mockApiGet.mockResolvedValue({
      entitlement: { ...freeEntitlement(), hasPriorPeriod: true },
      payments: [],
    });
    render(<BillingView subdomain="acme" initialSection="my-plan" />);
    expect(await screen.findByText('Expired')).toBeInTheDocument();
  });

  it('Binance is selectable, shows its ID verbatim, and submits as a manual payment', async () => {
    let capturedForm: FormData | null = null;
    mockApiPost.mockImplementation(async (_url: string, body: unknown) => {
      capturedForm = body as FormData;
      return paymentItem({ bankMethod: 'binance' });
    });
    render(<BillingView subdomain="acme" initialSection="purchase" />);
    await goToCheckout();
    expect(await screen.findByText('Manual payments')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Pay with Binance'));
    expect(screen.getByText('Binance ID')).toBeInTheDocument();
    expect(screen.getAllByText('983001576').length).toBeGreaterThan(0);
    expect(screen.getByText('Copy Binance ID')).toBeInTheDocument();
    expect(screen.getByText('Shahzebpyc')).toBeInTheDocument();
    const input = document.querySelector('#billing-screenshot') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['bytes'], 'proof.png', { type: 'image/png' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit payment for approval' }));
    await screen.findByText('Payment submitted');
    expect(capturedForm).not.toBeNull();
    expect((capturedForm as unknown as FormData).get('bankMethod')).toBe('binance');
  });

  it('checkout submit never flashes back to the screenshot-upload state', async () => {
    // Hold the post-submit refetch open: the UI must sit in
    // "processing" (attached screenshot + busy button) until the
    // confirmation renders — never back at "Upload your payment
    // screenshot".
    let submitHappened = false;
    let loadGateOpen = false;
    // Holder object, not a bare `let`: TS narrows a bare variable
    // assigned only inside a closure to `never` at the release site.
    const loadGate: { release: (() => void) | null } = { release: null };
    mockApiGet.mockImplementation(async () => {
      if (submitHappened && !loadGateOpen) {
        await new Promise<void>((resolve) => {
          loadGate.release = resolve;
        });
      }
      return statusFixture();
    });
    mockApiPost.mockImplementation(async () => {
      submitHappened = true;
      return paymentItem({ status: 'pending' });
    });

    render(<BillingView subdomain="acme" initialSection="purchase" />);
    await goToCheckout();
    const submit = await screen.findByRole('button', { name: 'Submit payment for approval' });
    const input = document.querySelector('#billing-screenshot') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['bytes'], 'proof.png', { type: 'image/png' })] },
    });
    expect(await screen.findByText('proof.png')).toBeInTheDocument();
    fireEvent.click(submit);

    // Processing persists while the refetch hangs: busy button, the
    // attached file still shown, and NO upload CTA anywhere.
    await waitFor(() => expect(submit).toBeDisabled());
    expect(screen.getByText('proof.png')).toBeInTheDocument();
    expect(screen.queryByText('Upload your payment screenshot')).toBeNull();

    loadGateOpen = true;
    loadGate.release?.();
    await screen.findByText('Payment submitted');
    expect(screen.queryByText('Upload your payment screenshot')).toBeNull();
  });
});

describe('Admin approvals view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a Binance pending payment shows the Binance label, not UBL', async () => {
    mockApiGet.mockResolvedValue({
      payments: [
        {
          ...paymentItem({ bankMethod: 'binance' }),
          userId: '22222222-2222-4222-a222-222222222222',
          userEmail: 'buyer@example.com',
        },
      ],
    });
    render(<AdminApprovalsView subdomain="acme" />);
    expect(await screen.findByText(/Binance/)).toBeInTheDocument();
    expect(screen.getByText('View payment screenshot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve payment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject payment' })).toBeInTheDocument();
  });
});
