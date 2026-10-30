import type { Metadata } from 'next';
import React from 'react';
import Link from 'next/link';
import { cookies } from 'next/headers';
import {
  getPlatformAccountsPath,
  getSessionSecret,
} from '@fbuploadpro/contracts';
import { DestinationPicker } from '@/components/connect/destination-picker';
// Side effect: registers the X connect config (spec 127) so its picker mode resolves.
import '@/lib/connect/platforms/x';
// Side effect: registers the Instagram + Threads connect configs (spec 124) so their picker modes resolve.
import '@/lib/connect/platforms/instagram';
import '@/lib/connect/platforms/threads';
import {
  getPlatformConnectConfig,
  isKnownPlatform,
  PLATFORM_LABELS,
} from '@/lib/connect/registry';
import {
  verifyPendingDestinations,
  PENDING_COOKIE_NAME,
} from '@/lib/connect/state';
import {
  connectNoticeMessage,
  type ConnectNoticeCode,
} from '@/lib/connect/errors';
// Registers the YouTube connect config (spec 125) into the framework registry.
import '@/lib/connect/platforms/youtube';
// Registers the TikTok connect config (spec 126) into the framework registry.
import '@/lib/connect/tiktok';

interface ConnectPickerPageProps {
  params: Promise<{ subdomain: string; platform: string }>;
  searchParams: Promise<{ notice?: string }>;
}

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template (§3.3.4). */
export async function generateMetadata({ params }: ConnectPickerPageProps): Promise<Metadata> {
  const { platform } = await params;
  const label = isKnownPlatform(platform) ? PLATFORM_LABELS[platform] : 'account';
  return { title: `Connect ${label}` };
}

type PendingDestinations = Awaited<
  ReturnType<typeof verifyPendingDestinations>
>;

async function readPendingDestinations(
  platform: string,
  subdomain: string
): Promise<PendingDestinations | null> {
  const cookieStore = await cookies();
  const pendingCookie = cookieStore.get(PENDING_COOKIE_NAME)?.value;
  if (!pendingCookie) return null;
  try {
    const parsed = await verifyPendingDestinations(
      pendingCookie,
      getSessionSecret()
    );
    if (parsed.platform === platform && parsed.tenantSubdomain === subdomain) {
      return parsed;
    }
  } catch (err) {
    console.error('[connect/picker] Pending cookie invalid:', err);
  }
  return null;
}

function resolveNoticeCode(
  notice: string | undefined,
  platform: string | null,
  hasPending: boolean
): ConnectNoticeCode | null {
  if (notice) return notice as ConnectNoticeCode;
  if (!platform) return 'connect_failed';
  if (!hasPending) return 'expired_link';
  return null;
}

function pickerHeading(
  noticeCode: ConnectNoticeCode | null,
  mode: 'picker' | 'single-confirm',
  platformName: string
): string {
  if (noticeCode) return `Connect ${platformName}`;
  if (mode === 'single-confirm') return `Add this ${platformName} destination`;
  return 'Choose what to add';
}

function pickerSubheading(
  noticeCode: ConnectNoticeCode | null,
  mode: 'picker' | 'single-confirm',
  platformName: string
): string {
  if (noticeCode) return connectNoticeMessage(noticeCode);
  if (mode === 'single-confirm') {
    return `Check this is the ${platformName} destination you want to post to, then add it.`;
  }
  return `Pick the ${platformName} destinations you want to post to. You can add more later.`;
}

/**
 * Post-connect destination picker page (Spec 123, Part C).
 *
 * The callback route stashes the discovered destinations in a signed
 * cookie; this page reads them back and renders the picker. Denials and
 * failures arrive here as a `notice` code and are shown in plain language.
 */
export default async function ConnectPickerPage({
  params,
  searchParams,
}: Readonly<ConnectPickerPageProps>) {
  const { subdomain, platform: platformParam } = await params;
  const { notice } = await searchParams;
  const platform = isKnownPlatform(platformParam) ? platformParam : null;
  const platformName = platform ? PLATFORM_LABELS[platform] : 'Platform';
  // Per-platform Accounts landing page (facebook keeps `/accounts`).
  const accountsHref = `/tenant/${subdomain}${getPlatformAccountsPath(platform ?? '')}`;

  let pending: PendingDestinations | null = null;
  if (platform && !notice) {
    pending = await readPendingDestinations(platform, subdomain);
  }

  const noticeCode = resolveNoticeCode(notice, platform, Boolean(pending));

  const mode =
    (platform
      ? getPlatformConnectConfig(platform)?.destinationMode
      : undefined) ?? 'picker';

  return (
    <div
      data-testid="connect-picker-page"
      className="mx-auto box-border w-full max-w-180 px-6 py-6"
    >
      <h1 className="mt-0 mb-1 text-xxl font-bold tracking-h1 text-ink">
        {pickerHeading(noticeCode, mode, platformName)}
      </h1>
      <p className="mt-0 mb-6 text-body leading-relaxed text-ink-sub">
        {pickerSubheading(noticeCode, mode, platformName)}
      </p>

      {noticeCode || !pending || !platform ? (
        <div
          data-testid="connect-picker-notice"
          className="rounded-md border border-line bg-panel px-6 py-4"
        >
          <Link
            href={accountsHref}
            data-testid="connect-picker-accounts-link"
            className="inline-flex min-h-11 items-center text-body font-semibold text-primary underline outline-none focus-visible:outline-2 focus-visible:outline-link"
          >
            Go to Accounts
          </Link>
        </div>
      ) : (
        <DestinationPicker
          platform={platform}
          subdomain={subdomain}
          destinations={pending.destinations}
          mode={mode}
        />
      )}
    </div>
  );
}
