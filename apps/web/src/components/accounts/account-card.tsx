'use client';

/**
 * Account card (spec 131 PR-131-1) — rebuilt on the design system:
 * token-backed Tailwind utilities only (zero inline styles), avatars
 * on `next/image` (the file's 2 raw img elements are deleted), and status
 * as icon + text via `AccountHealthMark` below (a thin wrapper over the
 * shared `StatusMark`, no status dot:
 * connected is the tick, expired/error is the cross, expiring-soon is
 * the clock) fed by the single account-health model in `account-health.ts`
 * (logic carried over untouched). Layout, copy, testids, and the
 * hover/disconnect/reconnect behaviours are preserved from the
 * previous implementation (spec §6 parity).
 */
import * as React from 'react';
import Image from 'next/image';
import { useRouter, useParams } from 'next/navigation';
import { ExternalLinkIcon, TriangleAlertIcon } from 'lucide-react';

import { Button } from '@/components/shared/ui/button';
import { StatusMark, type StatusMarkKind } from '@/components/shared/ui/status-mark';
import { getUserInitials } from '@/lib/user-initials';
import { cn } from '@/lib/utils';
import {
  getAccountHealth,
  getAccountHealthLabel,
  getAccountHealthSignal,
  isTokenExpiringSoon,
} from './account-health';

export interface FacebookAccountLinkedPageItem {
  id: string;
  pageName: string;
  profilePictureUrl?: string | null | undefined;
}

export interface FacebookAccountItem {
  id: string;
  fbAccountId: string;
  displayName: string;
  profilePictureUrl?: string | null | undefined;
  gender?: string | null | undefined;
  accountLink?: string | null | undefined;
  status: 'active' | 'disconnected' | 'expired';
  tokenExpiresAt?: string | null | undefined;
  connectedPagesCount: number;
  connectedPages?: FacebookAccountLinkedPageItem[] | undefined;
  createdAt: string;
  updatedAt?: string | undefined;
}

export interface AccountCardProps {
  account: FacebookAccountItem;
  subdomain?: string | undefined;
  onReconnect?: ((account: FacebookAccountItem) => void) | undefined;
  /** Audit UX5: Reconnect looks disabled while the app-setup check runs. */
  disableReconnect?: boolean | undefined;
  onDisconnect?: ((account: FacebookAccountItem) => void) | undefined;
  onViewPages?: ((account: FacebookAccountItem) => void) | undefined;
  defaultPagesExpanded?: boolean | undefined;
  forceAvatarError?: boolean | undefined;
  /** Briefly true right after this account connects — gold highlight while its toast shows. */
  highlighted?: boolean | undefined;
}

/**
 * Initials for an account or page display name, with a caller-chosen fallback
 * when the name is blank.
 */
function initialsFor(name: string | null | undefined, fallback: string): string {
  if (!name || !name.trim()) return fallback;
  return getUserInitials(name);
}

const RING_CLASSES = {
  operational: 'border-signal-operational',
  queued: 'border-signal-queued',
  critical: 'border-signal-critical',
  idle: 'border-signal-idle',
} as const;

/**
 * Account-card status mark — icon + text only, deliberately NOT the
 * shared `StatusDot` (which renders a coloured dot before its icon).
 * The card's tick already says "connected" and its cross says
 * "expired/error", so the dot is redundant here. Other `StatusDot`
 * consumers are untouched by this local mark.
 * `idle` is unreachable from the card's health model (connected maps to
 * operational, expired/error to critical, expiring-soon to queued) and
 * keeps the shared component's circle icon only for exhaustiveness.
 */
function AccountHealthMark({
  status,
  label,
}: Readonly<{
  status: StatusMarkKind;
  label: string;
}>) {
  return (
    <StatusMark
      kind={status}
      label={label}
      testId="account-health-mark"
      className="font-medium"
    />
  );
}

function LinkedPageRow({ page }: Readonly<{ page: FacebookAccountLinkedPageItem }>) {
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const showImg = Boolean(page.profilePictureUrl) && failedUrl !== page.profilePictureUrl;
  const pageInitials = initialsFor(page.pageName, 'PG');

  return (
    <div
      data-testid={`account-linked-page-${page.id}`}
      className="flex items-center gap-2 py-1 text-body text-ink"
    >
      {showImg ? (
        <Image
          src={page.profilePictureUrl!}
          alt={page.pageName}
          width={24}
          height={24}
          onError={() => setFailedUrl(page.profilePictureUrl ?? '__error__')}
          className="size-6 shrink-0 rounded-full border border-line object-cover"
        />
      ) : (
        <div className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-panel text-xs font-bold text-ink-sub">
          {pageInitials}
        </div>
      )}
      <span className="truncate">{page.pageName}</span>
    </div>
  );
}

export function AccountLinkedPagesList({
  pages,
}: Readonly<{ pages: FacebookAccountLinkedPageItem[] }>) {
  return (
    <div
      data-testid="account-linked-pages-list"
      className="mb-4 flex flex-col gap-0.5 rounded-sm border border-line bg-subtle px-2 py-1"
    >
      {pages.map((page) => (
        <LinkedPageRow key={page.id} page={page} />
      ))}
    </div>
  );
}

function AccountAvatar({
  profilePictureUrl,
  displayName,
  showAvatarImg,
  initials,
  ringClass,
  onAvatarError,
}: Readonly<{
  profilePictureUrl?: string | null | undefined;
  displayName: string;
  showAvatarImg: boolean;
  initials: string;
  ringClass: string;
  onAvatarError: () => void;
}>) {
  if (showAvatarImg && profilePictureUrl) {
    return (
      <Image
        src={profilePictureUrl}
        alt={displayName}
        width={44}
        height={44}
        data-testid="account-avatar-img"
        onError={onAvatarError}
        className={cn('size-11 shrink-0 rounded-full border-2 object-cover', ringClass)}
      />
    );
  }
  return (
    <div
      data-testid="account-avatar-initials"
      className={cn(
        'flex size-11 shrink-0 items-center justify-center rounded-full border-2 bg-subtle text-body font-bold text-ink',
        ringClass
      )}
    >
      {initials}
    </div>
  );
}

function AccountLinkedPagesAffordance({
  connectedPagesCount,
  pagesCountLabel,
  onNavigateToPages,
}: Readonly<{
  connectedPagesCount: number;
  pagesCountLabel: string;
  onNavigateToPages: () => void;
}>) {
  if (connectedPagesCount > 0) {
    return (
      <button
        type="button"
        data-testid="account-pages-toggle"
        onClick={onNavigateToPages}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xs px-2 py-1 text-body text-ink-sub outline-none transition-colors hover:bg-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-link"
      >
        <span data-testid="account-pages-count">{pagesCountLabel}</span>
        <ExternalLinkIcon className="size-3 opacity-70" aria-hidden />
      </button>
    );
  }

  return (
    <span data-testid="account-pages-count" className="px-2 py-1 text-body text-ink-dim">
      {pagesCountLabel}
    </span>
  );
}

export function AccountCard({
  account,
  subdomain,
  onReconnect,
  disableReconnect = false,
  onDisconnect,
  onViewPages,
  defaultPagesExpanded = false,
  forceAvatarError = false,
  highlighted = false,
}: Readonly<AccountCardProps>) {
  const router = useRouter();
  const params = useParams();
  const currentSubdomain = subdomain ?? ((params?.subdomain as string) || '');

  const health = getAccountHealth(account);
  const isExpired = health === 'expired';
  const isError = health === 'error';
  const isExpiringSoon = isTokenExpiringSoon(account);
  const statusSignal =
    health === 'connected' && isExpiringSoon
      ? 'queued'
      : getAccountHealthSignal(health);
  // Audit UX2: a connected account whose token expires soon
  // must say so, not just show a clock next to "Connected".
  const statusLabel =
    health === 'connected' && isExpiringSoon
      ? 'Expires soon'
      : getAccountHealthLabel(health);
  const ringClass = RING_CLASSES[statusSignal];

  const [failedAvatarUrl, setFailedAvatarUrl] = React.useState<string | null>(
    forceAvatarError ? (account.profilePictureUrl ?? '__forced__') : null
  );
  const [isPagesExpanded, setIsPagesExpanded] = React.useState(defaultPagesExpanded);

  const formattedDate = React.useMemo(() => {
    try {
      const d = new Date(account.createdAt);
      return d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return 'recently';
    }
  }, [account.createdAt]);

  const initials = initialsFor(account.displayName, 'FB');
  const showAvatarImg =
    Boolean(account.profilePictureUrl) &&
    !forceAvatarError &&
    failedAvatarUrl !== account.profilePictureUrl;

  const linkedPages = account.connectedPages ?? [];
  const pagesCountLabel = `${account.connectedPagesCount} ${
    account.connectedPagesCount === 1 ? 'page linked' : 'pages linked'
  }`;

  const handleNavigateToPages = () => {
    if (onViewPages) {
      onViewPages(account);
      return;
    }
    if (currentSubdomain) {
      // R16: link by account id, not display name — two accounts
      // sharing a name used to land on an ambiguous filter. The
      // Pages route still resolves a legacy display-name param, so
      // old links keep working.
      router.push(`/tenant/${currentSubdomain}/pages?account=${encodeURIComponent(account.id)}`);
    } else {
      setIsPagesExpanded((prev) => !prev);
    }
  };

  return (
    <div
      data-testid={`account-card-${account.id}`}
      data-highlighted={highlighted ? 'true' : undefined}
      className={cn(
        'flex min-h-40 flex-col justify-between rounded-md border bg-panel p-6 shadow-card transition hover:-translate-y-0.5 hover:shadow-elevated',
        highlighted
          ? 'border-link ring-2 ring-link/40'
          : isExpired
            ? 'border-signal-critical'
            : 'border-line'
      )}
    >
      {/* Profile Header */}
      <div className="mb-4 flex items-center gap-4">
        <AccountAvatar
          profilePictureUrl={account.profilePictureUrl}
          displayName={account.displayName}
          showAvatarImg={showAvatarImg}
          initials={initials}
          ringClass={ringClass}
          onAvatarError={() => setFailedAvatarUrl(account.profilePictureUrl ?? '__error__')}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 overflow-hidden">
            <h3 data-testid="account-name" className="truncate text-body font-semibold text-ink">
              {account.displayName}
            </h3>

            {account.accountLink && (
              <a
                href={account.accountLink}
                target="_blank"
                rel="noopener noreferrer"
                title="View Facebook Profile"
                aria-label={`View ${account.displayName}'s Facebook Profile`}
                data-testid="account-profile-link"
                className="inline-flex shrink-0 items-center text-ink-dim outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-link"
              >
                <ExternalLinkIcon className="size-3.5" aria-hidden />
              </a>
            )}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <span data-testid="account-health-label" className="inline-flex">
              <AccountHealthMark status={statusSignal} label={statusLabel} />
            </span>
            <span data-testid="account-connected-date" className="text-metadata text-ink-dim">
              · Connected {formattedDate}
            </span>
          </div>
        </div>
      </div>

      {/* Blended Linked Pages Strip */}
      <div className="mb-4 flex items-center justify-between">
        <AccountLinkedPagesAffordance
          connectedPagesCount={account.connectedPagesCount}
          pagesCountLabel={pagesCountLabel}
          onNavigateToPages={handleNavigateToPages}
        />
      </div>

      {/* Backward-compatible linked pages list when explicitly expanded in tests/props */}
      {isPagesExpanded && linkedPages.length > 0 && (
        <AccountLinkedPagesList pages={linkedPages} />
      )}

      {/* Session Expired Alert (Only rendered when expired, zero token validity days) */}
      {isExpired && (
        <div
          data-testid="account-expired-alert"
          className="mb-4 flex items-center gap-1.5 rounded-sm border border-signal-critical/25 bg-signal-critical/10 px-2.5 py-1.5 text-metadata font-medium text-signal-critical-on-tint"
        >
          <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
          <span>Session expired — reconnect to resume publishing</span>
        </div>
      )}

      {/* Card Actions */}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
        {isExpired || isExpiringSoon || isError ? (
          <Button
            type="button"
            data-testid="account-reconnect-button"
            variant={isExpired || isError ? 'default' : 'outline'}
            onClick={() => onReconnect?.(account)}
            disabled={disableReconnect}
            title={disableReconnect ? 'Checking app setup…' : undefined}
          >
            <span>
              {disableReconnect
                ? 'Checking…'
                : isExpired || isError
                  ? 'Reconnect account'
                  : 'Refresh connection'}
            </span>
          </Button>
        ) : (
          <div className="flex-1" />
        )}

        <Button
          type="button"
          variant="ghost"
          data-testid="account-disconnect-button"
          onClick={() => onDisconnect?.(account)}
          className="text-ink-dim hover:bg-signal-critical/10 hover:text-signal-critical-on-tint"
        >
          Disconnect
        </Button>
      </div>
    </div>
  );
}
