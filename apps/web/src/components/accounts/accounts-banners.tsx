'use client';

/**
 * Accounts banners (spec 131 PR-131-1, spec §8.4 decomposition) —
 * extracted from the former accounts route and rebuilt on the
 * shared/ui `Banner` primitive (UI Rule 2/22: account-level states
 * are persistent banners with their own fix action, presented as
 * colour + icon + text). Copy is preserved verbatim (spec §6.3);
 * testids are preserved for the parity suites.
 */
import * as React from 'react';
import Link from 'next/link';

import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';

interface FeedbackBannerProps {
  notice: { type: 'success' | 'error'; message: string };
  onDismiss: () => void;
  /** BL1 fix: optional fix action, e.g. Connect again after a failed save. */
  onConnectAgain?: (() => void) | undefined;
}

export function FeedbackBanner({
  notice,
  onDismiss,
  onConnectAgain,
}: Readonly<FeedbackBannerProps>) {
  return (
    <Banner
      data-testid="oauth-feedback-banner"
      variant={notice.type === 'success' ? 'success' : 'critical'}
      title={notice.message}
      onDismiss={onDismiss}
      action={
        onConnectAgain ? (
          <Button
            type="button"
            variant="link"
            data-testid="oauth-connect-again-btn"
            onClick={onConnectAgain}
            className="font-semibold"
          >
            Connect again
          </Button>
        ) : undefined
      }
      className="mb-6 border border-line"
    />
  );
}

interface ByocRetryBannerProps {
  message: string;
  onRetry: () => void;
}

export function ByocRetryBanner({ message, onRetry }: Readonly<ByocRetryBannerProps>) {
  return (
    <Banner
      data-testid="byoc-retry-banner"
      variant="warning"
      title={message}
      className="mb-6 border border-line"
      action={
        <Button
          type="button"
          variant="link"
          data-testid="byoc-retry-btn"
          onClick={onRetry}
          className="font-semibold"
        >
          Retry Check
        </Button>
      }
    />
  );
}

interface ByocRequiredBannerProps {
  subdomain: string;
}

export function ByocRequiredBanner({ subdomain }: Readonly<ByocRequiredBannerProps>) {
  // Visible feedback the moment the link is clicked (M8) — Next.js client
  // navigation renders immediately and the new page replaces this one, so
  // the "Opening settings…" state is what the user sees during the hop.
  const [isNavigating, setIsNavigating] = React.useState(false);
  return (
    <Banner
      data-testid="byoc-required-banner"
      variant="warning"
      title="Facebook App credentials are required before connecting accounts. Configure your Facebook App ID and Secret in Workspace Settings."
      className="mb-6 border border-line"
      action={
        <Button asChild variant="outline" aria-disabled={isNavigating}>
          <Link
            href={`/tenant/${subdomain}/settings?tab=byoc`}
            data-testid="byoc-configure-link"
            onClick={() => setIsNavigating(true)}
            className={isNavigating ? 'pointer-events-none opacity-60' : undefined}
          >
            {isNavigating ? 'Opening settings…' : 'Configure in Settings'}
          </Link>
        </Button>
      }
    />
  );
}
