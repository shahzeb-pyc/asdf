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
  // typing, or the input lookup throws on the skeleton.
  await screen.findByText('Choose your pages and accounts');
  fireEvent.change(screen.getByLabelText('Facebook pages'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue to checkout' }));
}

describe('Billing Purchase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue(statusFixture());
    mockApiPost.mockResolvedValue(paymentItem({ status: 'pending' }));
  });

  it('pending payment hides the builder and shows only the pending card', async () => {
    mockApiGet.mockResolvedValue(statusFixture([paymentItem()]));
    render(<BillingView subdomain="acme" initialSection="purchase" />);
    expect(await screen.findByText('Payment in progress')).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getAllByText(/70 PKR/).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'You already have a payment waiting for approval. Wait for it to be decided before submitting another.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText('You can build a new plan once this payment is decided.')
    ).toBeInTheDocument();
    // The builder is hidden, not disabled: no draft priced on current
    // usage next to a different pending order.
    expect(screen.queryByText('Included with your plan')).toBeNull();
    expect(screen.queryByText('Choose your pages and accounts')).toBeNull();
    expect(screen.queryByText('Order summary')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue to checkout' })).toBeNull();
    expect(screen.queryByLabelText('Facebook pages')).toBeNull();
  });

  it('Purchase shows only Facebook, Instagram, Threads inputs — no steppers', async () => {
    render(<BillingView subdomain="acme" initialSection="purchase" />);
    await screen.findByText('Choose your pages and accounts');
    expect(screen.getByLabelText('Facebook pages')).toBeInTheDocument();
    expect(screen.getByLabelText('Instagram accounts')).toBeInTheDocument();
    expect(screen.getByLabelText('Threads accounts')).toBeInTheDocument();
    expect(screen.queryByLabelText('X accounts')).toBeNull();
    expect(screen.queryByLabelText('TikTok accounts')).toBeNull();
    expect(screen.queryByLabelText('YouTube accounts')).toBeNull();
    // No increase/decrease control anywhere in the chooser, and no
    // native number spinner either (the inputs are text inputs).
    expect(screen.queryByRole('button', { name: 'Increase Facebook' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decrease Facebook' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Increase Instagram' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decrease Instagram' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Increase Threads' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decrease Threads' })).toBeNull();
    expect(document.querySelector('input[type="number"]')).toBeNull();
  });

  it('typing a count updates the row price and total live', async () => {
    render(<BillingView subdomain="acme" initialSection="purchase" />);
    await screen.findByText('Choose your pages and accounts');
    const facebook = screen.getByLabelText('Facebook pages') as HTMLInputElement;
    fireEvent.change(facebook, { target: { value: '100' } });
    expect(facebook.value).toBe('100');
    // Row price and order summary both price the typed count live.
    expect(screen.getAllByText('7000 PKR').length).toBeGreaterThan(0);
    const instagram = screen.getByLabelText('Instagram accounts') as HTMLInputElement;
    fireEvent.change(instagram, { target: { value: '4' } });
    expect(screen.getAllByText('280 PKR').length).toBeGreaterThan(0);
  });

  it('invalid input never touches the totals and reverts on blur', async () => {
    render(<BillingView subdomain="acme" initialSection="purchase" />);
    await screen.findByText('Choose your pages and accounts');
    const facebook = screen.getByLabelText('Facebook pages') as HTMLInputElement;
    fireEvent.change(facebook, { target: { value: '4' } });
    expect(facebook.value).toBe('4');
    expect(screen.getAllByText('280 PKR').length).toBeGreaterThan(0);
    // Letters, decimals, and negatives: the field holds the raw text
    // while editing, the committed count (and its price) stays put,
    // and blur drops the draft back to the last valid count.
    for (const bad of ['xyz', '2.5', '-5']) {
      fireEvent.change(facebook, { target: { value: bad } });
      expect(facebook.value).toBe(bad);
      expect(screen.getAllByText('280 PKR').length).toBeGreaterThan(0);
      fireEvent.blur(facebook);
      expect(facebook.value).toBe('4');
    }
  });

  it('blank while typing counts as 0 and stays 0 on blur', async () => {
    render(<BillingView subdomain="acme" initialSection="purchase" />);
    await screen.findByText('Choose your pages and accounts');
    const facebook = screen.getByLabelText('Facebook pages') as HTMLInputElement;
    fireEvent.change(facebook, { target: { value: '2' } });
    expect(screen.getAllByText('140 PKR').length).toBeGreaterThan(0);
    fireEvent.change(facebook, { target: { value: '' } });
    expect(facebook.value).toBe('');
    expect(screen.queryByText('140 PKR')).toBeNull();
    fireEvent.blur(facebook);
    expect(facebook.value).toBe('0');
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
    fireEvent.change(screen.getByLabelText('Facebook pages'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Instagram accounts'), { target: { value: '1' } });
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

  it('My Plan shows pending verification instead of Free when a payment is pending', async () => {
    mockApiGet.mockResolvedValue(statusFixture([paymentItem()]));
    render(<BillingView subdomain="acme" initialSection="my-plan" />);
    expect(await screen.findByText('Payment in progress')).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getAllByText(/70 PKR/).length).toBeGreaterThan(0);
    expect(
      screen.getByText('Your plan activates once the payment is approved.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View payments' })).toBeInTheDocument();
    // The Free card is replaced, not stacked: no Free title, no Free
    // feature list, and no upgrade button in this state.
    expect(screen.queryByText('Free')).toBeNull();
    expect(screen.queryByText('Posting and scheduling')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Buy or upgrade' })).toBeNull();
  });

  it('My Plan keeps Expired for a lapsed user even with a payment pending', async () => {
    mockApiGet.mockResolvedValue({
      entitlement: { ...freeEntitlement(), hasPriorPeriod: true },
      payments: [paymentItem()],
    });
    render(<BillingView subdomain="acme" initialSection="my-plan" />);
    expect(await screen.findByText('Expired')).toBeInTheDocument();
    expect(screen.queryByText('Payment in progress')).toBeNull();
  });

  it('My Plan keeps Paid for a paid user with an upgrade pending', async () => {
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
      payments: [paymentItem({ isUpgrade: true })],
    });
    render(<BillingView subdomain="acme" initialSection="my-plan" />);
    expect(await screen.findByText('Your plan')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.queryByText('Payment in progress')).toBeNull();
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
    expect(screen.getByText('Your plan runs for 30 days after approval.')).toBeInTheDocument();
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
