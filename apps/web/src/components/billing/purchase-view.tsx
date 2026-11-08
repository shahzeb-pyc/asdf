'use client';

/**
 * PurchaseView — the Purchase route tree only (builder, checkout,
 * confirmation), split out of the old BillingView in the 2026-11-02
 * separate-sections build. My Plan, Payments and Refund live in
 * their own views; this file owns nothing else.
 *
 * Routes: /purchase (builder), /purchase/checkout, and
 * /purchase/confirmation?payment=<paymentId>. The builder draft
 * (counts, coupon, payment type/method) is kept in this tab's
 * session storage so moving builder -> checkout keeps it; checkout
 * and confirmation are backed by the payment row on the server, so
 * a refresh on confirmation re-reads the same payment by id.
 * A successful zero-due activation has no payment row, so it goes
 * straight to My Plan instead of a confirmation page.
 */

import * as React from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { ArrowLeftIcon, CheckIcon, Loader2Icon, MinusIcon, PlusIcon, UploadIcon, XIcon } from 'lucide-react';
import { apiGet, apiPost, buildTenantApiPath, getErrorMessage, isApiError } from '@/lib/api';
import {
  BillingPaymentItemSchema,
  UserRefundsResponseSchema,
  BillingStatusResponseSchema,
  ZeroDueCheckoutResponseSchema,
  type BillingStatusResponse,
  type CouponValidateResponse,
  type PlatformCounts,
} from '@/lib/api/schemas/billing';
import {
  daysRemainingBetween,
  quoteDowngrade,
  quoteUpgrade,
  SUBSCRIPTION_PLATFORMS,
  SUBSCRIPTION_PRICE_PKR_PER_UNIT,
  subscriptionUnitLabel,
  totalPricePkr,
  totalUnits,
  ZERO_PLATFORM_COUNTS,
  type BillingPaymentItem,
  type DowngradeQuote,
  type UpgradeQuote,
} from '@fbuploadpro/contracts';
import { BANK_PAYMENT_DETAILS } from '@/lib/billing/payment-details';
import {
  ScreenshotUploadError,
  timeoutSignal,
  uploadScreenshotFile,
} from '@/lib/billing/screenshot-upload';
import { reportError } from '@/lib/report-error';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { Input } from '@/components/shared/ui/input';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { BillingStatusMark } from './billing-status-mark';
import { CouponSection } from './coupon-section';
import { useSharedEntitlement } from './entitlement-provider';

const PLATFORM_LABELS: Record<keyof PlatformCounts, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
  x: 'X',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

/**
 * Platforms that can be bought in Purchase. X, TikTok, and YouTube
 * sections are still "Being tested — not available for public use",
 * so their rows are hidden from Purchase entirely (not disabled).
 * Purchase ONLY: My Plan, Payments history, and admin views keep
 * showing all platforms, and upgrade math still runs on the full
 * counts — a legacy period holding X/TikTok/YouTube counts carries
 * those counts through unchanged, since no stepper can alter them.
 */
const PURCHASABLE_PLATFORMS: (keyof PlatformCounts)[] = ['facebook', 'instagram', 'threads'];

/**
 * Rows in the builder sidebar's "Included for free with paid plan"
 * section, in the owner's order (mockup E). These are plan features,
 * not priced lines — they never change the total.
 */
const BUILDER_INCLUDED_FREE: readonly string[] = [
  '5 GB of Media Library storage per page or account',
  'Creator Finder included free',
  'Unlimited posts — no cap on the number of posts',
  'In-app scheduling',
  'Auto download & upload',
  'Auto repost',
  'Bulk publishing',
];

/** Purchase display view of counts: unpurchasable platforms zeroed. */
function purchasableCounts(counts: PlatformCounts): PlatformCounts {
  return { ...counts, x: 0, tiktok: 0, youtube: 0 };
}

type BankMethod = 'easypaisa' | 'nayapay' | 'ubl' | 'binance';
type PurchaseStep = 'builder' | 'checkout' | 'confirmation';

/** Step 1 "Pay via" labels. "Bank transfer" is the label for the UBL bank method. */
const PAY_VIA_LABELS: Record<BankMethod, string> = {
  easypaisa: 'Easypaisa',
  nayapay: 'Nayapay',
  ubl: 'Bank transfer',
  binance: 'Binance',
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/** Same wording as the server's 409, for the client-side guard. */
const PENDING_CHECKOUT_MESSAGE =
  'You already have a payment waiting for approval. Wait for it to be decided before submitting another.';

function plainQuoteError(message: string | null): string | null {
  if (!message) return null;
  if (
    message ===
    'Counts can only be increased mid-cycle. To reduce a count, wait until the current period ends.'
  ) {
    return 'You can only increase counts during your current month. To lower a count, wait until this month ends.';
  }
  if (message === 'An upgrade must cost more than the current plan.') {
    return 'Your new plan must cost more than your current plan.';
  }
  return message;
}

function paymentMethodLabel(payment: BillingPaymentItem): string {
  return payment.bankMethod ? BANK_PAYMENT_DETAILS[payment.bankMethod].label : 'Bank';
}

function paymentStatusLabel(status: string): string {
  if (status === 'pending') return 'Waiting for approval';
  if (status === 'approved' || status === 'paid') return 'Paid';
  if (status === 'rejected') return 'Rejected';
  if (status === 'failed') return 'Failed';
  return 'Expired';
}

function countsSummary(counts: PlatformCounts): string {
  const parts = SUBSCRIPTION_PLATFORMS.filter((p) => counts[p] > 0).map(
    (p) => `${counts[p]} ${PLATFORM_LABELS[p]} ${subscriptionUnitLabel(p)}`
  );
  return parts.length > 0 ? parts.join(', ') : 'No pages or accounts selected';
}

/** Skeleton for the My Plan section (the Billing default view). */
function BillingSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading billing" className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Steps inside the Purchase section only (builder → checkout →
 * confirmation). These are view state inside Purchase, not sidebar
 * leaves and not ?view= values; the sidebar navigates between the
 * three sections, and Back controls inside Purchase move between
 * these steps.
 */
function PurchaseStepIndicator({ current }: Readonly<{ current: PurchaseStep }>) {
  const steps: { id: PurchaseStep; label: string }[] = [
    { id: 'builder', label: 'Build plan' },
    { id: 'checkout', label: 'Checkout' },
    { id: 'confirmation', label: 'Confirmation' },
  ];
  const currentIndex = steps.findIndex((step) => step.id === current);
  return (
    <nav aria-label="Billing steps" className="flex flex-wrap items-center gap-2">
      {steps.map((step, index) => {
        const active = step.id === current;
        const done = index < currentIndex;
        return (
          <span key={step.id} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden className="h-px w-6 bg-line" /> : null}
            <span
              aria-hidden
              className={cn(
                'flex size-6 items-center justify-center rounded-full text-metadata font-medium',
                active ? 'bg-primary text-on-primary' : 'bg-subtle text-ink-sub'
              )}
            >
              {done ? <CheckIcon className="size-3.5" /> : index + 1}
            </span>
            <span
              aria-current={active ? 'step' : undefined}
              className={cn('text-body', active ? 'font-medium text-ink' : 'text-ink-sub')}
            >
              {step.label}
            </span>
          </span>
        );
      })}
    </nav>
  );
}

export function PurchaseView({
  subdomain,
  step,
  confirmationPaymentId,
}: Readonly<{
  subdomain: string;
  step: PurchaseStep;
  confirmationPaymentId?: string | null;
}>) {
  const [status, setStatus] = React.useState<BillingStatusResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const [counts, setCounts] = React.useState<PlatformCounts | null>(null);
  /**
   * Plan decisions (Paid / Expired / Free, My Plan card, pending
   * verification) come from the tenant layout's shared entitlement
   * query — the same data the gate and the sidebar word read — not
   * from this view's own /billing fetch. The /billing fetch below
   * still supplies payments (and the pending-payment row); its
   * nested entitlement is ignored for plan decisions so the three
   * surfaces can never disagree, and so the plan display refreshes
   * on window focus through the shared query instead of going stale
   * after the mount-only load.
   */
  const sharedEntitlement = useSharedEntitlement();
  // Raw text of each chooser input while it is being edited. The
  // committed count (above) is the single source of truth for prices,
  // totals, quotes, and submission; drafts only hold what the field
  // shows mid-edit so an invalid keystroke can be reverted on blur
  // without ever touching the totals.
  const [countDrafts, setCountDrafts] = React.useState<Partial<Record<keyof PlatformCounts, string>>>({});
  const router = useRouter();

  const [bankMethod, setBankMethod] = React.useState<BankMethod>('easypaisa');
  const [screenshot, setScreenshot] = React.useState<File | null>(null);
  /**
   * Screenshot upload state (submit rewrite 2026-11-01): the file
   * uploads straight to R2 as soon as it is picked, and submit is
   * blocked until the upload finishes. `uploading` shows its own
   * loading state in the screenshot area; `failed` shows the
   * specific upload error with a retry action — the submit button
   * never fires without an uploaded key, and a failed upload never
   * falls through to the generic submit error.
   */
  type ScreenshotUploadState =
    | { status: 'idle' }
    | { status: 'uploading' }
    | { status: 'uploaded'; storageKey: string }
    | { status: 'failed'; error: string };
  const [screenshotUpload, setScreenshotUpload] = React.useState<ScreenshotUploadState>({
    status: 'idle',
  });
  const screenshotUploadRunRef = React.useRef(0);
  const screenshotUploadPromiseRef = React.useRef<Promise<string | null> | null>(null);
  /** Handler-level double-submit guard (see submitBank). */
  const submitBusyRef = React.useRef(false);
  /**
   * Stable idempotency key for the current checkout visit, minted
   * on entering checkout. Automatic and manual retries of the same
   * submission reuse it, so a retry can replay — never duplicate.
   * Cleared on success; a fresh visit mints a fresh key.
   */
  const submissionKeyRef = React.useRef<string | null>(null);
  const [bankSubmitFailed, setBankSubmitFailed] = React.useState(false);
  const [appliedCoupon, setAppliedCoupon] = React.useState<CouponValidateResponse | null>(null);
  const [refundPending, setRefundPending] = React.useState(false);
  const [prefillNote, setPrefillNote] = React.useState<string | null>(null);
  const DRAFT_KEY = 'fbuploadpro-purchase-draft';
  // Restore the builder draft when entering checkout (the builder
  // unmounts on the route change, so the draft rides in session
  // storage for this tab only; it is cleared on a successful
  // submission). Checkout without a draft goes back to the builder.
  // Back from checkout to the builder keeps the draft too: the
  // builder restores the same session-storage draft on mount.
  React.useEffect(() => {
    if (step !== 'builder') return;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as {
        counts?: PlatformCounts;
        bankMethod?: BankMethod;
      };
      if (draft.counts) setCounts(draft.counts);
      if (draft.bankMethod) setBankMethod(draft.bankMethod);
    } catch (err) {
      // A corrupt draft is ignored; the builder starts fresh.
      // Logged, not swallowed: a persistently corrupt draft means
      // the draft format changed and users keep losing their builder.
      reportError(err, { source: 'purchase-draft' });
    }
  }, [step]);
  React.useEffect(() => {
    if (step !== 'checkout') return;
    try {
      const raw = sessionStorage.getItem(DRAFT_KEY);
      if (!raw) {
        router.push(`/tenant/${subdomain}/purchase`);
        return;
      }
      const draft = JSON.parse(raw) as {
        counts?: PlatformCounts;
        bankMethod?: BankMethod;
      };
      if (draft.counts) setCounts(draft.counts);
      if (draft.bankMethod) setBankMethod(draft.bankMethod);
    } catch {
      router.push(`/tenant/${subdomain}/purchase`);
    }
  }, [step]);
  const [activatingZeroDue, setActivatingZeroDue] = React.useState(false);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'bank' | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const screenshotInputRef = React.useRef<HTMLInputElement | null>(null);
  const [screenshotPreviewUrl, setScreenshotPreviewUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!screenshot) {
      setScreenshotPreviewUrl(null);
      return;
    }
    // jsdom's URL.createObjectURL cannot wrap a jsdom File (it is
    // not a real Blob), and a missing preview must never crash
    // checkout: fall back to no preview image, the upload itself
    // is unaffected.
    let url: string | null = null;
    try {
      url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(screenshot) : null;
    } catch {
      url = null;
    }
    setScreenshotPreviewUrl(url);
    return () => {
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch (err) {
          // Revocation is best-effort; a failure only leaks a blob URL.
          reportError(err, { source: 'purchase-screenshot-revoke' });
        }
      }
    };
  }, [screenshot]);

  const load = React.useCallback(async () => {
    try {
      const result = await apiGet(buildTenantApiPath(subdomain, '/billing'), {
        schema: BillingStatusResponseSchema,
      });
      setStatus(result);
      setLoadError(null);
    } catch (err) {
      setLoadError(getErrorMessage(err));
    }
  }, [subdomain]);

  React.useEffect(() => {
    void load();
  }, [load]);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await apiGet(buildTenantApiPath(subdomain, '/billing/refunds'), {
          schema: UserRefundsResponseSchema,
        });
        if (!cancelled) {
          setRefundPending(result.requests.some((item) => item.status === 'requested'));
        }
      } catch (err) {
        // Refund state is advisory here; never block Purchase on it.
        reportError(err, { source: 'purchase-refund-flag' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subdomain]);

  /**
   * Returning to Purchase must re-read payments: a pending payment
   * decided (approved or rejected) while the user is elsewhere must
   * not leave a stale disabled checkout behind.
   */
  React.useEffect(() => {
    void load();
  }, [load]);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await apiGet(buildTenantApiPath(subdomain, '/billing/refunds'), {
          schema: UserRefundsResponseSchema,
        });
        if (!cancelled) {
          setRefundPending(result.requests.some((item) => item.status === 'requested'));
        }
      } catch (err) {
        // Refund state is advisory here; never block Purchase on it.
        reportError(err, { source: 'purchase-refund-flag' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subdomain]);

  async function handleRetry() {
    setReloading(true);
    try {
      await sharedEntitlement.refetch();
      await load();
    } finally {
      setReloading(false);
    }
  }

  const entitlement = sharedEntitlement.entitlement;
  // Prefill (separate-sections build): an expired plan renews from
  // its most recent approved payment's counts, and a rejected order
  // prefills the builder from that order, with its reason shown.
  // Runs once per loaded payments list, only while counts are
  // still untouched (null) and there is no live period.
  const prefillDoneRef = React.useRef(false);
  React.useEffect(() => {
    if (prefillDoneRef.current || !status || !entitlement || entitlement.active) return;
    const sorted = [...status.payments].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const rejected = sorted.find((payment) => payment.status === 'rejected');
    if (rejected) {
      prefillDoneRef.current = true;
      setCounts(rejected.counts);
      setPrefillNote(
        `Your last payment was rejected${rejected.rejectionReason ? `: ${rejected.rejectionReason}` : ''}. ` +
          'Your counts below are from that order — change them, or continue with the same plan.'
      );
      return;
    }
    const approved = sorted.find(
      (payment) => payment.status === 'approved' || payment.status === 'paid'
    );
    if (approved) {
      prefillDoneRef.current = true;
      setCounts(approved.counts);
      setPrefillNote(
        'Your previous monthly plan was ' +
          countsSummary(approved.counts) +
          '. Change it, or continue with the same plan.'
      );
    }
  }, [status, entitlement]);
  /**
   * One pending payment per user: while one exists, Purchase shows it
   * and hides the builder instead of offering a fresh one.
   * Page 1 of payments is newest-first, and nothing newer than a
   * pending payment can be created once the server block is live, so
   * the first pending row is the one in flight.
   */
  const pendingPayment = status?.payments.find((payment) => payment.status === 'pending') ?? null;
  const effectiveCounts = counts ?? entitlement?.counts ?? ZERO_PLATFORM_COUNTS;
  const total = totalPricePkr(effectiveCounts);
  const units = totalUnits(effectiveCounts);
  const isPaid = Boolean(entitlement?.active);
  const countsChanged =
    entitlement !== null &&
    SUBSCRIPTION_PLATFORMS.some((p) => effectiveCounts[p] !== entitlement.counts[p]);
  const countsUnchanged = entitlement !== null && !countsChanged;

  let quoteError: string | null = null;
  let amountToPay = total;
  let quote: UpgradeQuote | null = null;
  let downgradeQuote: DowngradeQuote | null = null;
  if (entitlement?.periodEndsAt && countsChanged) {
    const daysLeft = daysRemainingBetween(new Date(), new Date(entitlement.periodEndsAt));
    try {
      quote = quoteUpgrade(entitlement.counts, effectiveCounts, daysLeft);
      amountToPay = quote.amountToPayPkr;
    } catch {
      // Not an upgrade: try the downgrade path (owner decision
      // 2026-11-02, period-end only, prepaid, no credit). A
      // platform increase fails here too, and stays an error.
      try {
        downgradeQuote = quoteDowngrade(entitlement.counts, effectiveCounts);
        amountToPay = downgradeQuote.amountToPayPkr;
      } catch (err) {
        quoteError = err instanceof Error ? err.message : 'That change is not available.';
      }
    }
  }
  const isUpgrade = Boolean(quote && entitlement?.periodEndsAt);
  const isDowngrade = Boolean(downgradeQuote && entitlement?.periodEndsAt);

  function setCount(platform: keyof PlatformCounts, value: number) {
    const next = { ...effectiveCounts, [platform]: Math.max(0, Math.floor(value) || 0) };
    setCounts(next);
    // Coupon revalidation (separate-sections build): a preview is
    // priced for the counts at apply time, so changing a count
    // drops the preview rather than showing an amount the payment
    // row will contradict. The user applies again to reprice.
    setAppliedCoupon(null);
  }

  /**
   * Chooser input editing: valid whole numbers commit immediately so
   * row prices and totals update live as the user types; a blank
   * field commits 0 so the total never breaks mid-edit. Anything
   * else (letters, decimals, negatives) leaves the committed count
   * alone — the field holds the raw text until blur, which drops the
   * draft and shows the last valid count again. No toasts, no
   * dialogs: the revert is silent at the input level.
   */
  function handleCountInput(platform: keyof PlatformCounts, raw: string) {
    setCountDrafts((prev) => ({ ...prev, [platform]: raw }));
    if (raw === '') {
      setCount(platform, 0);
    } else if (/^\d+$/.test(raw)) {
      setCount(platform, Number(raw));
    }
  }

  function handleCountBlur(platform: keyof PlatformCounts) {
    setCountDrafts((prev) => {
      const next = { ...prev };
      delete next[platform];
      return next;
    });
  }

  /**
   * Stepper buttons: step by 1 from the last valid (committed) count and
   * drop any in-progress draft, so the field always shows the stepped
   * value. setCount clamps at 0, so minus can never go below 0 — and the
   * minus button is disabled at 0. Coupon clearing rides along with
   * setCount, exactly as typing does.
   */
  function handleCountStep(platform: keyof PlatformCounts, delta: 1 | -1) {
    setCountDrafts((prev) => {
      const next = { ...prev };
      delete next[platform];
      return next;
    });
    setCount(platform, effectiveCounts[platform] + delta);
  }

  // In-page navigation between the separate sections is by route,
  // never by ?view= (deleted 2026-11-02). Purchase steps are
  // sub-routes: builder /purchase, checkout /purchase/checkout,
  // confirmation /purchase/confirmation?payment=<id>.
  function tenantPath(path: string): string {
    return `/tenant/${subdomain}${path}`;
  }
  function goToMyPlan() {
    router.push(tenantPath('/my-plan'));
  }
  function goToPurchaseStep(target: PurchaseStep) {
    if (target === 'builder') router.push(tenantPath('/purchase'));
    else if (target === 'checkout') router.push(tenantPath('/purchase/checkout'));
    window.scrollTo({ top: 0 });
  }

  function goToBuilder() {
    goToPurchaseStep('builder');
  }

  function goToCheckout() {
    setFormError(null);
    try {
      sessionStorage.setItem(
        DRAFT_KEY,
        JSON.stringify({
          counts: effectiveCounts,
          bankMethod,
        })
      );
    } catch (err) {
      // Session storage unavailable: checkout still works from
      // the counts the user just chose if the tab stays alive.
      reportError(err, { source: 'purchase-draft-save' });
    }
    // A coupon preview is priced for the counts at apply time;
    // re-entering checkout always starts without one, so a stale
    // discount can never ride along with changed counts.
    setAppliedCoupon(null);
    setBankSubmitFailed(false);
    // Fresh checkout visit, fresh submission key: retries within
    // the visit reuse it, a later visit never replays this one.
    submissionKeyRef.current = crypto.randomUUID();
    goToPurchaseStep('checkout');
  }

  async function copyText(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch {
      setCopied(null);
    }
  }

  function mapUploadError(error: unknown): string {
    if (error instanceof ScreenshotUploadError) return error.message;
    if (isApiError(error)) {
      if (error.kind === 'session-expired') return error.message;
      if (error.kind === 'network') {
        return 'The screenshot could not be uploaded. Check your connection and try uploading again.';
      }
      if (error.kind === 'http' && error.status !== undefined && error.status >= 500) {
        return 'The screenshot upload failed. Try uploading again.';
      }
      return error.message;
    }
    return 'The screenshot could not be uploaded. Try uploading again.';
  }

  /**
   * Upload one picked file straight to R2 and report its state.
   * Returns the storage key, or null when the upload failed or was
   * superseded by a newer pick — never throws, so a stale pick
   * cannot surface as an unhandled rejection. The returned promise
   * is what submit awaits when it lands mid-upload.
   */
  function beginScreenshotUpload(file: File): Promise<string | null> {
    const run = ++screenshotUploadRunRef.current;
    setScreenshotUpload({ status: 'uploading' });
    const done = (async (): Promise<string | null> => {
      try {
        const result = await uploadScreenshotFile(subdomain, file);
        if (screenshotUploadRunRef.current !== run) return null;
        setScreenshotUpload({ status: 'uploaded', storageKey: result.storageKey });
        return result.storageKey;
      } catch (error) {
        if (screenshotUploadRunRef.current !== run) return null;
        setScreenshotUpload({ status: 'failed', error: mapUploadError(error) });
        return null;
      }
    })();
    screenshotUploadPromiseRef.current = done;
    void done.then(() => {
      if (screenshotUploadPromiseRef.current === done) screenshotUploadPromiseRef.current = null;
    });
    return done;
  }

  function handleScreenshotSelect(file: File | null): void {
    // A newer pick abandons the previous upload's state updates;
    // bytes already in flight land under an unguessable key that
    // nothing references, never attached to a payment.
    screenshotUploadRunRef.current += 1;
    screenshotUploadPromiseRef.current = null;
    setScreenshot(file);
    if (!file) {
      setScreenshotUpload({ status: 'idle' });
      return;
    }
    if (
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) ||
      file.size > 10 * 1024 * 1024
    ) {
      setScreenshotUpload({
        status: 'failed',
        error: 'The screenshot must be a PNG, JPG, WebP, or GIF image under 10 MB.',
      });
      return;
    }
    void beginScreenshotUpload(file);
  }

  function retryScreenshotUpload(): void {
    if (screenshot) void beginScreenshotUpload(screenshot);
  }

  function clearScreenshot(): void {
    screenshotUploadRunRef.current += 1;
    screenshotUploadPromiseRef.current = null;
    setScreenshot(null);
    setScreenshotUpload({ status: 'idle' });
    if (screenshotInputRef.current) screenshotInputRef.current.value = '';
  }

  /** Fallback for a truly unknown submit error — logged, never silent. */
  const UNKNOWN_SUBMIT_MESSAGE =
    'Something went wrong while saving your payment. Your screenshot is still attached — try again.';

  function mapSubmitError(error: unknown): string {
    if (isApiError(error)) {
      if (error.kind === 'session-expired') return error.message;
      if (error.kind === 'network') {
        return 'Connection problem. Your screenshot is still attached — try again.';
      }
      if (error.kind === 'aborted') {
        return 'The request timed out. Your screenshot is still attached — try again.';
      }
      if (error.kind === 'http') {
        if (error.status === 409) return PENDING_CHECKOUT_MESSAGE;
        // Server specifics flow through: validation, coupon, and
        // the payment route's own save-failed message.
        return error.message;
      }
      // Only 'parse' remains after the kinds above are excluded.
      return 'The server returned an unexpected response. Your screenshot is still attached — try again.';
    }
    return UNKNOWN_SUBMIT_MESSAGE;
  }

  function isTransientSubmitError(error: unknown): boolean {
    if (!isApiError(error)) return false;
    if (error.kind === 'network' || error.kind === 'aborted') return true;
    return error.kind === 'http' && error.status !== undefined && error.status >= 500;
  }

  /**
   * One payment POST attempt set: a single automatic retry on a
   * transient failure, with the SAME submission key and the SAME
   * uploaded screenshot key — so a retry replays or 409s, never
   * double-creates, and never re-uploads.
   */
  async function postBankPayment(submissionKey: string, storageKey: string) {
    const body = {
      counts: effectiveCounts,
      bankMethod,
      screenshotStorageKey: storageKey,
      ...(appliedCoupon ? { couponCode: appliedCoupon.code } : {}),
    };
    const signal = timeoutSignal(60_000);
    const options = {
      schema: BillingPaymentItemSchema,
      headers: { 'Idempotency-Key': submissionKey },
      ...(signal ? { signal } : {}),
    };
    try {
      return await apiPost(buildTenantApiPath(subdomain, '/billing/payments'), body, options);
    } catch (error) {
      if (!isTransientSubmitError(error)) throw error;
      const retrySignal = timeoutSignal(60_000);
      return await apiPost(buildTenantApiPath(subdomain, '/billing/payments'), body, {
        ...options,
        ...(retrySignal ? { signal: retrySignal } : {}),
      });
    }
  }

  async function submitBank() {
    // Handler-level double-submit guard: the button's disabled prop
    // alone cannot stop two taps landing before React re-renders
    // (the old handler had no guard at all, so a fast double-tap
    // fired two submissions and the loser 409'd or orphaned an
    // upload). The ref closes that gap; the button stays disabled
    // too, as the visible state.
    if (submitBusyRef.current) return;
    if (pendingPayment) {
      setFormError(PENDING_CHECKOUT_MESSAGE);
      return;
    }
    if (units === 0) {
      setFormError('Choose at least one page or account.');
      return;
    }
    if (quoteError) {
      setFormError(plainQuoteError(quoteError));
      return;
    }
    if (!screenshot) {
      setFormError('Add a screenshot of your payment so we can approve it.');
      return;
    }
    // Owner screenshot rule (2026-11-02): submit NEVER waits out
    // an upload and NEVER fires without a verified key. The button
    // is disabled while uploading, and this handler rejects
    // immediately if it is reached in any other state than
    // uploaded — the old await-upload backstop is deleted.
    submitBusyRef.current = true;
    setBusy('bank');
    setFormError(null);
    setBankSubmitFailed(false);
    try {
      if (screenshotUpload.status !== 'uploaded') {
        setFormError(
          screenshotUpload.status === 'failed'
            ? 'Screenshot missing, re-upload: your screenshot could not be uploaded. Pick it again, wait for the verified tick, then submit.'
            : 'Screenshot missing, re-upload: wait for your screenshot to finish uploading and show the verified tick, then submit.'
        );
        return;
      }
      const storageKey = screenshotUpload.storageKey;
      const submissionKey = submissionKeyRef.current ?? crypto.randomUUID();
      submissionKeyRef.current = submissionKey;
      const createdPayment = await postBankPayment(submissionKey, storageKey);
      // Order matters (checkout flicker fix): the checkout step renders
      // the screenshot-upload CTA whenever `screenshot` is null, so
      // clearing it BEFORE the refetch + navigation made the UI flash
      // back to "add screenshot" for the whole slow load() before
      // confirmation appeared. The reset now runs AFTER navigation, in
      // the same synchronous block as the confirmation state, so React
      // batches them into a single render: processing persists until
      // confirmation renders, with no intermediate upload state. The
      // same ordering also keeps the screenshot attached if the POST
      // or the refetch fails, so a retry needs no re-upload.
      await load();
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch (err) {
        // Draft cleanup is best-effort; a stale draft only
        // pre-fills the next builder.
        reportError(err, { source: 'purchase-draft-cleanup' });
      }
      clearScreenshot();
      submissionKeyRef.current = null;
      router.push(`/tenant/${subdomain}/purchase/confirmation?payment=${createdPayment.id}`);
    } catch (err) {
      const message = mapSubmitError(err);
      setFormError(message);
      setBankSubmitFailed(true);
      if (message === UNKNOWN_SUBMIT_MESSAGE) {
        reportError(err, { source: 'billing-submit' });
      }
      // A 409 means a payment IS pending (created by the attempt
      // itself, or another tab): refresh so the pending card, not a
      // dead retry button, is what the user sees next.
      if (isApiError(err) && err.kind === 'http' && err.status === 409) {
        void load();
      }
    } finally {
      submitBusyRef.current = false;
      setBusy(null);
    }
  }

  async function submitZeroDue() {
    if (units === 0) {
      setFormError('Choose at least one page or account.');
      return;
    }
    if (quoteError) {
      setFormError(plainQuoteError(quoteError));
      return;
    }
    if (!appliedCoupon || !appliedCoupon.fullyCovered) {
      setFormError('This coupon does not cover the full amount.');
      return;
    }
    setActivatingZeroDue(true);
    setFormError(null);
    try {
      await apiPost(
        buildTenantApiPath(subdomain, '/billing/payments/zero-due'),
        { counts: effectiveCounts, couponCode: appliedCoupon.code },
        { schema: ZeroDueCheckoutResponseSchema }
      );
      await load();
      // A zero-due activation IS the purchase: the period starts at
      // once, with no admin step. Refresh the shared entitlement
      // here — it is the one explicit re-check after a purchase, so
      // My Plan and the sections the user opens next read Paid, not
      // the Free value seeded at login.
      await sharedEntitlement.refetch();
      setAppliedCoupon(null);
      try {
        sessionStorage.removeItem(DRAFT_KEY);
      } catch (err) {
        // Draft cleanup is best-effort; a stale draft only
        // pre-fills the next builder.
        reportError(err, { source: 'purchase-draft-cleanup' });
      }
      router.push(`/tenant/${subdomain}/my-plan`);
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setActivatingZeroDue(false);
    }
  }

  if (loadError && !status) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-xl leading-heading font-semibold text-ink">Billing</h1>
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load billing</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <div>
          <Button onClick={() => void handleRetry()} loading={reloading}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  // Unproven plan check (first fetch failed, or a refetch newer than
  // the last success): never render a Free card from missing data —
  // show the same retryable error instead of the skeleton, so a
  // failed check cannot sit behind an endless loader either.
  if (sharedEntitlement.isUnproven) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-xl leading-heading font-semibold text-ink">Billing</h1>
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load billing</AlertTitle>
          <AlertDescription>
            Your plan could not be checked right now. Please try again.
          </AlertDescription>
        </Alert>
        <div>
          <Button onClick={() => void handleRetry()} loading={reloading}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!status || !entitlement) {
    return <BillingSkeleton />;
  }

  const details = BANK_PAYMENT_DETAILS[bankMethod];
  // A fully-covering coupon disables both payment submits: there is
  // nothing to pay, and activation happens from the coupon section.
  // A pending payment also disables checkout (#79 one-pending block).
  const fullyCovered = Boolean(appliedCoupon?.fullyCovered);
  const checkoutDisabled =
    busy !== null ||
    units === 0 ||
    Boolean(quoteError) ||
    pendingPayment !== null ||
    fullyCovered;
  const bankDisabled = checkoutDisabled || !screenshot || screenshotUpload.status !== 'uploaded';
  const bankDisabledReason = fullyCovered
    ? 'Your coupon covers the full amount — activate your plan above, no payment needed.'
    : units === 0
      ? 'Choose at least one page or account first.'
      : plainQuoteError(quoteError) ??
        (!screenshot
          ? 'Add a screenshot of your payment so we can approve it.'
          : screenshotUpload.status === 'uploading'
            ? 'Uploading your screenshot — submit unlocks when it finishes.'
            : screenshotUpload.status === 'failed'
              ? 'Your screenshot couldn\'t be uploaded. Retry the upload to submit.'
              : null);

  // Stacked rows (mockup E as shown): one divided row per platform, full
  // width of the left column. Each row names the platform, asks a plain
  // professional question, and takes a stepper at the right end — minus
  // button, typed number, plus button — like the mockup shows. The number
  // stays typeable (type="text" with a numeric keyboard carries no native
  // spinners), and there is no per-row price (prices live only in the
  // sidebar). Included/in-use counts belong to My Plan and are
  // deliberately NOT shown here.
  const configurator = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col divide-y divide-line">
        {PURCHASABLE_PLATFORMS.map((platform) => {
          const count = effectiveCounts[platform];
          return (
            <div
              key={platform}
              className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium text-ink">
                  {PLATFORM_LABELS[platform]} —{' '}
                  {platform === 'facebook' ? 'Pages' : 'Accounts'}
                </p>
                <p className="text-body text-ink">
                  {platform === 'facebook'
                    ? 'How many Facebook Pages will you post to?'
                    : platform === 'instagram'
                      ? 'How many Instagram accounts will you post from?'
                      : 'How many Threads accounts will you post from?'}
                  {platform === 'facebook' ? (
                    <>
                      {' '}
                      <span className="text-ink-sub">
                        Accounts free — connect as many Facebook accounts as you like. You only
                        pay for Pages.
                      </span>
                    </>
                  ) : null}
                </p>
              </div>
              {/* Stepper, like the mockup ("− 10 +"): minus button, typed
              number, plus button. The number stays typeable — the input
              carries the existing validation rules (blank commits 0,
              letters/decimals/negatives rejected, last valid count
              re-shown on blur) — and the buttons step by 1 from the last
              valid count, never below 0. */}
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`Decrease ${PLATFORM_LABELS[platform]} ${subscriptionUnitLabel(platform)}`}
                  disabled={count === 0}
                  onClick={() => handleCountStep(platform, -1)}
                >
                  <MinusIcon />
                </Button>
                <Input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  aria-label={`${PLATFORM_LABELS[platform]} ${subscriptionUnitLabel(platform)}`}
                  value={countDrafts[platform] ?? String(count)}
                  onChange={(event) => handleCountInput(platform, event.target.value)}
                  onBlur={() => handleCountBlur(platform)}
                  className="w-20 text-center tabular-nums"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={`Increase ${PLATFORM_LABELS[platform]} ${subscriptionUnitLabel(platform)}`}
                  onClick={() => handleCountStep(platform, 1)}
                >
                  <PlusIcon />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-body text-ink-sub">
        You can increase your pages and accounts anytime. Reducing them takes effect from your
        next month.
      </p>
    </div>
  );

  const orderSummary = (
    <Card>
      <CardHeader>
        <CardTitle>Order summary</CardTitle>
        <CardDescription>What you will pay.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="flex flex-col gap-2 text-body">
          {PURCHASABLE_PLATFORMS.filter((p) => effectiveCounts[p] > 0).map((platform) => (
            <div key={platform} className="flex items-baseline justify-between gap-3">
              <dt className="min-w-0 truncate text-ink-sub">
                {PLATFORM_LABELS[platform]} · {effectiveCounts[platform]}{' '}
                {subscriptionUnitLabel(platform)}
              </dt>
              <dd className="shrink-0 font-medium tabular-nums text-ink">
                {effectiveCounts[platform] * SUBSCRIPTION_PRICE_PKR_PER_UNIT} PKR
              </dd>
            </div>
          ))}
          {units === 0 ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-sub">Selected</dt>
              <dd className="font-medium text-ink">Nothing selected yet</dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-sub">Media Library storage included</dt>
            <dd className="shrink-0 font-medium tabular-nums text-ink">{5 * units} GB</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-sub">Monthly total</dt>
            <dd className="font-semibold tabular-nums text-ink">{total} PKR</dd>
          </div>
          {isDowngrade && downgradeQuote ? (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">Current monthly plan</dt>
                <dd className="font-medium tabular-nums text-ink">{downgradeQuote.oldMonthlyTotalPkr} PKR</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">New monthly plan</dt>
                <dd className="font-medium tabular-nums text-ink">{downgradeQuote.newMonthlyTotalPkr} PKR</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
                <dt className="font-medium text-ink">You pay now</dt>
                <dd className="font-semibold tabular-nums text-ink">{downgradeQuote.amountToPayPkr} PKR</dd>
              </div>
            </>
          ) : isUpgrade && quote ? (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">Current plan</dt>
                <dd className="font-medium tabular-nums text-ink">{quote.oldMonthlyTotalPkr} PKR</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">Days left on your current plan</dt>
                <dd className="font-medium tabular-nums text-ink">{quote.daysRemaining} days</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">Credit for unused days</dt>
                <dd className="font-medium tabular-nums text-ink">−{quote.creditPkr} PKR</dd>
              </div>
              {appliedCoupon ? (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-sub">Coupon {appliedCoupon.code}</dt>
                  <dd className="font-medium tabular-nums text-ink">
                    −{appliedCoupon.discountPkr} PKR
                  </dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
                <dt className="font-medium text-ink">You pay now</dt>
                <dd className="font-semibold tabular-nums text-ink">
                  {appliedCoupon ? appliedCoupon.amountAfterDiscountPkr : amountToPay} PKR
                </dd>
              </div>
            </>
          ) : (
            <>
              {appliedCoupon ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-ink-sub">Coupon {appliedCoupon.code}</dt>
                    <dd className="font-medium tabular-nums text-ink">
                      −{appliedCoupon.discountPkr} PKR
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
                    <dt className="font-medium text-ink">You pay now</dt>
                    <dd className="font-semibold tabular-nums text-ink">
                      {appliedCoupon.amountAfterDiscountPkr} PKR
                    </dd>
                  </div>
                </>
              ) : null}
              <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
                <dt className="text-lg font-medium text-ink">You pay</dt>
                <dd className="text-lg font-semibold tabular-nums text-ink">{total} PKR / month</dd>
              </div>
            </>
          )}
        </dl>
        <p className="text-body text-ink-sub">
          {isUpgrade
            ? 'Your new month starts when your upgrade is approved.'
            : 'Your month runs for 30 days from approval. If you do not renew, posting pauses and you can only view your account until you renew.'}
        </p>
      </CardContent>
    </Card>
  );


  /**
   * Pending payment card for Purchase only: while one payment is in
   * flight, Purchase shows it and hides the builder instead of
   * offering a fresh one. "Check again" re-reads payments so a
   * decision made while this view is open unblocks the form.
   */
  const pendingPaymentCard = pendingPayment ? (
    <Card>
      <CardHeader>
        <CardTitle>Payment in progress</CardTitle>
        <CardDescription>
          You already have a payment waiting. Wait for it to be decided before submitting another.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <BillingStatusMark kind="pending" label="Waiting for approval" />
        <p className="text-body text-ink">
          {pendingPayment.amountPkr} PKR · {paymentMethodLabel(pendingPayment)}
          {pendingPayment.isUpgrade ? ' · Upgrade' : ''} · Submitted{' '}
          {formatDateTime(pendingPayment.createdAt)}
        </p>
        <div>
          <Button variant="outline" onClick={() => void load()}>
            Check again
          </Button>
        </div>
      </CardContent>
    </Card>
  ) : null;

  /* ---------- Confirmation step (inside Purchase) ---------- */
  /* ---------- Confirmation step (server-backed) ---------- */
  if (step === 'confirmation') {
    return (
      <PurchaseConfirmationView
        subdomain={subdomain}
        paymentId={confirmationPaymentId ?? null}
      />
    );
  }

  /* ---------- Checkout step (inside Purchase) ---------- */
  if (step === 'checkout') {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-1">
          <Button variant="outline" size="sm" className="self-start" onClick={goToBuilder}>
            <ArrowLeftIcon aria-hidden className="size-4" /> Back to build plan
          </Button>
          <h1 className="text-xl leading-heading font-semibold text-ink">Checkout</h1>
          <p className="text-body text-ink-sub">
            {isUpgrade ? 'Upgrade · ' : ''}
            {isDowngrade ? 'Lower monthly plan for next month · ' : ''}
            {countsSummary(purchasableCounts(effectiveCounts))} ·{' '}
            {appliedCoupon ? appliedCoupon.amountAfterDiscountPkr : amountToPay} PKR
            {isUpgrade ? ' to pay now' : ' / month'}
            {appliedCoupon
              ? ` · Coupon ${appliedCoupon.code} (−${appliedCoupon.discountPkr} PKR)`
              : ''}
          </p>
        </div>
        <PurchaseStepIndicator current="checkout" />
        {pendingPaymentCard}
        {/* The posting-paused warning belongs to My Plan only, so it is
            deliberately not repeated here. */}
        {quoteError ? (
          <Alert variant="destructive">
            <AlertTitle>Check your plan change</AlertTitle>
            <AlertDescription>{plainQuoteError(quoteError)}</AlertDescription>
          </Alert>
        ) : null}
        {refundPending && (isUpgrade || isDowngrade) ? (
          <Alert variant="destructive">
            <AlertTitle>Upgrading will cancel your pending refund request</AlertTitle>
            <AlertDescription>
              You have a refund request waiting for a decision. Changing your plan now cancels
              that request — the upgrade credit already covers the unused value of your old plan.
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-col items-start gap-6 lg:flex-row">
          <div className="order-2 flex min-w-0 flex-1 flex-col gap-6 lg:order-1">
            <Card>
              <CardHeader>
                <div className="flex items-baseline justify-between gap-3">
                  <CardTitle>Choose how to pay</CardTitle>
                  <span className="shrink-0 text-metadata text-ink-sub">Manual payments only.</span>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-6">
                <section aria-label="Pay via" className="flex flex-col gap-2">
                  <p className="text-body font-medium text-ink">Step 1 — Pay via</p>
                  <div role="radiogroup" aria-label="Payment method" className="flex flex-col gap-2">
                    {(['easypaisa', 'nayapay', 'ubl', 'binance'] as const).map((method) => (
                      <button
                        key={method}
                        type="button"
                        role="radio"
                        aria-checked={bankMethod === method}
                        aria-label={`Pay via ${PAY_VIA_LABELS[method]}`}
                        onClick={() => setBankMethod(method)}
                        className={cn(
                          'flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link',
                          bankMethod === method
                            ? 'border-ink bg-subtle'
                            : 'border-line bg-panel hover:bg-hover'
                        )}
                      >
                        <span className="text-body font-medium text-ink">{PAY_VIA_LABELS[method]}</span>
                        {bankMethod === method ? (
                          <span
                            aria-hidden
                            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-signal-operational text-primary"
                          >
                            <CheckIcon className="size-3.5" />
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </section>
                <section aria-label="Pay to this account" className="flex flex-col gap-2">
                  <p className="text-body font-medium text-ink">Step 2 — Pay to this account</p>
                  <div className="flex flex-col gap-2 rounded-md border border-line bg-panel px-3 py-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-metadata text-ink-sub">Account details</span>
                      <span className="text-body font-medium text-ink">{PAY_VIA_LABELS[bankMethod]}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-metadata text-ink-sub">
                        {bankMethod === 'binance' ? 'Binance username' : 'Account name'}
                      </span>
                      <span className="text-body font-medium text-ink">
                        {bankMethod === 'binance' ? 'shahzebpyc' : 'Shahzeb Malik'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-metadata text-ink-sub">
                        {details.accountNumberLabel ?? 'Account number'}
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-body text-ink">{details.accountNumber}</span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void copyText(details.accountNumber, `account-${bankMethod}`)}
                        >
                          {copied === `account-${bankMethod}`
                            ? 'Copied'
                            : details.accountNumberLabel
                              ? `Copy ${details.accountNumberLabel}`
                              : 'Copy number'}
                        </Button>
                      </span>
                    </div>
                    {details.iban ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-metadata text-ink-sub">IBAN</span>
                        <span className="flex flex-wrap items-center justify-end gap-2">
                          <span className="break-all font-mono text-body text-ink">{details.iban}</span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void copyText(details.iban ?? '', `iban-${bankMethod}`)}
                          >
                            {copied === `iban-${bankMethod}` ? 'Copied' : 'Copy IBAN'}
                          </Button>
                        </span>
                      </div>
                    ) : null}
                    {details.bank ? (
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-metadata text-ink-sub">Bank</span>
                        <span className="text-body font-medium text-ink">{details.bank} bank</span>
                      </div>
                    ) : null}
                    <p className="text-metadata text-ink-sub">
                      Please pay to this {PAY_VIA_LABELS[bankMethod]} account, then add your payment
                      screenshot in step 3.
                    </p>
                  </div>
                </section>
                <section aria-label="Upload your payment screenshot" className="flex flex-col gap-2">
                  <p className="text-body font-medium text-ink">Step 3 — Upload your payment screenshot</p>
                    <div className="flex flex-col gap-2">
                      <input
                        ref={screenshotInputRef}
                        id="billing-screenshot"
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        className="sr-only"
                        onChange={(event) => handleScreenshotSelect(event.target.files?.[0] ?? null)}
                      />
                      {screenshot ? (
                        <div className="flex flex-col gap-2">
                          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-panel px-4 py-3">
                            <span className="flex min-w-0 items-center gap-2 text-body text-ink">
                              {screenshotUpload.status === 'uploading' ? (
                                <Loader2Icon
                                  aria-hidden
                                  className="size-4 shrink-0 animate-spin text-ink-sub"
                                />
                              ) : screenshotUpload.status === 'uploaded' ? (
                                <BillingStatusMark kind="ok" label="Uploaded" />
                              ) : (
                                <UploadIcon aria-hidden className="size-4 shrink-0 text-ink-sub" />
                              )}
                              <span className="truncate">{screenshot.name}</span>
                              {screenshotUpload.status === 'uploading' ? (
                                <span className="shrink-0 text-body text-ink-sub">
                                  Uploading screenshot…
                                </span>
                              ) : null}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy !== null}
                              onClick={clearScreenshot}
                            >
                              <XIcon aria-hidden className="size-4" /> Remove
                            </Button>
                          </div>
                          {screenshotPreviewUrl ? (
                            <Image
                              src={screenshotPreviewUrl}
                              alt="Screenshot preview"
                              width={640}
                              height={853}
                              unoptimized
                              className="h-auto w-full max-w-xs rounded-md border border-line"
                            />
                          ) : null}
                          <p className="text-metadata text-ink-sub">
                            {screenshot.size
                              ? `${screenshot.name} · ${(screenshot.size / 1024).toFixed(0)} KB`
                              : screenshot.name}
                          </p>
                          {screenshotUpload.status === 'failed' ? (
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <p className="text-body text-ink-sub">{screenshotUpload.error}</p>
                              <Button variant="outline" size="sm" onClick={retryScreenshotUpload}>
                                Retry upload
                              </Button>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => screenshotInputRef.current?.click()}
                          className="flex items-center gap-3 rounded-md border border-dashed border-line bg-panel px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <UploadIcon aria-hidden className="size-5 shrink-0 text-ink-sub" />
                          <span className="flex min-w-0 flex-col">
                            <span className="text-body font-medium text-ink">
                              Upload your payment screenshot
                            </span>
                            <span className="text-metadata text-ink-sub">
                              PNG, JPG, WebP or GIF, up to 10 MB
                            </span>
                          </span>
                        </button>
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <Button
                        variant={bankDisabled ? 'secondary' : 'default'}
                        onClick={() => void submitBank()}
                        loading={busy === 'bank'}
                        disabled={bankDisabled}
                      >
                        Submit payment for approval
                      </Button>
                      {bankDisabledReason ? (
                        <p className="text-body text-ink-sub">{bankDisabledReason}</p>
                      ) : null}
                      <p className="text-body text-ink-sub">Your plan runs for 30 days after approval.</p>
                    </div>
                </section>

                {formError ? (
                  <Alert variant="destructive">
                    <AlertTitle>Couldn&apos;t complete that</AlertTitle>
                    <AlertDescription>{formError}</AlertDescription>
                    {formError.includes('Screenshot missing') ? (
                      <div className="mt-3 flex flex-col gap-2">
                        <div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setFormError(null);
                              screenshotInputRef.current?.click();
                            }}
                          >
                            Re-upload screenshot
                          </Button>
                        </div>
                        <p className="text-body text-ink-sub">
                          Your order details are kept — only the screenshot needs picking again.
                        </p>
                      </div>
                    ) : null}
                    {bankSubmitFailed && screenshotUpload.status === 'uploaded' ? (
                      <div className="mt-3">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void submitBank()}
                          loading={busy === 'bank'}
                          disabled={bankDisabled}
                        >
                          Try again
                        </Button>
                      </div>
                    ) : null}
                  </Alert>
                ) : null}
              </CardContent>
            </Card>
          </div>
          <div className="flex w-full shrink-0 flex-col gap-6 lg:sticky lg:top-20 lg:w-90 lg:self-start">
            <CouponSection
              subdomain={subdomain}
              counts={effectiveCounts}
              applied={appliedCoupon}
              onAppliedChange={setAppliedCoupon}
              onActivateZeroDue={() => void submitZeroDue()}
              activating={activatingZeroDue}
              disabled={busy !== null || activatingZeroDue}
            />
            {orderSummary}
          </div>
        </div>
      </div>
    );
  }

  /* ---------- Purchase: builder step ---------- */
  if (step === 'builder') {
    /**
     * While a payment is pending, the builder is hidden entirely:
     * the draft builder (priced on current usage) sitting next to a
     * different pending order read as if the purchase had not
     * registered. Only the pending card, the pending message, and
     * the note that a new plan can be built once it is decided.
     */
    if (pendingPayment !== null) {
      return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-2">
            <Button variant="outline" size="sm" className="self-start" onClick={goToMyPlan}>
              <ArrowLeftIcon aria-hidden className="size-4" /> Back to My Plan
            </Button>
            <h1 className="text-xl leading-heading font-semibold text-ink">Purchase</h1>
          </div>
          <PurchaseStepIndicator current="builder" />
          {pendingPaymentCard}
          <p className="text-body text-ink-sub">{PENDING_CHECKOUT_MESSAGE}</p>
          <p className="text-body text-ink-sub">
            You can build a new plan once this payment is decided.
          </p>
        </div>
      );
    }
    const buildDisabled =
      busy !== null ||
      units === 0 ||
      Boolean(quoteError) ||
      (isPaid && countsUnchanged);
    const buildDisabledReason =
      units === 0
        ? 'Choose at least one page or account first.'
        : isPaid && countsUnchanged
          ? 'This is the same as your current plan. Increase a count to upgrade, or choose fewer to schedule a downgrade for next month.'
          : null;
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-2">
          <Button variant="outline" size="sm" className="self-start" onClick={goToMyPlan}>
            <ArrowLeftIcon aria-hidden className="size-4" /> Back to My Plan
          </Button>
          <h1 className="text-xl leading-heading font-semibold text-ink">Purchase</h1>
        </div>
        <PurchaseStepIndicator current="builder" />
        {pendingPaymentCard}
        {prefillNote ? (
          <Alert>
            <AlertTitle>Starting from your last plan</AlertTitle>
            <AlertDescription>{prefillNote}</AlertDescription>
          </Alert>
        ) : null}
        {entitlement && (entitlement.counts.x > 0 || entitlement.counts.tiktok > 0 || entitlement.counts.youtube > 0) ? (
          <p className="text-body text-ink-sub">
            Carried from your previous monthly plan:{' '}
            {(['x', 'tiktok', 'youtube'] as const)
              .filter((platform) => entitlement.counts[platform] > 0)
              .map(
                (platform) =>
                  `${entitlement.counts[platform]} ${PLATFORM_LABELS[platform]} ${subscriptionUnitLabel(platform)} (${entitlement.counts[platform] * SUBSCRIPTION_PRICE_PKR_PER_UNIT} PKR / month)`
              )
              .join(', ')}{' '}
            — these cannot be changed here, and they are included in your total.
          </p>
        ) : null}
        {quoteError ? (
          <Alert variant="destructive">
            <AlertTitle>Check your plan change</AlertTitle>
            <AlertDescription>{plainQuoteError(quoteError)}</AlertDescription>
          </Alert>
        ) : null}
        {refundPending && (isUpgrade || isDowngrade) ? (
          <Alert variant="destructive">
            <AlertTitle>Upgrading will cancel your pending refund request</AlertTitle>
            <AlertDescription>
              You have a refund request waiting for a decision. Changing your plan now cancels
              that request — the upgrade credit already covers the unused value of your old plan.
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_360px]">
          <div className="flex min-w-0 flex-col gap-8">
            <Card>
              <CardHeader>
                <div className="flex flex-col gap-1">
                  <CardTitle>Choose your pages and accounts</CardTitle>
                  <CardDescription>
                    70 PKR per page or account, paid monthly. Facebook accounts are free —
                    you can connect as many accounts as you like, you only pay for connected
                    pages.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>{configurator}</CardContent>
            </Card>
          </div>
          <div className="flex w-full shrink-0 flex-col gap-6 lg:sticky lg:top-20 lg:w-90 lg:self-start">
            <Card>
              <CardHeader>
                <CardTitle>YOUR PLAN</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <dl className="flex flex-col gap-2 text-body">
                  {PURCHASABLE_PLATFORMS.filter((p) => effectiveCounts[p] > 0).map(
                    (platform) => {
                      const unitTitle =
                        subscriptionUnitLabel(platform) === 'pages' ? 'Pages' : 'Accounts';
                      return (
                        <div
                          key={platform}
                          className="flex items-baseline justify-between gap-3"
                        >
                          <dt className="min-w-0 truncate text-ink-sub">
                            {PLATFORM_LABELS[platform]} · {unitTitle} ×{' '}
                            {effectiveCounts[platform]}
                          </dt>
                          <dd className="shrink-0 font-medium tabular-nums text-ink">
                            {effectiveCounts[platform] * SUBSCRIPTION_PRICE_PKR_PER_UNIT} PKR
                          </dd>
                        </div>
                      );
                    },
                  )}
                  {units === 0 ? (
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-ink-sub">Selected</dt>
                      <dd className="font-medium text-ink">Nothing selected yet</dd>
                    </div>
                  ) : null}
                  <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
                    <dt className="font-semibold text-ink">Monthly total</dt>
                    <dd className="font-semibold tabular-nums text-ink">{total} PKR</dd>
                  </div>
                </dl>
                <div className="flex flex-col gap-2 border-t border-line pt-3">
                  <p className="text-body font-medium text-ink">
                    Included for free with paid plan
                  </p>
                  <ul className="flex flex-col gap-2">
                    {BUILDER_INCLUDED_FREE.map((item) => (
                      <li
                        key={item}
                        className="flex items-start gap-2 text-body text-ink"
                      >
                        <CheckIcon
                          aria-hidden
                          className="mt-0.5 size-5 shrink-0 text-signal-operational"
                        />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="flex flex-col gap-2">
                  <Button
                    variant={buildDisabled ? 'secondary' : 'default'}
                    shape="pill"
                    onClick={goToCheckout}
                    disabled={buildDisabled}
                    className="w-full"
                  >
                    Continue to checkout
                  </Button>
                  {buildDisabledReason ? (
                    <p className="text-body text-ink-sub">{buildDisabledReason}</p>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  // Fallback: an unknown step renders the builder.
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl leading-heading font-semibold text-ink">Purchase</h1>
        <p className="text-body text-ink-sub">70 PKR per page or account, paid monthly.</p>
      </div>
      <div>
        <Button onClick={goToBuilder}>Build your plan</Button>
      </div>
    </div>
  );
}

/**
 * PurchaseConfirmationView — server-backed confirmation, keyed by
 * payment id (separate-sections build). Refreshing this page
 * re-reads the payment from the server, so a closed tab never
 * loses the payment.
 */
function PurchaseConfirmationView({
  subdomain,
  paymentId,
}: Readonly<{ subdomain: string; paymentId: string | null }>) {
  const router = useRouter();
  const [payment, setPayment] = React.useState<BillingPaymentItem | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!paymentId) {
      setLoading(false);
      setError('No payment was selected. Open Payments to find it, or build a new plan in Purchase.');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // Page 1 is newest-first; a just-created payment is there.
        // Fall back to pages 2-3 before calling it missing.
        for (const page of [1, 2, 3]) {
          const result = await apiGet(buildTenantApiPath(subdomain, `/billing?page=${page}`), {
            schema: BillingStatusResponseSchema,
          });
          const found = result.payments.find((item) => item.id === paymentId);
          if (found) {
            if (!cancelled) {
              setPayment(found);
              setLoading(false);
            }
            return;
          }
          if (result.payments.length === 0) break;
        }
        if (!cancelled) {
          setError('That payment could not be found. Check Payments for its status.');
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(getErrorMessage(err));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subdomain, paymentId]);

  if (loading) return <BillingSkeleton />;
  if (error || !payment) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-xl leading-heading font-semibold text-ink">Purchase</h1>
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load that payment</AlertTitle>
          <AlertDescription>{error ?? 'Payment not found.'}</AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => router.push(`/tenant/${subdomain}/payments`)}>View payments</Button>
          <Button variant="outline" onClick={() => router.push(`/tenant/${subdomain}/purchase`)}>
            Back to Purchase
          </Button>
        </div>
      </div>
    );
  }

  const isPaid = payment.status === 'approved' || payment.status === 'paid';
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl leading-heading font-semibold text-ink">Purchase</h1>
        <p className="text-body text-ink-sub">
          {isPaid
            ? 'Your payment was approved. Your monthly plan is active.'
            : 'We have received your payment.'}
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>
            {payment.amountPkr} PKR · {paymentMethodLabel(payment)}
            {payment.isUpgrade ? ' · Upgrade' : ''}
            {payment.isDowngrade ? ' · Downgrade' : ''}
          </CardTitle>
          <CardDescription>
            {countsSummary(payment.counts)}
            {payment.isDowngrade && payment.scheduledStartsAt
              ? ` · Lower plan starts ${formatDate(payment.scheduledStartsAt)}`
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <BillingStatusMark
            kind={isPaid ? 'ok' : payment.status === 'rejected' ? 'failed' : 'pending'}
            label={paymentStatusLabel(payment.status)}
          />
          {!isPaid ? (
            <p className="text-body text-ink-sub">
              Your monthly plan starts when we approve your payment, not when you paid. If
              approval takes a few days, those days are not added to your plan. Your plan runs
              for 30 days from approval.
            </p>
          ) : null}
          {payment.rejectionReason ? (
            <p className="text-body text-ink-sub">
              Rejected: {payment.rejectionReason}
              {payment.rejectionDetail ? ` — ${payment.rejectionDetail}` : ''}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => router.push(`/tenant/${subdomain}/payments`)}>View payments</Button>
            <Button variant="outline" onClick={() => router.push(`/tenant/${subdomain}/my-plan`)}>
              Back to My Plan
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
