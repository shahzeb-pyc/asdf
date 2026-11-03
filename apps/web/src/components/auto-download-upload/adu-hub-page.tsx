'use client';

// Vercel rebuild trigger (comment only, no behaviour change) — PR #43, new Vercel account.
import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { MoveUpRightIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { parseAduBulkPaste } from '@fbuploadpro/contracts';
import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent } from '@/components/shared/ui/card';
import { Checkbox } from '@/components/shared/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/shared/ui/dialog';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Input } from '@/components/shared/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shared/ui/select';
import { Textarea } from '@/components/shared/ui/textarea';
import { StatusMark } from '@/components/shared/ui/status-mark';
import { buildTenantApiPath } from '@/lib/api/client';
import { getUserInitials } from '@/lib/user-initials';
import { cn } from '@/lib/utils';
import { FeatureCapText, useFeatureCap } from '@/components/billing/feature-cap';

const STATUS_OPTIONS = [
  'All Statuses', 'Active', 'Inactive', 'Verification Req.', 'Rate Limited',
  'Page Not Accessible', 'Invalid Token', 'Invalid Username', 'Creator Suspended',
  'Completed', '2FA Req. on BM', 'Check Dev App', 'Account Suspended',
] as const;
const SORT_OPTIONS = ['Newest First', 'Most Followers', 'Least Followers'] as const;
const PLATFORMS = ['instagram', 'youtube', 'tiktok', 'facebook'] as const;
type Platform = (typeof PLATFORMS)[number];

interface AduConfigView {
  id: string;
  destinationId: string;
  destinationName: string;
  destinationExternalId: string;
  destinationAvatarUrl: string | null;
  sourcePlatform: Platform;
  sourceUsername: string;
  sourceIdentity: string;
  sourceLink: string;
  destinationStatus: string;
  accountName: string | null;
  status: string;
  displayStatus: string;
  followersCount: number;
  followersGained: number;
  createdAt: string;
  postedCount: number;
  pendingCount: number;
  failedCount: number;
  postedToday: number;
  pendingToday: number;
  failedToday: number;
  postsPerDay: number;
}
interface PickerAccount { id: string; external_account_id: string; display_name: string; avatar_url: string | null; status: string; }
interface PickerPage { id: string; account_id: string; external_destination_id: string; name: string; avatar_url: string | null; status: string; metadata: Record<string, unknown> | null; }
interface Configured { destination_id: string; source_platform: string; source_username: string; }

/**
 * Loads the Add Page picker data. Throws on any non-OK response: the
 * old dialog code parsed the body without checking `response.ok`, so
 * a 500 error body rendered as an empty picker — "0 Connected" with
 * no error shown — while the same picker on a later, successful load
 * showed the real accounts. A failed load must say so, never render
 * as an empty list.
 */
export async function fetchAduOptions(subdomain: string): Promise<{
  accounts: PickerAccount[];
  pages: PickerPage[];
  configured: Configured[];
  migrationMissing: boolean;
}> {
  const response = await fetch(buildTenantApiPath(subdomain, '/auto-download-upload/options'));
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? 'Could not load Facebook accounts and pages.');
  }
  return {
    accounts: body.accounts ?? [],
    pages: body.pages ?? [],
    configured: body.configured ?? [],
    migrationMissing: Boolean(body.migrationMissing),
  };
}

/**
 * Added date for the card, from the page's import date (`createdAt`),
 * formatted like "2 Nov 2026" — the same rule as page-card's
 * `formatAddedDate`. Returns '' for an unparseable date so the card
 * simply omits the line instead of rendering garbage.
 */
function formatAduAddedDate(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export type AduStatusMarkKind = 'operational' | 'queued' | 'critical';

/**
 * Maps an ADU display status (the label `aduDisplayStatus` produces)
 * to a shared `StatusMark` kind, following page-card's kind
 * semantics: operational = healthy, queued = waiting, critical =
 * needs attention. Unknown labels map to critical — an unexpected
 * value must never read as healthy.
 *
 * - operational: 'Active posting' (active), 'All reels posted'
 *   (completed — a healthy terminal state, nothing wrong).
 * - queued: 'Scrape pending' (pending/browser_pending),
 *   'Scraping reels' (processing), 'Posting inactive' (inactive —
 *   paused, like page-card's paused → queued).
 * - critical: everything else — 'Source not found' (sync error),
 *   'Verification required', 'Invalid token', 'Rate limited',
 *   'Page not accessible', 'Source disabled', 'Creator suspended',
 *   'BM 2FA required', 'Check developer app', 'Account suspended'.
 */
export function getAduStatusMarkKind(displayStatus: string): AduStatusMarkKind {
  if (displayStatus === 'Active posting' || displayStatus === 'All reels posted') {
    return 'operational';
  }
  if (
    displayStatus === 'Scrape pending' ||
    displayStatus === 'Scraping reels' ||
    displayStatus === 'Posting inactive'
  ) {
    return 'queued';
  }
  return 'critical';
}

const ADU_RING_CLASSES: Record<AduStatusMarkKind, string> = {
  operational: 'border-2 border-signal-operational',
  queued: 'border-2 border-signal-queued',
  critical: 'border-2 border-signal-critical',
};

/**
 * ADU hub list card, mirroring `components/pages/page-card.tsx`
 * structure with ADU data: avatar with status ring + identity +
 * circled arrow, source link row, status mark + account footer,
 * big coloured counts, and the ADU-specific Today line. The whole
 * card navigates to the detail page on click and on Enter/Space,
 * except when the event target is inside a link (the source link
 * stays independently clickable via stopPropagation) — page-card
 * behaviour exactly.
 */
function AduPageCard({ config, subdomain }: { config: AduConfigView; subdomain: string }) {
  const [failedAvatarUrl, setFailedAvatarUrl] = React.useState<string | null>(null);

  const kind = getAduStatusMarkKind(config.displayStatus);
  const ringClass = ADU_RING_CLASSES[kind];
  const addedDate = formatAduAddedDate(config.createdAt);
  const initials = getUserInitials(config.destinationName);
  const showAvatarImg =
    Boolean(config.destinationAvatarUrl) &&
    failedAvatarUrl !== config.destinationAvatarUrl;
  const targetHref = `/tenant/${subdomain}/auto-download-upload/${config.id}`;

  // Followers semantics, verified from code: `adu_hub_stats` sums
  // `followers_gained` as the total and `followers_gained minus
  // followers_count` (floored at 0) as the net growth — so
  // followersGained is the CURRENT count and followersCount the
  // starting baseline. Net gained is current minus starting,
  // floored at 0, so it can never be negative.
  const currentFollowers = config.followersGained;
  const netGained = Math.max(currentFollowers - config.followersCount, 0);

  // The source link inside the card must never trigger the card's own
  // navigation: clicks stopPropagation on the link itself, and keyboard
  // activation is ignored here when the event target is (or is inside) a
  // link, so the link stays independently tab-focusable and activatable.
  const isLinkEventTarget = (e: React.SyntheticEvent): boolean => {
    const target = e.target as HTMLElement | null;
    return Boolean(target && typeof target.closest === 'function' && target.closest('a'));
  };

  const handleActivate = (e?: React.SyntheticEvent) => {
    if (e && isLinkEventTarget(e)) return;
    if (typeof window !== 'undefined') {
      window.location.href = targetHref;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isLinkEventTarget(e)) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleActivate();
    }
  };

  return (
    <div
      role="link"
      tabIndex={0}
      data-testid={`adu-page-card-${config.id}`}
      data-href={targetHref}
      aria-label={`Open ${config.destinationName} page details`}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      className="group flex min-w-0 cursor-pointer flex-col rounded-md border border-line bg-panel p-6 shadow-card transition outline-none hover:-translate-y-0.5 hover:shadow-elevated focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
    >
      {/* Top row: avatar with status ring + identity + circled arrow. */}
      <div className="flex items-start gap-4">
        {showAvatarImg ? (
          <Image
            src={config.destinationAvatarUrl!}
            alt={config.destinationName}
            width={42}
            height={42}
            data-testid="adu-page-avatar-img"
            onError={() =>
              setFailedAvatarUrl(config.destinationAvatarUrl ?? '__error__')
            }
            className={cn('size-10.5 shrink-0 rounded-full object-cover', ringClass)}
          />
        ) : (
          <div
            data-testid="adu-page-avatar-initials"
            className={cn(
              'flex size-10.5 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-ink',
              ringClass
            )}
          >
            {initials}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <h3
            data-testid="adu-page-name"
            className="m-0 truncate text-body font-semibold text-ink"
          >
            {config.destinationName}
          </h3>
          {addedDate && (
            <span
              data-testid="adu-page-added-line"
              className="mt-0.5 block truncate text-metadata text-ink-dim"
            >
              Added {addedDate}
            </span>
          )}
          <span
            data-testid="adu-page-followers-line"
            className="mt-0.5 block truncate text-metadata text-ink-sub"
          >
            <span
              data-testid="adu-page-current-followers"
              className="text-body font-bold text-ink tabular-nums"
            >
              {currentFollowers.toLocaleString('en-US')}
            </span>{' '}
            followers · {config.sourcePlatform}
          </span>
        </div>

        {/* Circled arrow affordance (muted, gold on hover). */}
        <span
          data-testid="adu-page-card-arrow"
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line text-ink-sub transition group-hover:border-link group-hover:text-link"
        >
          <MoveUpRightIcon className="size-4" />
        </span>
      </div>

      {/* Source link row: source identity link left, gained right
          only when net gained > 0 (page-card behaviour). */}
      <div
        data-testid="adu-page-source-link-row"
        className="mt-3 flex items-center justify-between gap-4"
      >
        <a
          data-testid="adu-page-source-link"
          href={config.sourceLink}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 shrink-0 truncate text-metadata text-link hover:underline"
        >
          {config.sourceIdentity}{' '}
          <MoveUpRightIcon aria-hidden className="inline size-3 shrink-0" />
        </a>
        {netGained > 0 && (
          <span
            data-testid="adu-page-followers-gained"
            className="shrink-0 text-metadata tabular-nums text-signal-operational"
          >
            +{netGained.toLocaleString('en-US')} gained
          </span>
        )}
      </div>

      {/* Divider + footer: status mark left, account right. */}
      <div aria-hidden className="pt-3">
        <div className="border-t border-line" />
      </div>
      <div className="mt-3 flex items-center justify-between gap-4">
        <StatusMark
          kind={kind}
          label={config.displayStatus}
          testId="adu-page-status"
          className="min-w-0 font-semibold tracking-wide"
          labelClassName="truncate"
        />

        <div
          data-testid="adu-page-parent-account"
          className="min-w-0 max-w-45 shrink-0 truncate text-right text-metadata text-ink-sub"
        >
          Account: {config.accountName || 'Connected Account'}
        </div>
      </div>

      {/* Divider + counts row: big signal-coloured numbers on top,
          labels below, in Queued / Posted / Failed order. */}
      <div aria-hidden className="pt-3">
        <div className="border-t border-line" />
      </div>
      <div
        data-testid="adu-page-queue-counts"
        className="mt-3 grid grid-cols-3 gap-4"
      >
        <span
          data-testid="adu-page-queued-stat"
          className="flex flex-col items-center text-center"
        >
          <span
            data-testid="adu-page-queued-count"
            className="text-xxl font-bold tabular-nums text-signal-queued"
          >
            {config.pendingCount.toLocaleString('en-US')}
          </span>
          <span className="mt-1 text-metadata text-ink-sub">Queued</span>
        </span>
        <span
          data-testid="adu-page-posted-stat"
          className="flex flex-col items-center text-center"
        >
          <span
            data-testid="adu-page-posted-count"
            className="text-xxl font-bold tabular-nums text-signal-operational"
          >
            {config.postedCount.toLocaleString('en-US')}
          </span>
          <span className="mt-1 text-metadata text-ink-sub">Posted</span>
        </span>
        <span
          data-testid="adu-page-failed-stat"
          className="flex flex-col items-center text-center"
        >
          <span
            data-testid="adu-page-failed-count"
            className="text-xxl font-bold tabular-nums text-signal-critical"
          >
            {config.failedCount.toLocaleString('en-US')}
          </span>
          <span className="mt-1 text-metadata text-ink-sub">Failed</span>
        </span>
      </div>

      {/* ADU-specific Today line, kept: centred, muted, with
          nonzero counts in dark semibold and zeros muted. */}
      <p
        data-testid="adu-page-today-line"
        className="mt-3 text-center text-body text-ink-sub"
      >
        Today: Pending{' '}
        <span className={config.pendingToday > 0 ? 'font-semibold text-ink' : undefined}>
          {config.pendingToday}
        </span>{' '}
        · Posted{' '}
        <span className={config.postedToday > 0 ? 'font-semibold text-ink' : undefined}>
          {config.postedToday}
        </span>{' '}
        · Failed{' '}
        <span className={config.failedToday > 0 ? 'font-semibold text-ink' : undefined}>
          {config.failedToday}
        </span>
      </p>
    </div>
  );
}

export function AduHubPage({ subdomain }: { subdomain: string }) {
  const [configs, setConfigs] = React.useState<AduConfigView[]>([]);
  const [stats, setStats] = React.useState({ totalPages: 0, followersGained: 0, totalFollowers: 0 });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [migrationMissing, setMigrationMissing] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<string>('All Statuses');
  const [sort, setSort] = React.useState<string>('Newest First');
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(0);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  // Plan cap: the Add Page button disables at the cap, and the
  // ADU create route enforces the same cap server-side.
  const { cap: facebookCap } = useFeatureCap(subdomain, 'facebook');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: searchQuery, status: statusFilter, sort, page: String(page) });
      const response = await fetch(`${buildTenantApiPath(subdomain, '/auto-download-upload')}?${params}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'Failed to load pages.');
      setConfigs(body.configs ?? []);
      setStats(body.stats ?? { totalPages: 0, followersGained: 0, totalFollowers: 0 });
      setTotalPages(body.totalPages ?? 0);
      setMigrationMissing(Boolean(body.migrationMissing));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pages.');
    } finally {
      setLoading(false);
    }
  }, [subdomain, searchQuery, statusFilter, sort, page]);

  React.useEffect(() => { void load(); }, [load]);

  const hasActiveFilter = searchQuery.trim() !== '' || statusFilter !== 'All Statuses';

  return (
    <div className="mx-auto box-border flex w-full max-w-300 flex-col gap-6 px-6 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-lg leading-heading font-semibold text-ink">Auto Download/Upload</h1>
          <p className="text-body text-ink-sub">Connected Facebook pages for automated reel download and posting.</p>
          {facebookCap ? (
            <FeatureCapText cap={facebookCap} platform="facebook" />
          ) : null}
        </div>
        <Button type="button" onClick={() => setDialogOpen(true)} disabled={facebookCap?.atCap ?? false}>
          <PlusIcon aria-hidden /><span>+ Add Page</span>
        </Button>
      </div>

      {migrationMissing ? (
        <Banner variant="warning" title="ADU tables are not created yet" description="Apply migration 20261030120001_adu.sql to the database, then refresh this page. Until then, no ADU pages can be added." />
      ) : null}
      {error ? <Banner variant="critical" title="Could not load pages" description={error} /> : null}

      <Card className="py-0">
        <CardContent className="px-0">
          <div className="grid divide-y divide-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {[
              { label: 'Total Pages', value: stats.totalPages },
              { label: 'Followers Gained', value: stats.followersGained },
              { label: 'Total Followers', value: stats.totalFollowers },
            ].map((stat) => (
              <div key={stat.label} className="px-6 py-4">
                <p className="text-metadata font-medium text-ink-dim">{stat.label}</p>
                <p className="mt-1 text-xxl leading-heading font-bold text-ink">{stat.value}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Input type="search" aria-label="Search pages or sources" placeholder="Search pages or sources…" value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }} className="min-w-55 flex-1 sm:max-w-80" />
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
          <SelectTrigger aria-label="Filter by status"><SelectValue /></SelectTrigger>
          <SelectContent>{STATUS_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => { setSort(v); setPage(1); }}>
          <SelectTrigger aria-label="Sort pages"><SelectValue /></SelectTrigger>
          <SelectContent>{SORT_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {loading ? (
        <p className="text-body text-ink-sub">Loading pages…</p>
      ) : migrationMissing ? (
        <p className="text-body text-ink-sub">ADU pages cannot be listed or added until the tables are created — see the warning above.</p>
      ) : configs.length === 0 ? (
        hasActiveFilter ? (
          <EmptyState type="no-results" title="No pages match your search or filters." action={<Button type="button" variant="outline" onClick={() => { setSearchQuery(''); setStatusFilter('All Statuses'); setPage(1); }}>Clear filters</Button>} />
        ) : (
          <EmptyState type="first-use" title="No pages found" description="Connect a Facebook account and add your first page to start automation." />
        )
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {configs.map((config) => (
              <AduPageCard key={config.id} config={config} subdomain={subdomain} />
            ))}
          </div>
          {totalPages > 1 ? (
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <span className="text-body text-ink-sub">Page {page} of {totalPages}</span>
              <Button type="button" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          ) : null}
        </>
      )}

      <AddPageDialog
        subdomain={subdomain}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={() => { setDialogOpen(false); setPage(1); void load(); }}
      />
    </div>
  );
}

/**
 * Picker avatar (page-card pattern): the photo when a URL is present
 * and loads, initials otherwise. Per-row state lives here because a
 * hook cannot live inside the row map below.
 */
function PickerAvatar({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = React.useState(false);
  if (url && !failed) {
    return (
      <Image
        src={url}
        alt=""
        width={32}
        height={32}
        data-testid="picker-avatar-img"
        onError={() => setFailed(true)}
        className="size-8 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      data-testid="picker-avatar-initials"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-subtle text-metadata font-bold text-ink"
    >
      {getUserInitials(name)}
    </span>
  );
}

/**
 * Page picker meta line, mirroring the Pages picker row exactly:
 * "{category} • {N} followers". The category falls back to
 * 'Facebook Page' and followers always render via
 * `current_followers ?? 0` from the destinations metadata already in
 * the options payload — never a dangling separator, never a missing
 * count, and never the page id (the picker no longer renders it).
 */
function pageMetaLine(page: PickerPage): string {
  const metadata = page.metadata ?? {};
  const category = typeof metadata.category === 'string' && metadata.category.trim()
    ? metadata.category.trim()
    : 'Facebook Page';
  const followers = typeof metadata.current_followers === 'number' ? metadata.current_followers : 0;
  return `${category} • ${followers.toLocaleString('en-US')} followers`;
}

/**
 * Pages picker's `pagesLinkedLabel`: "N page(s) linked" for an
 * account. Pages counts the account's connected pages; here the
 * count is the options-payload pages under that account — the same
 * population (workspace Facebook destinations), so the label means
 * the same thing.
 */
function pagesLinkedLabel(count: number): string {
  return `${count} ${count === 1 ? 'page linked' : 'pages linked'}`;
}

export function AddPageDialog({ subdomain, open, onOpenChange, onCreated }: {
  subdomain: string; open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void;
}) {
  const [step, setStep] = React.useState(1);
  const [accounts, setAccounts] = React.useState<PickerAccount[]>([]);
  const [pages, setPages] = React.useState<PickerPage[]>([]);
  const [configured, setConfigured] = React.useState<Configured[]>([]);
  const [accountSearch, setAccountSearch] = React.useState('');
  const [pageSearch, setPageSearch] = React.useState('');
  const [selectedAccountIds, setSelectedAccountIds] = React.useState<string[]>([]);
  const [selectedPageIds, setSelectedPageIds] = React.useState<string[]>([]);
  const [sources, setSources] = React.useState<Record<string, { platform: Platform; username: string }>>({});
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteText, setPasteText] = React.useState('');
  const [pasteFeedback, setPasteFeedback] = React.useState<string | null>(null);
  const [postsPerDay, setPostsPerDay] = React.useState(1);
  const [timezone, setTimezone] = React.useState('Asia/Karachi');
  const [scheduleType, setScheduleType] = React.useState<'dailyrandom' | 'fixed'>('dailyrandom');
  const [fixedTimes, setFixedTimes] = React.useState<string[]>(['09:00']);
  // 'all' is the shared schedule below; 'separate' keeps one schedule
  // per selected page.
  type PageSchedule = { postsPerDay: number; timezone: string; postingTimes: string[] };
  const [timingScope, setTimingScope] = React.useState<'all' | 'separate'>('all');
  const [schedulesByPage, setSchedulesByPage] = React.useState<Record<string, PageSchedule>>({});
  const defaultPageSchedule = (): PageSchedule => ({ postsPerDay: 1, timezone: 'Asia/Karachi', postingTimes: [] });
  const pageSchedule = (pageId: string): PageSchedule => schedulesByPage[pageId] ?? defaultPageSchedule();
  const ensureTimesLength = (times: string[], n: number): string[] => {
    const next = [...times];
    if (n > next.length) for (let i = next.length; i < n; i++) next.push('');
    else if (n < next.length) next.splice(n);
    return next;
  };
  const updatePageSchedule = (pageId: string, patch: Partial<PageSchedule>) => {
    setSchedulesByPage((prev) => ({ ...prev, [pageId]: { ...(prev[pageId] ?? defaultPageSchedule()), ...patch } }));
  };
  const pageScheduleComplete = (pageId: string): boolean => {
    const s = pageSchedule(pageId);
    if (!s.timezone.trim() || !Number.isInteger(s.postsPerDay) || s.postsPerDay < 1 || s.postsPerDay > 12) return false;
    if (scheduleType === 'fixed') {
      return s.postingTimes.length === s.postsPerDay && s.postingTimes.every((t) => String(t ?? '').trim() !== '');
    }
    return true;
  };
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);
  const [optionsMigrationMissing, setOptionsMigrationMissing] = React.useState(false);
  const [optionsLoading, setOptionsLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setStep(1); setError(null); setResult(null); setOptionsMigrationMissing(false);
    setOptionsLoading(true);
    void fetchAduOptions(subdomain)
      .then((body) => {
        setAccounts(body.accounts);
        setPages(body.pages);
        setConfigured(body.configured);
        setOptionsMigrationMissing(body.migrationMissing);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load Facebook accounts and pages.'))
      .finally(() => setOptionsLoading(false));
  }, [open, subdomain]);

  // Accounts are partitioned like the Pages picker: active accounts
  // are selectable; expired accounts render dimmed with "Session
  // expired"; broken accounts render dimmed with "Connection issue".
  // The partition follows the canonical account-health model
  // (getAccountHealth: 'expired' wins, 'disconnected' is an error,
  // everything else is connected) — ADU options carry no token
  // expiry, so the expiry branch cannot fire here. Two raw statuses
  // the accounts surface itself treats as critical ('error',
  // 'revoked') are additionally routed to the error section rather
  // than left selectable on a broken account. ADU has no in-dialog
  // reconnect, so the dimmed sections link to Facebook Accounts
  // instead of offering a Reconnect button.
  const activeAccounts = accounts.filter((a) =>
    a.status !== 'expired' && a.status !== 'disconnected' && a.status !== 'error' && a.status !== 'revoked');
  const expiredAccounts = accounts.filter((a) => a.status === 'expired');
  const errorAccounts = accounts.filter((a) =>
    a.status === 'disconnected' || a.status === 'error' || a.status === 'revoked');
  const filteredAccounts = activeAccounts.filter((a) => a.display_name.toLowerCase().includes(accountSearch.toLowerCase()));
  // "Pages linked" counts connected pages only, exactly as the Pages
  // accounts list counts: a destination counts unless it is
  // disconnected, except a disconnected destination that is paused
  // still counts (SQL: d.status != 'disconnected' OR
  // d.metadata->>'fb_status' = 'paused'; same filter in the Supabase
  // path — apps/web/src/app/api/tenant/[subdomain]/accounts/route.ts).
  // NOTE: this is a count-only parity fix. The step-2 union below is
  // intentionally NOT filtered the same way: a disconnected page can
  // still appear (and be picked) there, so the count may read lower
  // than the number of rows step 2 lists for an account.
  const isLinkedPage = (p: PickerPage) =>
    p.status !== 'disconnected' || (p.metadata?.fb_status === 'paused');
  const linkedPagesCount = (accountId: string) =>
    pages.filter((p) => p.account_id === accountId && isLinkedPage(p)).length;
  // Step 2 shows ONLY the union of the selected accounts' pages —
  // never pages of unselected accounts, never the whole list.
  const unionPages = pages.filter((p) => selectedAccountIds.includes(p.account_id));
  const visiblePages = unionPages.filter((p) => p.name.toLowerCase().includes(pageSearch.toLowerCase()));
  const selectablePageIds = unionPages.filter((p) => !configured.some((c) => c.destination_id === p.id)).map((p) => p.id);
  const allAccountsChecked = activeAccounts.length > 0 && activeAccounts.every((a) => selectedAccountIds.includes(a.id));
  const allPagesChecked = selectablePageIds.length > 0 && selectablePageIds.every((id) => selectedPageIds.includes(id));
  const selectedPages = pages.filter((p) => selectedPageIds.includes(p.id));
  const isConfigured = (pageId: string) => configured.some((c) => c.destination_id === pageId);
  const allSourcesFilled = selectedPages.every((p) => (sources[p.id]?.username ?? '').trim() !== '');

  const toggle = (list: string[], id: string, set: (v: string[]) => void) => {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };

  // Deselecting an account drops its pages from the page selection
  // (and from the step-2 list, which is the union of selected
  // accounts). Re-selecting does not restore them.
  const toggleAccount = (id: string) => {
    const next = selectedAccountIds.includes(id)
      ? selectedAccountIds.filter((x) => x !== id)
      : [...selectedAccountIds, id];
    setSelectedAccountIds(next);
    if (!next.includes(id)) {
      setSelectedPageIds((prev) => prev.filter((pid) => {
        const page = pages.find((p) => p.id === pid);
        return page ? next.includes(page.account_id) : false;
      }));
    }
  };

  const toggleAllAccounts = () => {
    if (allAccountsChecked) {
      setSelectedAccountIds([]);
      setSelectedPageIds([]);
    } else {
      setSelectedAccountIds(activeAccounts.map((a) => a.id));
    }
  };

  const toggleAllPages = () => {
    setSelectedPageIds(allPagesChecked ? [] : selectablePageIds);
  };

  const sourcePlaceholder = (platform: Platform) =>
    platform === 'youtube' ? 'channel_id' : platform === 'facebook' ? 'page_or_user_id' : '@username';

  const applyPaste = () => {
    const parsed = parseAduBulkPaste(pasteText, 'tiktok');
    if (parsed.errors.length > 0) { setPasteFeedback(parsed.errors.join(' ')); return; }
    const empty = selectedPages.filter((p) => !(sources[p.id]?.username ?? '').trim());
    const already = new Set(configured.map((c) => `${c.source_platform}|${c.source_username.toLowerCase()}`));
    const next = { ...sources };
    let assigned = 0;
    const shuffled = [...parsed.sources].sort(() => Math.random() - 0.5);
    for (const source of shuffled) {
      if (assigned >= empty.length) break;
      const key = `${source.platform}|${source.username.toLowerCase()}`;
      if (already.has(key)) continue;
      const page = empty[assigned];
      if (!page) break;
      next[page.id] = { platform: source.platform, username: source.username };
      assigned += 1;
    }
    setSources(next);
    setPasteFeedback(`${assigned} new sources assigned to ${empty.length} empty page slots. ${parsed.warnings.join(' ')}`);
    setPasteOpen(false);
  };

  const submit = async () => {
    setSubmitting(true); setError(null); setResult(null);
    try {
      // 'all' uses the shared schedule below; 'separate' sends one
      // schedule per page. Per-page failures are reported individually.
      if (timingScope === 'separate' && scheduleType === 'fixed') {
        for (const p of selectedPages) {
          const s = pageSchedule(p.id);
          if (s.postingTimes.length !== s.postsPerDay || s.postingTimes.some((t) => !String(t ?? '').trim())) {
            throw new Error(`Fixed posting requires ${s.postsPerDay} posting times for "${p.name}".`);
          }
        }
      }
      if (timingScope === 'separate') {
        for (const p of selectedPages) {
          const s = pageSchedule(p.id);
          if (!s.timezone.trim() || !Number.isInteger(s.postsPerDay) || s.postsPerDay < 1 || s.postsPerDay > 12) {
            throw new Error(`Please complete timezone and posts per day for "${p.name}".`);
          }
        }
      }
      const items = selectedPages.map((p) => {
        const base = {
          destinationId: p.id,
          sourcePlatform: sources[p.id]?.platform ?? 'tiktok',
          sourceUsername: sources[p.id]?.username ?? '',
        };
        if (timingScope !== 'separate') return base;
        const s = pageSchedule(p.id);
        return {
          ...base,
          schedule: {
            timezone: s.timezone,
            postsPerDay: s.postsPerDay,
            postingTimes: scheduleType === 'fixed' ? s.postingTimes : undefined,
          },
        };
      });
      const response = await fetch(buildTenantApiPath(subdomain, '/auto-download-upload'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items, timezone, postsPerDay, scheduleType,
          postingTimes: scheduleType === 'fixed' ? fixedTimes.slice(0, postsPerDay) : undefined,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok && !(body.created ?? []).length) throw new Error(body.error ?? 'Could not add these pages.');
      const failedText = (body.failed ?? []).map((f: { destinationId: string; error: string }) => f.error).join(' ');
      const createdCount = (body.created ?? []).length;
      setResult(`Created ${createdCount} ${createdCount === 1 ? 'page' : 'pages'}.${failedText ? ` Failed: ${failedText}` : ''}`);
      if ((body.failed ?? []).length === 0) onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this page.');
    } finally {
      setSubmitting(false);
    }
  };

  const stepSubtitle = step === 1 ? 'Select Accounts' : step === 2 ? 'Select Pages' : 'Sources & Schedule';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-dvh overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add New Page</DialogTitle>
          <DialogDescription>Step {step} of 3: {stepSubtitle}</DialogDescription>
        </DialogHeader>

        {optionsMigrationMissing ? (
          <Banner variant="warning" title="ADU tables are not created yet" description="Apply migration 20261030120001_adu.sql to the database, then refresh this page. Until then, no ADU pages can be added." />
        ) : null}
        {error ? <Banner variant="critical" title="Could not add pages" description={error} /> : null}
        {result ? <Banner variant="success" title="Done" description={result} /> : null}

        {step === 1 ? (
          <div className="flex flex-col gap-4">
            {optionsLoading ? (
              // Never render "0 accounts found" while the picker data
              // is still loading: the count line only means something
              // once the fetch has resolved (or failed loudly above).
              <p className="text-body text-ink-sub">Loading accounts and pages…</p>
            ) : (
              <>
                <div>
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-4 px-0.5">
                    <div className="relative flex max-w-60 flex-1 items-center">
                      <SearchIcon
                        className="pointer-events-none absolute left-2.5 size-3.5 text-ink-dim"
                        aria-hidden
                      />
                      <Input
                        type="text"
                        data-testid="adu-accounts-search-input"
                        value={accountSearch}
                        onChange={(e) => setAccountSearch(e.target.value)}
                        placeholder="Filter accounts..."
                        aria-label="Filter accounts"
                        className="border-line bg-canvas pl-8 shadow-none"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-metadata text-ink-sub">
                        {activeAccounts.length}{' '}
                        {activeAccounts.length === 1 ? 'account found' : 'accounts found'}
                      </span>
                      {activeAccounts.length > 0 ? (
                        <button
                          type="button"
                          data-testid="adu-select-all-accounts-btn"
                          aria-pressed={allAccountsChecked}
                          onClick={toggleAllAccounts}
                          className="inline-flex min-h-11 items-center px-2 text-metadata font-semibold text-link outline-none focus-visible:outline-2 focus-visible:outline-link"
                        >
                          {allAccountsChecked ? 'Deselect All' : 'Select All'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div
                    data-testid="adu-accounts-list"
                    className="flex max-h-85 flex-col overflow-y-auto border-t border-line"
                  >
                    {filteredAccounts.map((account) => {
                      const checked = selectedAccountIds.includes(account.id);
                      return (
                        <label
                          key={account.id}
                          data-testid={`adu-account-row-${account.id}`}
                          className={cn(
                            'flex cursor-pointer items-center gap-4 rounded-xs border-b border-line px-3 py-2.5 transition-colors hover:bg-hover',
                            checked ? 'bg-subtle' : 'bg-transparent'
                          )}
                        >
                          <Checkbox
                            data-testid={`adu-account-checkbox-${account.id}`}
                            checked={checked}
                            onCheckedChange={() => toggleAccount(account.id)}
                          />
                          <PickerAvatar url={account.avatar_url} name={account.display_name} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-body font-semibold text-ink">
                              {account.display_name}
                            </span>
                            <span className="mt-0.5 block text-metadata text-ink-sub">
                              {pagesLinkedLabel(linkedPagesCount(account.id))}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {filteredAccounts.length === 0 ? (
                    <p className="p-6 text-center text-body text-ink-sub">
                      {activeAccounts.length === 0
                        ? 'No active Facebook accounts connected.'
                        : 'No accounts match your search.'}
                    </p>
                  ) : null}
                </div>
                {expiredAccounts.length > 0 ? (
                  <div data-testid="adu-expired-accounts-list" className="flex flex-col gap-1">
                    {expiredAccounts.map((account) => (
                      <div
                        key={account.id}
                        data-testid={`adu-expired-account-${account.id}`}
                        className="flex items-center justify-between gap-4 rounded-sm px-3.5 py-3 opacity-55"
                      >
                        <div className="flex min-w-0 items-center gap-4">
                          <PickerAvatar url={account.avatar_url} name={account.display_name} />
                          <div className="min-w-0">
                            <div className="truncate text-body font-semibold text-ink">
                              {account.display_name}
                            </div>
                            <div className="mt-0.5 text-metadata text-ink-sub">
                              {pagesLinkedLabel(linkedPagesCount(account.id))} · Session expired
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {errorAccounts.length > 0 ? (
                  <div data-testid="adu-error-accounts-list" className="flex flex-col gap-1">
                    {errorAccounts.map((account) => (
                      <div
                        key={account.id}
                        data-testid={`adu-error-account-${account.id}`}
                        className="flex items-center justify-between gap-4 rounded-sm px-3.5 py-3 opacity-55"
                      >
                        <div className="flex min-w-0 items-center gap-4">
                          <PickerAvatar url={account.avatar_url} name={account.display_name} />
                          <div className="min-w-0">
                            <div className="truncate text-body font-semibold text-ink">
                              {account.display_name}
                            </div>
                            <div className="mt-0.5 text-metadata text-ink-sub">
                              {pagesLinkedLabel(linkedPagesCount(account.id))} · Connection issue
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
                {expiredAccounts.length > 0 || errorAccounts.length > 0 ? (
                  <Button type="button" variant="outline" asChild>
                    <Link href={`/tenant/${subdomain}/accounts`}>Go to Facebook Accounts</Link>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  data-testid="adu-accounts-next-btn"
                  disabled={selectedAccountIds.length === 0}
                  onClick={() => setStep(2)}
                >
                  Next
                </Button>
              </>
            )}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="flex flex-col gap-2">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-4 px-0.5">
              <div className="relative flex max-w-60 flex-1 items-center">
                <SearchIcon
                  className="pointer-events-none absolute left-2.5 size-3.5 text-ink-dim"
                  aria-hidden
                />
                <Input
                  type="text"
                  data-testid="adu-pages-search-input"
                  value={pageSearch}
                  onChange={(e) => setPageSearch(e.target.value)}
                  placeholder="Filter pages..."
                  aria-label="Filter pages"
                  className="border-line bg-canvas pl-8 shadow-none"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-metadata text-ink-sub">
                  {unionPages.length} {unionPages.length === 1 ? 'page found' : 'pages found'}
                </span>
                {selectablePageIds.length > 0 ? (
                  <button
                    type="button"
                    data-testid="adu-select-all-pages-btn"
                    aria-pressed={allPagesChecked}
                    onClick={toggleAllPages}
                    className="inline-flex min-h-11 items-center px-2 text-metadata font-semibold text-link outline-none focus-visible:outline-2 focus-visible:outline-link"
                  >
                    {allPagesChecked ? 'Deselect All' : 'Select All'}
                  </button>
                ) : null}
              </div>
            </div>
            <div
              data-testid="adu-pages-list"
              className="flex max-h-85 flex-col overflow-y-auto border-t border-line"
            >
              {visiblePages.map((page) => {
                const configuredAlready = isConfigured(page.id);
                const checked = configuredAlready || selectedPageIds.includes(page.id);
                const isSelected = !configuredAlready && checked;
                return (
                  <label
                    key={page.id}
                    data-testid={`adu-page-row-${page.id}`}
                    className={cn(
                      'flex items-center gap-4 rounded-xs border-b border-line px-3 py-2.5 transition-colors',
                      isSelected ? 'bg-subtle' : 'bg-transparent',
                      configuredAlready ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-hover'
                    )}
                  >
                    <Checkbox
                      data-testid={`adu-page-checkbox-${page.id}`}
                      checked={checked}
                      disabled={configuredAlready}
                      onCheckedChange={() => {
                        if (!configuredAlready) {
                          toggle(selectedPageIds, page.id, setSelectedPageIds);
                        }
                      }}
                    />
                    <PickerAvatar url={page.avatar_url} name={page.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-semibold text-ink">{page.name}</span>
                      <span className="mt-0.5 block truncate text-metadata text-ink-sub">
                        {pageMetaLine(page)}
                      </span>
                    </span>
                    {configuredAlready ? (
                      <span className="shrink-0 text-metadata font-medium text-ink-dim">Already added</span>
                    ) : null}
                  </label>
                );
              })}
            </div>
            {visiblePages.length === 0 ? (
              <p className="p-6 text-center text-body text-ink-sub">
                {unionPages.length === 0
                  ? 'No pages on the selected accounts.'
                  : 'No pages match your search.'}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" variant="outline" data-testid="adu-pages-back-btn" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button
                type="button"
                data-testid="adu-pages-next-btn"
                disabled={selectedPageIds.length === 0}
                onClick={() => setStep(3)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="font-medium">Sources</h3>
              <p className="text-body text-ink-sub">One source per page. Sources are assigned to the pages you picked.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => setPasteOpen(true)}>Paste sources (random assign)</Button>
              </div>
              {pasteFeedback ? <p className="text-body text-ink-sub">{pasteFeedback}</p> : null}
              {pasteOpen ? (
                <div className="mt-2 flex flex-col gap-2 rounded-md border p-3">
                  <p className="text-body">One source per line, platform|username — for example instagram|ronaldo, facebook|messi. Sources are assigned randomly to empty page slots only.</p>
                  <Textarea rows={6} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder={'instagram|ronaldo\nfacebook|messi'} />
                  <div className="flex gap-2">
                    <Button type="button" onClick={applyPaste}>Apply assignment</Button>
                    <Button type="button" variant="outline" onClick={() => setPasteOpen(false)}>Cancel</Button>
                  </div>
                </div>
              ) : null}
              <div className="mt-2 flex flex-col gap-2">
                {selectedPages.map((page) => (
                  <div key={page.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                    <span className="min-w-0 flex-1 truncate">{page.name}</span>
                    <Select value={sources[page.id]?.platform ?? 'tiktok'} onValueChange={(v) => setSources({ ...sources, [page.id]: { platform: v as Platform, username: sources[page.id]?.username ?? '' } })}>
                      <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                      <SelectContent>{PLATFORMS.map((p) => <SelectItem key={p} value={p} disabled={p !== 'tiktok'}>{p}</SelectItem>)}</SelectContent>
                    </Select>
                    <Input placeholder={sourcePlaceholder(sources[page.id]?.platform ?? 'tiktok')} value={sources[page.id]?.username ?? ''} onChange={(e) => setSources({ ...sources, [page.id]: { platform: sources[page.id]?.platform ?? 'tiktok', username: e.target.value } })} className="w-48" />
                  </div>
                ))}
              </div>
            </div>

            <div aria-hidden className="border-t border-line" />

            <div>
              <h3 className="font-medium">Schedule</h3>
              <div className="mt-2 flex gap-2">
                <Button type="button" variant={scheduleType === 'dailyrandom' ? 'default' : 'outline'} onClick={() => {
                  setScheduleType('dailyrandom');
                  setSchedulesByPage((prev) => {
                    const next: Record<string, { postsPerDay: number; timezone: string; postingTimes: string[] }> = {};
                    for (const [k, v] of Object.entries(prev)) next[k] = { ...v, postingTimes: [] };
                    return next;
                  });
                }}>Random Posting Times</Button>
                <Button type="button" variant={scheduleType === 'fixed' ? 'default' : 'outline'} onClick={() => {
                  setScheduleType('fixed');
                  setSchedulesByPage((prev) => {
                    const next: Record<string, { postsPerDay: number; timezone: string; postingTimes: string[] }> = {};
                    for (const [k, v] of Object.entries(prev)) next[k] = { ...v, postingTimes: ensureTimesLength(v.postingTimes, v.postsPerDay) };
                    return next;
                  });
                }}>Fixed Posting Times</Button>
              </div>
              <div className="mt-4">
                <p className="font-medium">Apply Schedule</p>
                <div className="mt-2 flex items-center gap-2">
                  <Button type="button" variant={timingScope === 'all' ? 'default' : 'outline'} onClick={() => setTimingScope('all')}>One for all pages</Button>
                  <Button type="button" variant={timingScope === 'separate' ? 'default' : 'outline'} onClick={() => setTimingScope('separate')}>Set separately</Button>
                </div>
              </div>
              {timingScope === 'all' ? (
                <>
                  <p className="mt-2 text-body text-ink-sub">These settings will be used for all selected pages.</p>
                  <div className="mt-2">
                    <label className="font-medium" htmlFor="adu-posts-per-day">Posts Per Day</label>
                    <Input id="adu-posts-per-day" type="number" min={1} max={12} value={postsPerDay} onChange={(e) => {
                      const n = Math.max(1, Math.min(12, Number(e.target.value) || 1));
                      setPostsPerDay(n);
                      setFixedTimes(Array.from({ length: n }, (_, i) => fixedTimes[i] ?? '09:00'));
                    }} />
                  </div>
                  <div className="mt-2">
                    <label className="font-medium" htmlFor="adu-timezone">Posting Timezone</label>
                    <Input id="adu-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                  </div>
                  {scheduleType === 'dailyrandom' ? (
                    <p className="mt-2 text-body text-ink-sub">Balanced random times will be automatically generated upon saving to ensure a minimum 5-hour gap between posts.</p>
                  ) : (
                    <div className="mt-2 flex flex-col gap-2">
                      <p className="text-body">One time per post, per day:</p>
                      {Array.from({ length: postsPerDay }, (_, i) => (
                        <Input key={i} type="time" value={fixedTimes[i] ?? '09:00'} onChange={(e) => {
                          const next = [...fixedTimes]; next[i] = e.target.value; setFixedTimes(next);
                        }} />
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  {scheduleType === 'dailyrandom' ? (
                    <p className="mt-2 text-body text-ink-sub">Balanced random times will be automatically generated upon saving to ensure a minimum 5-hour gap between posts.</p>
                  ) : null}
                  <div className="mt-2 flex max-h-80 flex-col gap-2 overflow-y-auto pr-2">
                    {selectedPages.map((page) => {
                      const s = pageSchedule(page.id);
                      const accountName = accounts.find((a) => a.id === page.account_id)?.display_name;
                      const label = accountName ? `${page.name} · ${accountName}` : page.name;
                      return (
                        <div key={`schedule-${page.id}`} className="flex flex-col gap-3 rounded-lg border p-3">
                          <p className="text-body font-semibold">{label}</p>
                          <div>
                            <label className="font-medium" htmlFor={`adu-bulk-${page.id}-posts-per-day`}>Posts Per Day</label>
                            <Input id={`adu-bulk-${page.id}-posts-per-day`} type="number" min={1} max={12} value={s.postsPerDay} onChange={(e) => {
                              const n = Math.max(1, Math.min(12, Number(e.target.value) || 1));
                              updatePageSchedule(page.id, {
                                postsPerDay: n,
                                postingTimes: scheduleType === 'fixed' ? ensureTimesLength(s.postingTimes, n) : [],
                              });
                            }} />
                          </div>
                          <div>
                            <label className="font-medium" htmlFor={`adu-bulk-${page.id}-timezone`}>Posting Timezone</label>
                            <Input id={`adu-bulk-${page.id}-timezone`} value={s.timezone} onChange={(e) => updatePageSchedule(page.id, { timezone: e.target.value })} />
                          </div>
                          {scheduleType === 'fixed' ? (
                            <div className="flex flex-col gap-2">
                              <p className="text-body">Fixed Posting Times</p>
                              {ensureTimesLength(s.postingTimes, s.postsPerDay).map((time, index) => (
                                <Input key={index} type="time" value={time} onChange={(e) => {
                                  const next = ensureTimesLength(s.postingTimes, s.postsPerDay);
                                  next[index] = e.target.value;
                                  updatePageSchedule(page.id, { postingTimes: next });
                                }} />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setStep(2)}>Back</Button>
              <Button
                type="button"
                disabled={submitting || !allSourcesFilled || (timingScope === 'separate' && !selectedPages.every((p) => pageScheduleComplete(p.id)))}
                onClick={() => void submit()}
              >
                Start Automation
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
