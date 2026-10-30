'use client';

/**
 * Instagram accounts banners — Facebook's `accounts-banners.tsx`
 * structure exactly (`ByocRetryBanner`, `ByocRequiredBanner` on the
 * shared/ui `Banner` primitive), with Instagram copy and the Instagram
 * App settings link (`?tab=instagram`, never Facebook's `?tab=byoc`).
 * The dismissible feedback banner is shared as-is from
 * `accounts-banners.tsx` (it carries no platform copy).
 */
import * as React from 'react';
import Link from 'next/link';

import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';

interface InstagramByocRetryBannerProps {
  message: string;
  onRetry: () => void;
}

export function InstagramByocRetryBanner({ message, onRetry }: Readonly<InstagramByocRetryBannerProps>) {
  return (
    <Banner
      data-testid="instagram-byoc-retry-banner"
      variant="warning"
      title={message}
      className="mb-6 border border-line"
      action={
        <Button
          type="button"
          variant="link"
          data-testid="instagram-byoc-retry-btn"
          onClick={onRetry}
          className="font-semibold"
        >
          Retry Check
        </Button>
      }
    />
  );
}

interface InstagramByocRequiredBannerProps {
  subdomain: string;
}

export function InstagramByocRequiredBanner({ subdomain }: Readonly<InstagramByocRequiredBannerProps>) {
  const [isNavigating, setIsNavigating] = React.useState(false);
  return (
    <Banner
      data-testid="instagram-byoc-required-banner"
      variant="warning"
      title="Instagram App credentials are required before connecting accounts. Configure your Instagram App ID and Secret in Workspace Settings."
      className="mb-6 border border-line"
      action={
        <Button asChild variant="outline" aria-disabled={isNavigating}>
          <Link
            href={`/tenant/${subdomain}/settings?tab=instagram`}
            data-testid="instagram-byoc-configure-link"
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
