import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@/lib/data/query-client';

import { BillingView } from '@/components/billing/billing-view';
import { EntitlementProvider } from '@/components/billing/entitlement-provider';
import { AdminApprovalsView } from '@/components/billing/admin-approvals-view';
import { abortedError, httpError, networkError, parseError, sessionExpiredError } from '@/lib/api';
import {
  resetReportErrorTransport,
  setReportErrorTransport,
} from '@/lib/report-error';

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

/**
 * Entitlement rebuild: BillingView's plan decisions now come from the
 * tenant layout's shared entitlement query, while its /billing load
 * still supplies payments — so the apiGet mock routes by URL. The
 * entitlement path returns the status's nested entitlement (with
 * hasPriorPeriod defaulted, as the real API always sends it);
 * everything else returns the full status object.
 */
function mockBillingApi<T extends { entitlement: object; payments: unknown[] }>(
  status: T
): void {
  mockApiGet.mockImplementation(async (url: string) => {
    if (url.includes('/billing/entitlement')) {
      const entitlement = status.entitlement as Record<string, unknown>;
      return { ...entitlement, hasPriorPeriod: entitlement.hasPriorPeriod ?? false };
    }
    return status;
  });
}

/** Render BillingView the way the tenant layout does: inside the shared entitlement provider. */
function renderBilling(section: 'purchase' | 'my-plan') {
  return render(
    <QueryClientProvider client={createQueryClient('acme')}>
      <EntitlementProvider subdomain="acme" adminOnly={false}>
        <BillingView subdomain="acme" initialSection={section} />
      </EntitlementProvider>
    </QueryClientProvider>
  );
}

async function goToCheckout() {
  // The builder renders after the billing load resolves (the view
  // shows a "Loading billing" skeleton first): wait for it before
  // typing, or the input lookup throws on the skeleton.
  await screen.findByText('Choose your pages and accounts');
  fireEvent.change(screen.getByLabelText('Facebook pages'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue to checkout' }));
}

/**
 * Submit-flow test plumbing (submit rewrite 2026-11-01): picking a
 * screenshot now mints a presigned URL (apiPost) and PUTs the bytes
 * (global fetch) before submit is enabled, so tests route the mint
 * to a fake URL and stub the PUT. The payments call carries the
 * minted key plus an Idempotency-Key header.
 */
const MINT_RESPONSE = {
  storageKey: 'billing-screenshots/user-1/shot.png',
  uploadUrl: 'https://r2.example.com/billing-screenshots/user-1/shot.png?sig=test',
  expiresInSeconds: 900,
};

type ApiPostImpl = (url: string, body: unknown, options: unknown) => Promise<unknown>;

function routeMintAndPayments(paymentsImpl: ApiPostImpl): void {
  mockApiPost.mockImplementation(async (url: string, body: unknown, options: unknown) => {
    if (url.includes('screenshot-upload')) return MINT_RESPONSE;
    return paymentsImpl(url, body, options);
  });
}

function stubPutOk(): ReturnType<typeof vi.fn> {
  const put = vi.fn(async () => ({ ok: true }) as Response);
  vi.stubGlobal('fetch', put);
  return put;
}

async function pickScreenshot(): Promise<void> {
  const input = document.querySelector('#billing-screenshot') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(['bytes'], 'proof.png', { type: 'image/png' })] },
  });
  await screen.findByText('Uploaded');
}

describe('Billing Purchase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBillingApi(statusFixture());
    mockApiPost.mockResolvedValue(paymentItem({ status: 'pending' }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetReportErrorTransport();
  });

  it('pending payment hides the builder and shows only the pending card', async () => {
    mockBillingApi(statusFixture([paymentItem()]));
    renderBilling('purchase');
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
    renderBilling('purchase');
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
    renderBilling('purchase');
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
    renderBilling('purchase');
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
    renderBilling('purchase');
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
    renderBilling('purchase');
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
    mockBillingApi({
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
    renderBilling('my-plan');
    await screen.findByText('Pages and accounts by platform');
    expect(screen.getByText('Facebook')).toBeInTheDocument();
    expect(screen.getByText('Instagram')).toBeInTheDocument();
    expect(screen.getByText('Threads')).toBeInTheDocument();
    expect(screen.getByText('X')).toBeInTheDocument();
    expect(screen.getByText('TikTok')).toBeInTheDocument();
    expect(screen.getByText('YouTube')).toBeInTheDocument();
  });

  it('My Plan shows Free for a never-paid user and Expired for a lapsed user', async () => {
    mockBillingApi(statusFixture());
    const { unmount } = renderBilling('my-plan');
    expect(await screen.findByText('Free')).toBeInTheDocument();
    unmount();

    mockBillingApi({
      entitlement: { ...freeEntitlement(), hasPriorPeriod: true },
      payments: [],
    });
    renderBilling('my-plan');
    expect(await screen.findByText('Expired')).toBeInTheDocument();
  });

  it('My Plan shows pending verification instead of Free when a payment is pending', async () => {
    mockBillingApi(statusFixture([paymentItem()]));
    renderBilling('my-plan');
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
    mockBillingApi({
      entitlement: { ...freeEntitlement(), hasPriorPeriod: true },
      payments: [paymentItem()],
    });
    renderBilling('my-plan');
    expect(await screen.findByText('Expired')).toBeInTheDocument();
    expect(screen.queryByText('Payment in progress')).toBeNull();
  });

  it('My Plan keeps Paid for a paid user with an upgrade pending', async () => {
    mockBillingApi({
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
    renderBilling('my-plan');
    expect(await screen.findByText('Your plan')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.queryByText('Payment in progress')).toBeNull();
  });

  it('Binance is selectable, shows its ID verbatim, and submits as a manual payment', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    let capturedHeaders: Record<string, string> | null = null;
    routeMintAndPayments(async (_url, body, options) => {
      capturedBody = body as Record<string, unknown>;
      capturedHeaders = (options as { headers?: Record<string, string> }).headers ?? null;
      return paymentItem({ bankMethod: 'binance' });
    });
    const put = stubPutOk();
    renderBilling('purchase');
    await goToCheckout();
    expect(await screen.findByText('Manual payments')).toBeInTheDocument();
    expect(screen.getByText('Your plan runs for 30 days after approval.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Pay with Binance'));
    expect(screen.getByText('Binance ID')).toBeInTheDocument();
    expect(screen.getAllByText('983001576').length).toBeGreaterThan(0);
    expect(screen.getByText('Copy Binance ID')).toBeInTheDocument();
    expect(screen.getByText('Shahzebpyc')).toBeInTheDocument();
    await pickScreenshot();
    fireEvent.click(screen.getByRole('button', { name: 'Submit payment for approval' }));
    await screen.findByText('Payment submitted');
    expect(capturedBody).not.toBeNull();
    expect(capturedBody?.['bankMethod']).toBe('binance');
    expect(capturedBody?.['screenshotStorageKey']).toBe(MINT_RESPONSE.storageKey);
    expect(capturedHeaders?.['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(put).toHaveBeenCalledTimes(1);
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
    mockApiGet.mockImplementation(async (url: string) => {
      // Route the shared entitlement query straight through; only
      // the /billing load is held open after submit.
      if (url.includes('/billing/entitlement')) {
        return { ...freeEntitlement(), hasPriorPeriod: false };
      }
      if (submitHappened && !loadGateOpen) {
        await new Promise<void>((resolve) => {
          loadGate.release = resolve;
        });
      }
      return statusFixture();
    });
    routeMintAndPayments(async () => {
      submitHappened = true;
      return paymentItem({ status: 'pending' });
    });
    stubPutOk();

    renderBilling('purchase');
    await goToCheckout();
    const submit = await screen.findByRole('button', { name: 'Submit payment for approval' });
    await pickScreenshot();
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

  it('submit waits for the screenshot upload: disabled while uploading, enabled once it lands', async () => {
    // Holder object, not a bare `let`: TS narrows a bare variable
    // assigned only inside a closure to `never` at the release site.
    const putGate: { release: (() => void) | null } = { release: null };
    const putPromise = new Promise<Response>((resolve) => {
      putGate.release = () => resolve({ ok: true } as Response);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => putPromise)
    );
    mockApiPost.mockImplementation(async (url: string) => {
      if (url.includes('screenshot-upload')) return MINT_RESPONSE;
      return paymentItem({ status: 'pending' });
    });

    renderBilling('purchase');
    await goToCheckout();
    const submit = await screen.findByRole('button', { name: 'Submit payment for approval' });
    const input = document.querySelector('#billing-screenshot') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['bytes'], 'proof.png', { type: 'image/png' })] },
    });
    await screen.findByText('Uploading screenshot…');
    expect(submit).toBeDisabled();
    expect(
      screen.getByText('Uploading your screenshot — submit unlocks when it finishes.')
    ).toBeInTheDocument();

    putGate.release?.();
    await screen.findByText('Uploaded');
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it('a failed upload shows its own error with a retry and keeps submit disabled', async () => {
    const put = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    vi.stubGlobal('fetch', put);
    mockApiPost.mockImplementation(async (url: string) => {
      if (url.includes('screenshot-upload')) return MINT_RESPONSE;
      return paymentItem({ status: 'pending' });
    });

    renderBilling('purchase');
    await goToCheckout();
    const submit = await screen.findByRole('button', { name: 'Submit payment for approval' });
    const input = document.querySelector('#billing-screenshot') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['bytes'], 'proof.png', { type: 'image/png' })] },
    });
    await screen.findByText('Retry upload');
    expect(
      screen.getByText(
        'The screenshot could not be uploaded. Check your connection and try uploading again.'
      )
    ).toBeInTheDocument();
    expect(submit).toBeDisabled();

    put.mockImplementation(async () => ({ ok: true }) as Response);
    fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));
    await screen.findByText('Uploaded');
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it('a fast double-click submits exactly once', async () => {
    const put = stubPutOk();
    let paymentsCalls = 0;
    routeMintAndPayments(async () => {
      paymentsCalls += 1;
      return paymentItem({ status: 'pending' });
    });

    renderBilling('purchase');
    await goToCheckout();
    await pickScreenshot();
    const submit = screen.getByRole('button', { name: 'Submit payment for approval' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await screen.findByText('Payment submitted');
    expect(paymentsCalls).toBe(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('a transient payment failure auto-retries with the same key and succeeds without re-uploading', async () => {
    const put = stubPutOk();
    const keys: Array<string | undefined> = [];
    let paymentsCalls = 0;
    routeMintAndPayments(async (_url, _body, options) => {
      paymentsCalls += 1;
      keys.push((options as { headers?: Record<string, string> }).headers?.['Idempotency-Key']);
      if (paymentsCalls === 1) throw httpError(500, 'boom');
      return paymentItem({ status: 'pending' });
    });

    renderBilling('purchase');
    await goToCheckout();
    await pickScreenshot();
    fireEvent.click(screen.getByRole('button', { name: 'Submit payment for approval' }));
    await screen.findByText('Payment submitted');
    expect(paymentsCalls).toBe(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('manual Try again after a failure reuses the uploaded screenshot', async () => {
    const put = stubPutOk();
    let paymentsCalls = 0;
    routeMintAndPayments(async () => {
      paymentsCalls += 1;
      if (paymentsCalls === 1) throw httpError(422, 'The payment could not be priced.');
      return paymentItem({ status: 'pending' });
    });

    renderBilling('purchase');
    await goToCheckout();
    await pickScreenshot();
    fireEvent.click(screen.getByRole('button', { name: 'Submit payment for approval' }));
    await screen.findByText('The payment could not be priced.');
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByText('Payment submitted');
    expect(paymentsCalls).toBe(2);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('a 409 surfaces the already-pending message, not a generic error', async () => {
    stubPutOk();
    routeMintAndPayments(async () => {
      throw httpError(409, 'PENDING_PAYMENT_EXISTS');
    });

    renderBilling('purchase');
    await goToCheckout();
    await pickScreenshot();
    fireEvent.click(screen.getByRole('button', { name: 'Submit payment for approval' }));
    expect(
      await screen.findByText(
        'You already have a payment waiting for approval. Wait for it to be decided before submitting another.'
      )
    ).toBeInTheDocument();
  });

  it('repeated timeouts show the timeout message with a manual retry', async () => {
    stubPutOk();
    routeMintAndPayments(async () => {
      throw abortedError();
    });

    renderBilling('purchase');
    await goToCheckout();
    await pickScreenshot();
    fireEvent.click(screen.getByRole('button', { name: 'Submit payment for approval' }));
    await screen.findByText(
      'The request timed out. Your screenshot is still attached — try again.'
    );
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('a transient mint failure retries and the upload still lands', async () => {
    let mintCalls = 0;
    mockApiPost.mockImplementation(async (url: string) => {
      if (url.includes('screenshot-upload')) {
        mintCalls += 1;
        if (mintCalls === 1) throw networkError(new Error('offline'));
        return MINT_RESPONSE;
      }
      return paymentItem({ status: 'pending' });
    });
    stubPutOk();

    renderBilling('purchase');
    await goToCheckout();
    await pickScreenshot();
    expect(mintCalls).toBe(2);
  });

  it('a rejected mint shows its own error and keeps submit disabled', async () => {
    mockApiPost.mockImplementation(async (url: string) => {
      if (url.includes('screenshot-upload')) throw httpError(400, 'Bad screenshot details.');
      return paymentItem({ status: 'pending' });
    });
    stubPutOk();

    renderBilling('purchase');
    await goToCheckout();
    const submit = await screen.findByRole('button', { name: 'Submit payment for approval' });
    const input = document.querySelector('#billing-screenshot') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['bytes'], 'proof.png', { type: 'image/png' })] },
    });
    await screen.findByText('Bad screenshot details.');
    expect(submit).toBeDisabled();
  });

  it('an expired session during the mint shows the session message, not a generic error', async () => {
    mockApiPost.mockImplementation(async (url: string) => {
      if (url.includes('screenshot-upload')) throw sessionExpiredError();
      return paymentItem({ status: 'pending' });
    });
    stubPutOk();

    renderBilling('purchase');
    await goToCheckout();
    const input = document.querySelector('#billing-screenshot') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['bytes'], 'proof.png', { type: 'image/png' })] },
    });
    expect(
      await screen.findByText('Your session expired. Sign in again to pick up where you left off.')
    ).toBeInTheDocument();
  });

  it('an aborted PUT shows the timeout message with a retry', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw abort;
      })
    );
    mockApiPost.mockImplementation(async (url: string) => {
      if (url.includes('screenshot-upload')) return MINT_RESPONSE;
      return paymentItem({ status: 'pending' });
    });

    renderBilling('purchase');
    await goToCheckout();
    const input = document.querySelector('#billing-screenshot') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['bytes'], 'proof.png', { type: 'image/png' })] },
    });
    await screen.findByText(
      'The screenshot upload timed out. Your screenshot was not saved — try uploading again.'
    );
    expect(screen.getByRole('button', { name: 'Retry upload' })).toBeInTheDocument();
  });

  it('a rejected PUT shows the rejected message, without retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400 }) as Response));
    mockApiPost.mockImplementation(async (url: string) => {
      if (url.includes('screenshot-upload')) return MINT_RESPONSE;
      return paymentItem({ status: 'pending' });
    });

    renderBilling('purchase');
    await goToCheckout();
    const input = document.querySelector('#billing-screenshot') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['bytes'], 'proof.png', { type: 'image/png' })] },
    });
    expect(
      await screen.findByText(
        'The screenshot was rejected. Try a PNG, JPG, WebP, or GIF image under 10 MB.'
      )
    ).toBeInTheDocument();
  });

  it('an expired session during submit shows the session message', async () => {
    stubPutOk();
    routeMintAndPayments(async () => {
      throw sessionExpiredError();
    });

    renderBilling('purchase');
    await goToCheckout();
    await pickScreenshot();
    fireEvent.click(screen.getByRole('button', { name: 'Submit payment for approval' }));
    expect(
      await screen.findByText('Your session expired. Sign in again to pick up where you left off.')
    ).toBeInTheDocument();
  });

  it('a malformed submit response shows the parse message, not a generic error', async () => {
    stubPutOk();
    routeMintAndPayments(async () => {
      throw parseError('The server returned a response that was not valid JSON.');
    });

    renderBilling('purchase');
    await goToCheckout();
    await pickScreenshot();
    fireEvent.click(screen.getByRole('button', { name: 'Submit payment for approval' }));
    expect(
      await screen.findByText(
        'The server returned an unexpected response. Your screenshot is still attached — try again.'
      )
    ).toBeInTheDocument();
  });

  it('a truly unknown submit error shows the fallback, logs it, and offers a retry', async () => {
    const reported: unknown[] = [];
    setReportErrorTransport((error) => {
      reported.push(error);
    });
    stubPutOk();
    routeMintAndPayments(async () => {
      throw new Error('boom');
    });

    renderBilling('purchase');
    await goToCheckout();
    await pickScreenshot();
    fireEvent.click(screen.getByRole('button', { name: 'Submit payment for approval' }));
    await screen.findByText(
      'Something went wrong while saving your payment. Your screenshot is still attached — try again.'
    );
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(reported).toHaveLength(1);
  });

  it('a click during the upload posts nothing; submit works once the upload lands', async () => {
    const putGate: { release: (() => void) | null } = { release: null };
    const putPromise = new Promise<Response>((resolve) => {
      putGate.release = () => resolve({ ok: true } as Response);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => putPromise)
    );
    let paymentsCalls = 0;
    routeMintAndPayments(async () => {
      paymentsCalls += 1;
      return paymentItem({ status: 'pending' });
    });

    renderBilling('purchase');
    await goToCheckout();
    const submit = await screen.findByRole('button', { name: 'Submit payment for approval' });
    const input = document.querySelector('#billing-screenshot') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['bytes'], 'proof.png', { type: 'image/png' })] },
    });
    await screen.findByText('Uploading screenshot…');
    expect(submit).toBeDisabled();
    // Even a synthetic click on the disabled button posts nothing:
    // the disabled state is the primary guard, and the handler's
    // upload-await is the backstop behind it.
    fireEvent.click(submit);
    expect(paymentsCalls).toBe(0);
    putGate.release?.();
    await screen.findByText('Uploaded');
    fireEvent.click(screen.getByRole('button', { name: 'Submit payment for approval' }));
    await screen.findByText('Payment submitted');
    expect(paymentsCalls).toBe(1);
  });

  it('a click during an upload that then fails posts nothing; retry recovers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as Response));
    let paymentsCalls = 0;
    routeMintAndPayments(async () => {
      paymentsCalls += 1;
      return paymentItem({ status: 'pending' });
    });

    renderBilling('purchase');
    await goToCheckout();
    const submit = await screen.findByRole('button', { name: 'Submit payment for approval' });
    const input = document.querySelector('#billing-screenshot') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['bytes'], 'proof.png', { type: 'image/png' })] },
    });
    await screen.findByText('Uploading screenshot…');
    fireEvent.click(submit);
    await screen.findByText('Your screenshot couldn\'t be uploaded. Retry the upload to submit.');
    expect(paymentsCalls).toBe(0);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as Response));
    fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }));
    await screen.findByText('Uploaded');
    fireEvent.click(screen.getByRole('button', { name: 'Submit payment for approval' }));
    await screen.findByText('Payment submitted');
    expect(paymentsCalls).toBe(1);
  });

  it('a newer pick supersedes an in-flight upload: the second key wins', async () => {
    const mintA = { ...MINT_RESPONSE, storageKey: 'billing-screenshots/user-1/shot-a.png' };
    const mintB = { ...MINT_RESPONSE, storageKey: 'billing-screenshots/user-1/shot-b.png' };
    let mintCalls = 0;
    const putGate: { release: (() => void) | null } = { release: null };
    const putPromiseA = new Promise<Response>((resolve) => {
      putGate.release = () => resolve({ ok: true } as Response);
    });
    let putCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        putCalls += 1;
        return putCalls === 1 ? putPromiseA : Promise.resolve({ ok: true } as Response);
      })
    );
    let capturedBody: Record<string, unknown> | null = null;
    mockApiPost.mockImplementation(async (url: string, body: unknown) => {
      if (url.includes('screenshot-upload')) {
        mintCalls += 1;
        return mintCalls === 1 ? mintA : mintB;
      }
      capturedBody = body as Record<string, unknown>;
      return paymentItem({ status: 'pending' });
    });

    renderBilling('purchase');
    await goToCheckout();
    const input = document.querySelector('#billing-screenshot') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['bytes'], 'proof-a.png', { type: 'image/png' })] },
    });
    await screen.findByText('Uploading screenshot…');
    fireEvent.change(input, {
      target: { files: [new File(['bytes'], 'proof-b.png', { type: 'image/png' })] },
    });
    await screen.findByText('Uploaded');
    // The stale first upload landing late must not clobber the second.
    putGate.release?.();
    fireEvent.click(screen.getByRole('button', { name: 'Submit payment for approval' }));
    await screen.findByText('Payment submitted');
    expect(capturedBody?.['screenshotStorageKey']).toBe(mintB.storageKey);
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
    render(<AdminApprovalsView />);
    expect(await screen.findByText(/Binance/)).toBeInTheDocument();
    expect(screen.getByText('View payment screenshot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve payment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject payment' })).toBeInTheDocument();
  });
});
