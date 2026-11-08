import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@/lib/data/query-client';

import { PurchaseView } from '@/components/billing/purchase-view';
import { MyPlanView } from '@/components/billing/my-plan-view';
import { PaymentsView } from '@/components/billing/payments-view';
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

const { mockApiGet, mockApiPost, mockPush } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockApiPost: vi.fn(),
  mockPush: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
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
  status: T,
  opts: {
    storage?: unknown;
    refunds?: unknown;
    failBilling?: boolean;
    failStorage?: boolean;
    failEntitlement?: boolean;
  } = {}
): void {
  mockApiGet.mockImplementation(async (url: string) => {
    if (url.includes('/billing/entitlement')) {
      if (opts.failEntitlement) throw new Error('entitlement down');
      const entitlement = status.entitlement as Record<string, unknown>;
      return { ...entitlement, hasPriorPeriod: entitlement.hasPriorPeriod ?? false };
    }
    if (url.includes('/billing/storage')) {
      if (opts.failStorage) throw new Error('storage down');
      return (
        opts.storage ?? {
          quotaBytes: 5 * 1024 * 1024 * 1024,
          usedBytes: 0,
          remainingBytes: 5 * 1024 * 1024 * 1024,
          overBytes: 0,
          state: 'normal',
          hasActivePeriod: true,
        }
      );
    }
    if (url.includes('/billing/refunds')) {
      return opts.refunds ?? { requests: [], eligibility: { eligible: false, reason: null } };
    }
    if (opts.failBilling) throw new Error('billing down');
    return status;
  });
}

/** Render the split views the way the tenant layout does: inside
 * the shared entitlement provider. Purchase renders the builder
 * step; checkout tests re-render with step="checkout" after the
 * builder saves its draft (see goToCheckout). */
function renderBilling(section: 'purchase' | 'my-plan') {
  return render(
    <QueryClientProvider client={createQueryClient('acme')}>
      <EntitlementProvider subdomain="acme" adminOnly={false}>
        {section === 'purchase' ? (
          <PurchaseView subdomain="acme" step="builder" />
        ) : (
          <MyPlanView subdomain="acme" />
        )}
      </EntitlementProvider>
    </QueryClientProvider>
  );
}

function renderCheckout() {
  return render(
    <QueryClientProvider client={createQueryClient('acme')}>
      <EntitlementProvider subdomain="acme" adminOnly={false}>
        <PurchaseView subdomain="acme" step="checkout" />
      </EntitlementProvider>
    </QueryClientProvider>
  );
}

function renderPayments() {
  return render(
    <QueryClientProvider client={createQueryClient('acme')}>
      <EntitlementProvider subdomain="acme" adminOnly={false}>
        <PaymentsView subdomain="acme" />
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
  // The split build makes checkout a sub-route: the click pushes
  // /purchase/checkout (mocked here), so re-render at that step.
  // The builder saved its draft to session storage, which the
  // checkout step restores — the same handoff the real routes use.
  cleanup();
  renderCheckout();
}

/**
 * Confirmation is a server-backed sub-route in the split build, not
 * an in-component step: after a successful submit the view pushes
 * /purchase/confirmation?payment=<id>. Follow that handoff the way
 * the real routes do — re-render at the confirmation step with the
 * pushed payment id, serving the created payment from the server —
 * and assert the confirmation copy there.
 */
async function goToConfirmation(): Promise<void> {
  // Submit is async (post, then refetch, then push): wait for the
  // confirmation navigation to land before following it.
  await waitFor(() => {
    const found = mockPush.mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/purchase/confirmation'));
    expect(found).toBeDefined();
  });
  const confirmation = mockPush.mock.calls
    .map((call) => String(call[0]))
    .find((url) => url.includes('/purchase/confirmation'));
  expect(confirmation).toBeDefined();
  const paymentId = new URL(confirmation as string, 'https://example.com').searchParams.get('payment');
  const created = paymentItem();
  mockApiGet.mockImplementation(async (url: string) => {
    if (url.includes('/billing/entitlement')) {
      return { ...freeEntitlement(), hasPriorPeriod: false };
    }
    if (url.includes('/billing/storage')) {
      return {
        quotaBytes: 5 * 1024 * 1024 * 1024,
        usedBytes: 0,
        remainingBytes: 5 * 1024 * 1024 * 1024,
        overBytes: 0,
        state: 'normal',
        hasActivePeriod: true,
      };
    }
    if (url.includes('/billing/refunds')) {
      return { requests: [], eligibility: { eligible: false, reason: null } };
    }
    return { entitlement: freeEntitlement(), payments: [created] };
  });
  cleanup();
  render(
    <QueryClientProvider client={createQueryClient('acme')}>
      <EntitlementProvider subdomain="acme" adminOnly={false}>
        <PurchaseView subdomain="acme" step="confirmation" confirmationPaymentId={paymentId} />
      </EntitlementProvider>
    </QueryClientProvider>
  );
  await screen.findByText('We have received your payment.');
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
  // Checkout is a fresh mount in the split build: it shows a
  // loading skeleton until the billing load resolves, so wait for
  // the upload control before querying the (sr-only) input.
  await screen.findByText('Upload your payment screenshot');
  const input = document.querySelector('#billing-screenshot') as HTMLInputElement;
  fireEvent.change(input, {
    target: { files: [new File(['bytes'], 'proof.png', { type: 'image/png' })] },
  });
  await screen.findByText('Uploaded');
}

describe('Billing Purchase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try {
      sessionStorage.clear();
    } catch {
      // jsdom without storage: drafts simply do not persist.
    }
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

  it('Purchase shows only Facebook, Instagram, Threads steppers — typed number kept', async () => {
    renderBilling('purchase');
    await screen.findByText('Choose your pages and accounts');
    expect(screen.getByLabelText('Facebook pages')).toBeInTheDocument();
    expect(screen.getByLabelText('Instagram accounts')).toBeInTheDocument();
    expect(screen.getByLabelText('Threads accounts')).toBeInTheDocument();
    expect(screen.queryByLabelText('X accounts')).toBeNull();
    expect(screen.queryByLabelText('TikTok accounts')).toBeNull();
    expect(screen.queryByLabelText('YouTube accounts')).toBeNull();
    // Each row is a stepper like the mockup ("− 10 +"): minus button,
    // typed number, plus button — and no native number spinner either
    // (the inputs are text inputs).
    for (const platform of ['Facebook pages', 'Instagram accounts', 'Threads accounts']) {
      expect(
        screen.getByRole('button', { name: `Increase ${platform}` }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: `Decrease ${platform}` }),
      ).toBeInTheDocument();
    }
    expect(document.querySelector('input[type="number"]')).toBeNull();
  });

  it('builder has a live summary sidebar — the order summary itself lives only at checkout', async () => {
    renderBilling('purchase');
    await screen.findByText('Choose your pages and accounts');
    // The checkout summary card is not in the builder, but the builder
    // has its own live sidebar: per-platform lines and monthly total
    // update as counts change. The sidebar is headed YOUR PLAN, has no
    // subtitle, and carries no storage line (storage lives at checkout).
    expect(screen.queryByText('Order summary')).toBeNull();
    expect(screen.getByText('YOUR PLAN')).toBeInTheDocument();
    expect(screen.queryByText('What your plan costs each month.')).toBeNull();
    expect(screen.getByText('Monthly total')).toBeInTheDocument();
    expect(screen.queryByText('Media Library storage included')).toBeNull();
    // Continue to checkout lives in the sidebar now, full-width and
    // pill-shaped, not below the chooser.
    const continueButton = screen.getByRole('button', {
      name: 'Continue to checkout',
    });
    expect(continueButton).toBeInTheDocument();
    expect(continueButton.className).toContain('w-full');
    expect(continueButton.className).toContain('rounded-full');
    expect(continueButton.className).not.toContain('sm:self-end');
    // And the order summary is still there at checkout.
    await goToCheckout();
    expect(await screen.findByText('Order summary')).toBeInTheDocument();
    expect(screen.getByText('Monthly total')).toBeInTheDocument();
  });

  it('chooser shows stacked rows with plain questions and the increase/reduce note', async () => {
    renderBilling('purchase');
    await screen.findByText('Choose your pages and accounts');
    // One divided row per platform, full width of the left column —
    // not three columns. Each row is headed "Platform — Pages/Accounts".
    expect(screen.getByText('Facebook — Pages')).toBeInTheDocument();
    expect(screen.getByText('Instagram — Accounts')).toBeInTheDocument();
    expect(screen.getByText('Threads — Accounts')).toBeInTheDocument();
    const rows = screen.getByLabelText('Facebook pages').closest('.divide-y');
    expect(rows).not.toBeNull();
    // Each row asks a plain professional question. (The Facebook
    // question shares its paragraph with the Accounts-free note, so it
    // is matched by pattern rather than exact text.)
    expect(
      screen.getByText(/How many Facebook Pages will you post to\?/),
    ).toBeInTheDocument();
    expect(screen.getByText('How many Instagram accounts will you post from?')).toBeInTheDocument();
    expect(screen.getByText('How many Threads accounts will you post from?')).toBeInTheDocument();
    // Facebook accounts are free — only Pages are paid for.
    expect(
      screen.getByText(/connect as many Facebook accounts as you like/i),
    ).toBeInTheDocument();
    // Verbatim foot note, and the removed lines stay removed.
    expect(
      screen.getByText(
        'You can increase your pages and accounts anytime. Reducing them takes effect from your next month.',
      ),
    ).toBeInTheDocument();
    // New card description: Facebook accounts are free, only connected
    // pages are paid for — and the old wording is gone.
    expect(
      screen.getByText(
        /Facebook accounts are free — you can connect as many accounts as you like, you only pay for connected pages\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/only the pages and accounts you actually use/),
    ).toBeNull();
    expect(screen.queryByText(/Everything is 70 PKR each/)).toBeNull();
    expect(screen.queryByText('Facebook — pay for Pages only')).toBeNull();
    expect(screen.queryByText('Instagram — pay per account')).toBeNull();
    expect(screen.queryByText('Threads — pay per account')).toBeNull();
  });

  it('builder is a wide two-column layout and the chooser is a divided stack of rows', async () => {
    renderBilling('purchase');
    await screen.findByText('Choose your pages and accounts');
    // Two columns on desktop: chooser on the left, live summary sidebar
    // on the right — so the builder sits in a wide max-w-6xl container,
    // not the old narrow max-w-3xl column.
    expect(document.querySelector('.max-w-6xl')).not.toBeNull();
    expect(document.querySelector('.max-w-3xl')).toBeNull();
    const layout = screen.getByText('YOUR PLAN').closest('.grid');
    expect(layout).not.toBeNull();
    expect(layout).toHaveClass('grid-cols-1', 'items-start', 'lg:grid-cols-[1fr_360px]');
    // The chooser is one divided stack: three rows, one per platform,
    // each with its typed input at the right end — no columns, no tiles.
    const stack = screen.getByLabelText('Facebook pages').closest('.divide-y');
    expect(stack).not.toBeNull();
    expect(stack).toHaveClass('flex-col');
    expect(stack).not.toHaveClass('grid');
    // No three-column chooser grid anywhere in the chooser card.
    const chooserCard = screen
      .getByText('Choose your pages and accounts')
      .closest('[data-slot="card"]');
    expect(chooserCard).not.toBeNull();
    expect(chooserCard?.querySelector('.sm\\:grid-cols-3')).toBeNull();
    // The input sits at the right end of its row, so it never clips
    // at the tighter container width. (The input is nested in the
    // stepper group now, so the row is reached from the row heading
    // rather than from the input.)
    const row = screen.getByText('Facebook — Pages').closest('div.flex');
    expect(row).not.toBeNull();
    expect(row).toHaveClass('flex-wrap', 'items-center', 'justify-between');
    // Checkout keeps its wide container and its order summary.
    await goToCheckout();
    expect(await screen.findByText('Order summary')).toBeInTheDocument();
    expect(document.querySelector('.max-w-6xl')).not.toBeNull();
  });

  it('typing a count updates the sidebar line and total live', async () => {
    renderBilling('purchase');
    await screen.findByText('Choose your pages and accounts');
    const facebook = screen.getByLabelText('Facebook pages') as HTMLInputElement;
    fireEvent.change(facebook, { target: { value: '100' } });
    expect(facebook.value).toBe('100');
    // No per-row price in the chooser anymore — the price lives only in
    // the sidebar, in the mockup's "Facebook · Pages × 100" format. The
    // "7000 PKR" appears twice, both in the sidebar: the platform line
    // and the monthly total — never in the chooser card.
    expect(screen.getByText('Facebook · Pages × 100')).toBeInTheDocument();
    expect(screen.getAllByText('7000 PKR')).toHaveLength(2);
    const chooserCard = screen
      .getByText('Choose your pages and accounts')
      .closest('[data-slot="card"]');
    expect(chooserCard?.textContent ?? '').not.toContain('7000 PKR');
    const instagram = screen.getByLabelText('Instagram accounts') as HTMLInputElement;
    fireEvent.change(instagram, { target: { value: '4' } });
    expect(screen.getByText('Instagram · Accounts × 4')).toBeInTheDocument();
    expect(screen.getAllByText('280 PKR').length).toBeGreaterThan(0);
  });

  it('stepper buttons step by 1, never below 0, and update the sidebar live', async () => {
    renderBilling('purchase');
    await screen.findByText('Choose your pages and accounts');
    const facebook = screen.getByLabelText('Facebook pages') as HTMLInputElement;
    const decrease = screen.getByRole('button', { name: 'Decrease Facebook pages' });
    const increase = screen.getByRole('button', { name: 'Increase Facebook pages' });
    // Minus is disabled at 0 — the count can never go below 0.
    expect(decrease).toBeDisabled();
    fireEvent.click(increase);
    expect(facebook.value).toBe('1');
    expect(screen.getByText('Facebook · Pages × 1')).toBeInTheDocument();
    expect(screen.getAllByText('70 PKR').length).toBeGreaterThan(0);
    fireEvent.click(increase);
    expect(facebook.value).toBe('2');
    expect(screen.getByText('Facebook · Pages × 2')).toBeInTheDocument();
    fireEvent.click(decrease);
    expect(facebook.value).toBe('1');
    fireEvent.click(decrease);
    expect(facebook.value).toBe('0');
    expect(decrease).toBeDisabled();
    // Stepping from an in-progress draft steps from the last valid
    // count and drops the draft, so the field shows the stepped value.
    fireEvent.change(facebook, { target: { value: 'xyz' } });
    expect(facebook.value).toBe('xyz');
    fireEvent.click(increase);
    expect(facebook.value).toBe('1');
    expect(screen.getByText('Facebook · Pages × 1')).toBeInTheDocument();
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

  it('Purchase shows the seven free inclusions in the sidebar; the storage total lives at checkout', async () => {
    renderBilling('purchase');
    await screen.findByText('Included for free with paid plan');
    // No separate Included card anymore — the list lives in the
    // sidebar, below the monthly total.
    expect(screen.queryByText('Included with your plan')).toBeNull();
    expect(
      screen.getByText('5 GB of Media Library storage per page or account')
    ).toBeInTheDocument();
    expect(screen.getByText('Creator Finder included free')).toBeInTheDocument();
    expect(
      screen.getByText('Unlimited posts — no cap on the number of posts')
    ).toBeInTheDocument();
    expect(screen.getByText('In-app scheduling')).toBeInTheDocument();
    expect(screen.getByText('Auto download & upload')).toBeInTheDocument();
    expect(screen.getByText('Auto repost')).toBeInTheDocument();
    expect(screen.getByText('Bulk publishing')).toBeInTheDocument();
    // The sidebar carries no storage line (mockup E has none) — the
    // storage total lives at checkout: 15 GB once 2 Facebook pages +
    // 1 Instagram account are typed.
    expect(screen.queryByText('Media Library storage included')).toBeNull();
    fireEvent.change(screen.getByLabelText('Facebook pages'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Instagram accounts'), { target: { value: '1' } });
    expect(screen.queryByText('Media Library storage included')).toBeNull();
    // And checkout still shows the same storage total.
    fireEvent.click(screen.getByRole('button', { name: 'Continue to checkout' }));
    cleanup();
    renderCheckout();
    expect(await screen.findByText('Media Library storage included')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('15 GB')).toBeInTheDocument());
  });

  it('Included list lives in the sidebar, below the monthly total', async () => {
    renderBilling('purchase');
    await screen.findByText('Included for free with paid plan');
    // No separate Included card anywhere in the builder.
    expect(screen.queryByText('Included with your plan')).toBeNull();
    // The list sits inside the sidebar card, below the monthly total
    // and above the Continue button.
    const sidebar = screen.getByText('YOUR PLAN').closest('[data-slot="card"]');
    expect(sidebar).not.toBeNull();
    expect(sidebar).toHaveTextContent('Monthly total');
    expect(sidebar).toHaveTextContent('Included for free with paid plan');
    expect(sidebar).toHaveTextContent('Continue to checkout');
    const html = sidebar?.innerHTML ?? '';
    expect(html.indexOf('Monthly total')).toBeLessThan(
      html.indexOf('Included for free with paid plan'),
    );
    expect(html.indexOf('Included for free with paid plan')).toBeLessThan(
      html.indexOf('Continue to checkout'),
    );
    // All seven rows render, with the same wording.
    expect(
      screen.getByText('5 GB of Media Library storage per page or account')
    ).toBeInTheDocument();
    expect(screen.getByText('Creator Finder included free')).toBeInTheDocument();
    expect(
      screen.getByText('Unlimited posts — no cap on the number of posts')
    ).toBeInTheDocument();
    expect(screen.getByText('In-app scheduling')).toBeInTheDocument();
    expect(screen.getByText('Auto download & upload')).toBeInTheDocument();
    expect(screen.getByText('Auto repost')).toBeInTheDocument();
    expect(screen.getByText('Bulk publishing')).toBeInTheDocument();
  });

  it('My Plan shows all six platforms in the paid counts line', async () => {
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
    await screen.findByText('Monthly plan');
    expect(screen.getByText(/2 Facebook pages/)).toBeInTheDocument();
    expect(screen.getByText(/1 Instagram account/)).toBeInTheDocument();
    expect(screen.getByText(/1 Threads account/)).toBeInTheDocument();
    expect(screen.getByText(/1 X account/)).toBeInTheDocument();
    expect(screen.getByText(/1 TikTok account/)).toBeInTheDocument();
    expect(screen.getByText(/1 YouTube account/)).toBeInTheDocument();
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

  it('My Plan shows Free plus a submitted-for-approval card when a payment is pending', async () => {
    mockBillingApi(statusFixture([paymentItem()]));
    renderBilling('my-plan');
    expect(await screen.findByText('Submitted for approval')).toBeInTheDocument();
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.getAllByText(/70 PKR/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        'Your monthly plan starts when we approve your payment, not when you paid. If approval takes a few days, those days are not added to your plan.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View payments' })).toBeInTheDocument();
    // Separate-sections state flow: the Free card stays, and the
    // pending card is added — the payment is never hidden.
    expect(screen.getByText('Free')).toBeInTheDocument();
  });

  it('My Plan keeps Expired for a lapsed user even with a payment pending', async () => {
    mockBillingApi({
      entitlement: { ...freeEntitlement(), hasPriorPeriod: true },
      payments: [paymentItem()],
    });
    renderBilling('my-plan');
    expect(await screen.findByText('Expired')).toBeInTheDocument();
    expect(await screen.findByText('Renewal waiting for approval')).toBeInTheDocument();
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
    expect(await screen.findByText('My plan')).toBeInTheDocument();
    expect(screen.getByText('Monthly plan')).toBeInTheDocument();
    expect(await screen.findByText('Upgrade waiting for approval')).toBeInTheDocument();
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
    expect(await screen.findByText('Manual payments only.')).toBeInTheDocument();
    expect(screen.getByText('Your plan runs for 30 days after approval.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Pay via Binance' }));
    expect(screen.getByText('Binance ID')).toBeInTheDocument();
    expect(screen.getAllByText('983001576').length).toBeGreaterThan(0);
    expect(screen.getByText('Copy Binance ID')).toBeInTheDocument();
    expect(screen.getByText('shahzebpyc')).toBeInTheDocument();
    await pickScreenshot();
    fireEvent.click(screen.getByRole('button', { name: 'Submit payment for approval' }));
    await goToConfirmation();
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
    await goToConfirmation();
    expect(screen.queryByText('Upload your payment screenshot')).toBeNull();
  });

  it('checkout shows the compact coupon directly above the order summary', async () => {
    renderBilling('purchase');
    await goToCheckout();
    // Both live in the right column now: coupon first, summary second.
    const summary = await screen.findByText('Order summary');
    const couponInput = screen.getByLabelText('Coupon code') as HTMLInputElement;
    expect(couponInput.placeholder).toBe('e.g. SAVE20');
    // DOM order is the placement contract: the summary heading
    // follows the coupon input, inside the same column.
    expect(
      couponInput.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const summaryCard = summary.closest('[data-slot="card"]');
    expect(summaryCard).not.toBeNull();
    expect(summaryCard?.parentElement?.contains(couponInput)).toBe(true);
    // The compact card drops the visible label row but keeps the
    // title and hint.
    expect(screen.getByText('Coupon')).toBeInTheDocument();
    expect(screen.getByText('Have a coupon code? Apply it before you pay.')).toBeInTheDocument();
  });

  it('checkout offers manual payments only — no crypto option renders', async () => {
    renderBilling('purchase');
    await goToCheckout();
    expect(screen.getByText('Manual payments only.')).toBeInTheDocument();
    expect(screen.queryByText(/crypto/i)).toBeNull();
    expect(screen.queryByText(/USDT/)).toBeNull();
    expect(screen.queryByText(/TRC20|BEP20/)).toBeNull();
    // Step 1 holds the four manual methods, and only those.
    for (const label of ['Pay via Easypaisa', 'Pay via Nayapay', 'Pay via Bank transfer', 'Pay via Binance']) {
      expect(screen.getByRole('radio', { name: label })).toBeInTheDocument();
    }
  });

  it('checkout coupon input uppercases typed codes and Apply stays disabled while empty', async () => {
    renderBilling('purchase');
    await goToCheckout();
    const couponInput = (await screen.findByLabelText('Coupon code')) as HTMLInputElement;
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply).toBeDisabled();
    fireEvent.change(couponInput, { target: { value: 'save20' } });
    expect(couponInput.value).toBe('SAVE20');
    expect(apply).not.toBeDisabled();
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
    await goToConfirmation();
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
    await goToConfirmation();
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
    await goToConfirmation();
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
    await screen.findByText('Upload your payment screenshot');
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
    await screen.findByText('Upload your payment screenshot');
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
    await screen.findByText('Upload your payment screenshot');
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
    await goToConfirmation();
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
    await goToConfirmation();
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
    await screen.findByText('Upload your payment screenshot');
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
    await goToConfirmation();
    expect(capturedBody?.['screenshotStorageKey']).toBe(mintB.storageKey);
  });
});

describe('Admin approvals view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    try {
      sessionStorage.clear();
    } catch {
      // jsdom without storage: drafts simply do not persist.
    }
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
    // Screenshot is inline in the new admin view (loading, then
    // the preview or a load failure), not a separate
    // 'View payment screenshot' button.
    expect(
      await screen.findByText(/Loading screenshot…|The screenshot could not be loaded/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve payment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject payment' })).toBeInTheDocument();
  });
});

/**
 * My Plan view states (split build): the plan card follows the
 * proven entitlement, and the payment-derived cards (submitted,
 * rejected, upgrade waiting, scheduled downgrade, renewal waiting,
 * refund waiting) follow the /billing payment list. Storage states
 * follow the /billing/storage answer; failures in payments or
 * storage never hide the plan itself.
 */
describe('My Plan view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBillingApi(statusFixture());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetReportErrorTransport();
  });

  function paidEntitlement() {
    return {
      plan: 'paid',
      active: true,
      counts: { ...ZERO_COUNTS, facebook: 2, instagram: 1, threads: 1, x: 1, tiktok: 1, youtube: 1 },
      usage: { ...ZERO_COUNTS },
      periodEndsAt: '2026-11-30T00:00:00.000Z',
      periodStartsAt: '2026-10-31T00:00:00.000Z',
      canPost: true,
      readOnly: false,
      reason: null,
      hasPriorPeriod: true,
    };
  }

  function expiredEntitlement() {
    return {
      plan: 'paid',
      active: false,
      counts: { ...ZERO_COUNTS },
      usage: { ...ZERO_COUNTS },
      periodEndsAt: '2026-10-31T00:00:00.000Z',
      periodStartsAt: '2026-10-01T00:00:00.000Z',
      canPost: false,
      readOnly: true,
      reason: 'Your monthly plan has ended.',
      hasPriorPeriod: true,
    };
  }

  it('Free shows the Free card and a buy button', async () => {
    renderBilling('my-plan');
    expect(await screen.findByText('Free', { exact: true })).toBeInTheDocument();
    expect(
      screen.getByText('You are on the Free plan. Posting needs a monthly plan.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buy a monthly plan' })).toBeInTheDocument();
  });

  it('Paid shows counts, monthly price, and included vs in-use', async () => {
    mockBillingApi({ entitlement: paidEntitlement(), payments: [] });
    renderBilling('my-plan');
    expect(await screen.findByText('Monthly plan')).toBeInTheDocument();
    expect(screen.getByText(/490 PKR \/ month/)).toBeInTheDocument();
    expect(screen.getByText(/7 included, 0 in use/)).toBeInTheDocument();
    expect(screen.getByText(/70 PKR per page or account, paid monthly/)).toBeInTheDocument();
  });

  it('Expired shows the previous plan counts and a renew button', async () => {
    mockBillingApi({
      entitlement: expiredEntitlement(),
      payments: [paymentItem({ status: 'approved', counts: { ...ZERO_COUNTS, facebook: 2 } })],
    });
    renderBilling('my-plan');
    expect(await screen.findByText('Expired')).toBeInTheDocument();
    expect(screen.getByText(/Your previous monthly plan was/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Renew your plan' })).toBeInTheDocument();
  });

  it('Free plus a pending payment shows the submitted card, not an active plan', async () => {
    mockBillingApi(statusFixture([paymentItem()]));
    renderBilling('my-plan');
    expect(await screen.findByText('Submitted for approval')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your monthly plan starts when we approve your payment, not when you paid. If approval takes a few days, those days are not added to your plan.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View payments' })).toBeInTheDocument();
    expect(
      screen.getByText('You can build a new plan once this payment is decided.')
    ).toBeInTheDocument();
  });

  it('Rejected shows the reason and Pay again prefills Purchase', async () => {
    mockBillingApi(
      statusFixture([
        paymentItem({
          status: 'rejected',
          rejectionReason: 'Wrong amount',
          rejectionDetail: 'Sent 60, not 70.',
        }),
      ])
    );
    renderBilling('my-plan');
    expect(await screen.findByText('Payment rejected')).toBeInTheDocument();
    expect(screen.getByText(/Reason: Wrong amount — Sent 60, not 70\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pay again' }));
    expect(mockPush).toHaveBeenCalledWith('/tenant/acme/purchase');
  });

  it('Paid plus a pending upgrade shows the upgrade-waiting card', async () => {
    mockBillingApi({
      entitlement: paidEntitlement(),
      payments: [paymentItem({ isUpgrade: true })],
    });
    renderBilling('my-plan');
    expect(await screen.findByText('Upgrade waiting for approval')).toBeInTheDocument();
    expect(
      screen.getByText('Your current plan keeps running unchanged until this upgrade is approved.')
    ).toBeInTheDocument();
  });

  it('Approved downgrade with a future start shows the scheduled card, no credit', async () => {
    mockBillingApi({
      entitlement: paidEntitlement(),
      payments: [
        paymentItem({
          status: 'approved',
          isDowngrade: true,
          scheduledStartsAt: '2099-01-01T00:00:00.000Z',
        }),
      ],
    });
    renderBilling('my-plan');
    expect(await screen.findByText('Scheduled downgrade')).toBeInTheDocument();
    expect(screen.getByText(/New monthly plan:/)).toBeInTheDocument();
    expect(screen.getByText(/No credit was given for the days left/)).toBeInTheDocument();
  });

  it('Expired plus a pending payment shows renewal waiting', async () => {
    mockBillingApi({
      entitlement: expiredEntitlement(),
      payments: [paymentItem()],
    });
    renderBilling('my-plan');
    expect(await screen.findByText('Renewal waiting for approval')).toBeInTheDocument();
  });

  it('A pending refund shows the refund-waiting card', async () => {
    mockBillingApi(statusFixture(), {
      refunds: { requests: [{ id: 'r1', status: 'requested' }], eligibility: { eligible: false, reason: null } },
    });
    renderBilling('my-plan');
    expect(await screen.findByText('Refund request waiting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View refund' })).toBeInTheDocument();
  });

  it('Storage nearly full warns, full and over quota offer more units', async () => {
    const GB = 1024 * 1024 * 1024;
    mockBillingApi(statusFixture(), {
      storage: { quotaBytes: 5 * GB, usedBytes: 4.5 * GB, state: 'near' },
    });
    const { unmount } = renderBilling('my-plan');
    expect(await screen.findByText(/4\.5 GB used of 5\.0 GB — nearly full/)).toBeInTheDocument();
    expect(screen.getByText(/You are close to your limit/)).toBeInTheDocument();
    unmount();

    mockBillingApi(statusFixture(), {
      storage: { quotaBytes: 5 * GB, usedBytes: 6 * GB, state: 'over' },
    });
    renderBilling('my-plan');
    expect(await screen.findByText(/6\.0 GB used of 5\.0 GB — over quota/)).toBeInTheDocument();
    expect(screen.getByText(/You are out of space/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add pages or accounts' })).toBeInTheDocument();
  });

  it('A payments failure shows an alert but the plan stays correct', async () => {
    mockBillingApi({ entitlement: paidEntitlement(), payments: [] }, { failBilling: true });
    renderBilling('my-plan');
    expect(await screen.findByText('Monthly plan')).toBeInTheDocument();
    expect(screen.getByText(/Couldn.t load your payments/)).toBeInTheDocument();
  });

  it('A storage failure shows a storage alert with retry', async () => {
    mockBillingApi(statusFixture(), { failStorage: true });
    renderBilling('my-plan');
    expect(await screen.findByText(/Couldn.t check storage/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('An unproven entitlement shows the plan-check error, not a Free card', async () => {
    mockBillingApi(statusFixture(), { failEntitlement: true });
    renderBilling('my-plan');
    // The shared query retries once before settling unproven, so
    // allow more than the default 1s find timeout.
    expect(
      await screen.findByText(/Couldn.t check your plan/, {}, { timeout: 10000 })
    ).toBeInTheDocument();
    expect(screen.queryByText('Free', { exact: true })).toBeNull();
  });
});

/**
 * Payments view (split build): rows from the paginated status
 * endpoint, rejection reasons, load-more paging, and the empty
 * and error states.
 */
describe('Payments view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetReportErrorTransport();
  });

  function mockPaymentsApi(pages: Record<number, unknown[]>) {
    mockApiGet.mockImplementation(async (url: string) => {
      if (url.includes('/billing/entitlement')) {
        return { ...freeEntitlement(), hasPriorPeriod: false };
      }
      const page = Number(new URL(url, 'https://example.com').searchParams.get('page') ?? 1);
      return { entitlement: freeEntitlement(), payments: pages[page] ?? [] };
    });
  }

  it('Rows show amount, method, and status', async () => {
    mockPaymentsApi({
      1: [
        paymentItem(),
        paymentItem({
          id: '22222222-2222-4222-a222-222222222222',
          method: 'bank',
          bankMethod: 'nayapay',
          status: 'approved',
        }),
      ],
    });
    renderPayments();
    expect(await screen.findByText('70 PKR · Easypaisa')).toBeInTheDocument();
    expect(screen.getByText('70 PKR · Nayapay')).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });

  it('Rejected rows show the reason; empty shows the first-use state', async () => {
    mockPaymentsApi({
      1: [paymentItem({ status: 'rejected', rejectionReason: 'Wrong amount' })],
    });
    const { unmount } = renderPayments();
    expect(await screen.findByText(/Rejected: Wrong amount/)).toBeInTheDocument();
    unmount();

    mockPaymentsApi({ 1: [] });
    renderPayments();
    expect(await screen.findByText('No payments yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buy a monthly plan' })).toBeInTheDocument();
  });

  it('A full first page offers load-more and appends page two', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => paymentItem({ id: `page1-${i}` }));
    mockPaymentsApi({ 1: page1, 2: [paymentItem({ id: 'page2-0' })] });
    renderPayments();
    expect(await screen.findByText('Showing 50 payments — more below')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more payments' }));
    await waitFor(() =>
      expect(screen.getByText('Showing 51 payments.')).toBeInTheDocument()
    );
  });

  it('A load failure shows the error with a retry', async () => {
    mockApiGet.mockImplementation(async (url: string) => {
      if (url.includes('/billing/entitlement')) {
        return { ...freeEntitlement(), hasPriorPeriod: false };
      }
      throw new Error('payments down');
    });
    renderPayments();
    expect(await screen.findByText(/Couldn.t load payments/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

/**
 * Purchase downgrade builder (split build): a paid user who lowers a
 * count gets the prepaid next-month quote — old vs new monthly total,
 * pay-now = the new total, no credit for the days left — and checkout
 * carries the downgrade label.
 */
describe('Purchase downgrade builder', () => {
  it('lowering a count quotes the new monthly total prepaid, with no credit', async () => {
    sessionStorage.clear();
    const paidEntitlement = {
      plan: 'paid',
      active: true,
      counts: { ...ZERO_COUNTS, facebook: 2 },
      usage: { ...ZERO_COUNTS, facebook: 1 },
      periodEndsAt: '2099-01-01T00:00:00.000Z',
      periodStartsAt: '2026-10-01T00:00:00.000Z',
      canPost: true,
      readOnly: false,
      reason: null,
    };
    mockBillingApi({
      entitlement: paidEntitlement,
      payments: [
        paymentItem({
          status: 'approved',
          counts: { ...ZERO_COUNTS, facebook: 2 },
          amountPkr: 140,
          approvedAt: '2026-10-01T00:00:00.000Z',
        }),
      ],
    });
    renderBilling('purchase');
    await screen.findByText('Choose your pages and accounts');
    const facebook = screen.getByLabelText('Facebook pages') as HTMLInputElement;
    // Prefilled from the most recent approved payment.
    expect(facebook.value).toBe('2');
    fireEvent.change(facebook, { target: { value: '1' } });
    fireEvent.blur(facebook);
    // The quote lives in the order summary, and the summary lives only
    // at checkout now — the builder shows no quote lines.
    expect(screen.queryByText('Current monthly plan')).toBeNull();
    expect(screen.queryByText('New monthly plan')).toBeNull();
    expect(screen.queryByText('You pay now')).toBeNull();
    // Checkout is a sub-route: the click pushes /purchase/checkout
    // (mocked here), so follow it the way the real routes do —
    // re-render at the checkout step with the builder's saved draft.
    fireEvent.click(screen.getByRole('button', { name: 'Continue to checkout' }));
    cleanup();
    renderCheckout();
    expect(await screen.findByRole('heading', { name: 'Checkout' })).toBeInTheDocument();
    expect(screen.getByText('Current monthly plan')).toBeInTheDocument();
    expect(screen.getByText('New monthly plan')).toBeInTheDocument();
    expect(screen.getByText('You pay now')).toBeInTheDocument();
    // The two downgrade paragraphs were removed from the summary:
    // only the header line above the step indicator names the lower plan.
    expect(screen.queryByText(/Your current plan runs unchanged until/)).toBeNull();
    expect(screen.queryByText(/No credit was given for the days left/)).toBeNull();
    expect(screen.queryByText(/never backdated/)).toBeNull();
    // Header line only (the summary card uses a period, not the middot).
    expect(screen.getByText(/Lower monthly plan for next month · 1 Facebook pages/)).toBeInTheDocument();
  });
});
