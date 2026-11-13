'use client';

// Vercel rebuild trigger (comment only, no behaviour change) — PR #43, new Vercel account.
import * as React from 'react';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { MoveUpRightIcon, PlusIcon, SearchIcon } from 'lucide-react';
import { parseAduBulkPaste, ADU_STATUS_FILTER_OPTIONS } from '@fbuploadpro/contracts';
import { formatSlotDisplay } from '@/components/pages/dedicated/posting-times/posting-time-utils';
import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent } from '@/components/shared/ui/card';
import { Checkbox } from '@/components/shared/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { getAduStatusMarkKind, type AduStatusMarkKind } from '@/lib/adu-hub-helpers';
import { api, buildTenantApiPath, isApiError } from '@/lib/api';
import {
  DiscoverPagesResponseSchema,
  type DiscoveredPage,
} from '@/lib/api/schemas/pages';
import { reportError } from '@/lib/report-error';
import {
  findTimezoneEntry,
  getTimezoneCurrentTime,
  getTimezoneUtcOffset,
} from '@/lib/timezones';
import { getUserInitials } from '@/lib/user-initials';
import { formatFollowersUpdatedAt } from '@/lib/format-followers-updated-at';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { cn } from '@/lib/utils';
import { FeatureCapText, useFeatureCap } from '@/components/billing/feature-cap';

// The Pages timezone picker loads on demand, not in the ADU hub
// page's first-load bundle: the picker component is only needed
// once a user opens it on step 4 (same as the Pages Add Page modal).
// The collapsed summary below reads the timezone registry helpers
// statically — a small table — so the selected zone is visible
// without opening the picker.
const SelectTimezoneStep = dynamic(() =>
  import('@/components/pages/add-page-schedule-steps').then((m) => m.SelectTimezoneStep)
);

/**
 * Posting timezone, collapsed by default: a prominent summary of the
 * selected zone (city · country, IANA, UTC offset, current local time)
 * with a Change button that expands the Pages searchable picker inline
 * below it. The picker itself is unchanged — only its visibility.
 * Picking a zone closes the picker and updates the summary; closing
 * without picking keeps the previous selection. Each instance keeps
 * its own open state, so per-page cards open independently.
 */
function AduTimezoneField({
  timezone,
  searchQuery,
  onSearchChange,
  onSelectTimezone,
  testIdPrefix,
}: Readonly<{
  timezone: string;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onSelectTimezone: (iana: string) => void;
  testIdPrefix: string;
}>) {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const entry = findTimezoneEntry(timezone);
  const currentTime = getTimezoneCurrentTime(timezone);
  const closePicker = () => {
    setPickerOpen(false);
    onSearchChange('');
  };
  return (
    <div>
      <div
        data-testid={`${testIdPrefix}-summary`}
        className="flex items-center justify-between gap-3 rounded-md border p-3"
      >
        <div className="min-w-0">
          <p className="font-medium">Posting Timezone</p>
          <p className="text-body font-semibold">
            {entry.city} · {entry.country}
          </p>
          <p className="text-metadata text-ink-sub">
            {entry.iana} · {getTimezoneUtcOffset(timezone)}
            {currentTime ? ` · ${currentTime}` : ''}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          data-testid={`${testIdPrefix}-change-btn`}
          onClick={() => (pickerOpen ? closePicker() : setPickerOpen(true))}
        >
          {pickerOpen ? 'Close' : 'Change'}
        </Button>
      </div>
      {pickerOpen ? (
        <div className="mt-2">
          <SelectTimezoneStep
            selectedTimezone={timezone}
            timezoneSearchQuery={searchQuery}
            onTimezoneSearchChange={onSearchChange}
            onSelectTimezone={(iana) => {
              onSelectTimezone(iana);
              closePicker();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One fixed posting time, the Pages treatment: the narrowed time
 * input, the 12-hour preview underneath, and the duplicate warning
 * when another time in the same set is equal. Shared by the shared
 * schedule and the per-page cards — the Pages per-slot card with
 * Add/Remove does not apply here (the count comes from Posts Per
 * Day), so only the time field itself is reused.
 */
function AduFixedTimeField({
  value,
  isDuplicate,
  onChange,
  testId,
}: Readonly<{
  value: string;
  isDuplicate: boolean;
  onChange: (value: string) => void;
  testId: string;
}>) {
  // A cleared or invalid time previews nothing: showing 09:00 AM for
  // an empty field would be a fake time. (Same rule as the Pages
  // posting-times step.)
  const isValidTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const preview = isValidTime ? formatSlotDisplay(value) : null;
  return (
    <div>
      <Input
        type="time"
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Time of day"
        className="w-44"
      />
      <div className="mt-1 text-metadata text-ink-sub">
        {preview ? `Posts will go out at ${preview.time12} ${preview.ampm}.` : 'Choose a time.'}
      </div>
      {isDuplicate ? (
        <div className="mt-1 text-metadata text-signal-critical">
          Choose a different time for each posting time.
        </div>
      ) : null}
    </div>
  );
}

const STATUS_OPTIONS = ADU_STATUS_FILTER_OPTIONS;
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
  /** Spec 162: last successful follower check (daily worker or ADU
   *  creation); null when no check has ever stamped it. */
  followersUpdatedAt: string | null;
  /** Posting timezone — the "Updated" line renders in this zone. */
  timezone: string;
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

export interface AduHubStats {
  totalPages: number;
  followersGained: number;
  totalFollowers: number;
}

const EMPTY_ADU_HUB_STATS: AduHubStats = { totalPages: 0, followersGained: 0, totalFollowers: 0 };

/**
 * Hub list fetch (F5/F6): one page of configs for the current filters.
 * Passes `stats=none` so the stats half of the response is skipped once
 * Stream A implements the split — and reads nothing but configs /
 * totalPages / migrationMissing, so the combined pre-split response
 * (which still carries `stats`) is equally fine. The React Query
 * `signal` aborts the fetch when the key changes or the component
 * unmounts, so a superseded request can never resolve over a newer one.
 */
async function fetchAduHubList(
  subdomain: string,
  params: { q: string; status: string; sort: string; page: number },
  signal: AbortSignal,
): Promise<{ configs: AduConfigView[]; totalPages: number; migrationMissing: boolean }> {
  const query = new URLSearchParams({
    q: params.q,
    status: params.status,
    sort: params.sort,
    page: String(params.page),
    stats: 'none',
  });
  const response = await fetch(
    `${buildTenantApiPath(subdomain, '/auto-download-upload')}?${query}`,
    { signal },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Failed to load pages.');
  return {
    configs: body.configs ?? [],
    totalPages: body.totalPages ?? 0,
    migrationMissing: Boolean(body.migrationMissing),
  };
}

/**
 * Hub stats fetch (F6): the same filters, no page, no sort — the key
 * never changes on a pure page turn, so a page turn never refetches
 * stats. Passes `stats=only` for Stream A's split route and reads
 * `response.stats` only; pre-split the server ignores the unknown
 * param and returns the combined response, whose configs are ignored
 * here. A stats failure falls back to zeros (the old stats-RPC-failure
 * path) and never blanks the page.
 */
async function fetchAduHubStats(
  subdomain: string,
  params: { q: string; status: string },
  signal: AbortSignal,
): Promise<AduHubStats> {
  const query = new URLSearchParams({ q: params.q, status: params.status, stats: 'only' });
  const response = await fetch(
    `${buildTenantApiPath(subdomain, '/auto-download-upload')}?${query}`,
    { signal },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'Failed to load pages.');
  return body.stats ?? EMPTY_ADU_HUB_STATS;
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
function AduPageCard({ config, subdomain, hubSearch }: { config: AduConfigView; subdomain: string; hubSearch: string }) {
  const [failedAvatarUrl, setFailedAvatarUrl] = React.useState<string | null>(null);
  const router = useRouter();
  const queryClient = useQueryClient();

  const kind = getAduStatusMarkKind(config.displayStatus);
  const ringClass = ADU_RING_CLASSES[kind];
  const addedDate = formatAduAddedDate(config.createdAt);
  const initials = getUserInitials(config.destinationName);
  const showAvatarImg =
    Boolean(config.destinationAvatarUrl) &&
    failedAvatarUrl !== config.destinationAvatarUrl;
  // Return-links state (pagination step 3): the card carries the hub's
  // current query through to the detail URL, so the detail page's
  // breadcrumb / "Back to Hub" links can re-attach it. `hubSearch` is
  // already serialised with defaults omitted, so an unfiltered page-1
  // hub still links to a bare detail URL.
  const targetHref = `/tenant/${subdomain}/auto-download-upload/${config.id}${hubSearch ? `?${hubSearch}` : ''}`;

  // Followers semantics, verified from code: `adu_hub_stats` sums
  // `current_followers` as the total and `current_followers minus
  // starting_followers` (floored at 0) as the net growth — so
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

  // Client navigation, not a full document reload: `router.push` is
  // the same client-side navigation a Next <Link> performs (same
  // router, shell/sidebar/topbar/QueryClient survive). A <Link>
  // outer element is impossible for this card — it contains a real
  // source <a target="_blank">, and an <a> nested in an <a> is
  // split apart by the HTML parser when the SSR HTML is parsed, so
  // hydration would mismatch in production (the same reason
  // page-card.tsx uses a div + activation handler).
  const handleActivate = (e?: React.SyntheticEvent) => {
    if (e && isLinkEventTarget(e)) return;
    router.push(targetHref);
  };

  // Bounded hover prefetch (pagination step 2): one data query per
  // hover — the detail config under the key Stream C's detail query
  // will read — fired at most once per card mount, and skipped when
  // the key is already cached. This is a data prefetch, not RSC
  // prefetching: no Link is rendered here (see handleActivate), so no
  // blanket prefetch storm is possible.
  const prefetchedDetailRef = React.useRef(false);
  const prefetchDetail = React.useCallback(() => {
    if (prefetchedDetailRef.current) return;
    prefetchedDetailRef.current = true;
    if (queryClient.getQueryData(['adu-detail', config.id])) return;
    void queryClient.prefetchQuery({
      queryKey: ['adu-detail', config.id],
      queryFn: async ({ signal }) => {
        const response = await fetch(
          buildTenantApiPath(subdomain, `/auto-download-upload/${config.id}`),
          { signal },
        );
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? 'Page not found.');
        return body.config;
      },
      staleTime: 30_000,
    });
  }, [queryClient, config.id, subdomain]);

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
      onMouseEnter={prefetchDetail}
      onFocus={prefetchDetail}
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
          {(() => {
            // Spec 162: when the stored total was last updated
            // (daily worker or ADU creation), in the posting
            // timezone. Nothing renders when no check has ever
            // stamped it — never a faked time.
            const updated = formatFollowersUpdatedAt(
              config.followersUpdatedAt,
              config.timezone
            );
            return updated ? (
              <span
                data-testid="adu-page-followers-updated"
                className="mt-0.5 block truncate text-metadata text-ink-dim"
              >
                Updated {updated}
              </span>
            ) : null;
          })()}
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
          labels below, in Pending / Posted / Failed order. */}
      <div aria-hidden className="pt-3">
        <div className="border-t border-line" />
      </div>
      <div
        data-testid="adu-page-pending-counts"
        className="mt-3 grid grid-cols-3 gap-4"
      >
        <span
          data-testid="adu-page-pending-stat"
          className="flex flex-col items-center text-center"
        >
          <span
            data-testid="adu-page-pending-count"
            className="text-xxl font-bold tabular-nums text-signal-queued"
          >
            {config.pendingCount.toLocaleString('en-US')}
          </span>
          <span className="mt-1 text-metadata text-ink-sub">Pending</span>
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

export interface AduHubUrlState {
  q: string;
  status: string;
  sort: string;
  page: number;
}

const ADU_HUB_DEFAULT_STATUS = 'All Statuses';
const ADU_HUB_DEFAULT_SORT = 'Newest First';

/**
 * URL state (pagination step 1): `?q=&status=&sort=&page=` is the
 * hub's filter state, so Back from a detail page returns to the same
 * page, search and sort — and a page-2 link is shareable and
 * refresh-safe. Invalid values fall back to defaults, never a 404.
 */
export function resolveAduHubSearchParams(searchParams: URLSearchParams): AduHubUrlState {
  const q = searchParams.get('q') ?? '';
  const rawStatus = searchParams.get('status') ?? ADU_HUB_DEFAULT_STATUS;
  const status = (STATUS_OPTIONS as readonly string[]).includes(rawStatus)
    ? rawStatus
    : ADU_HUB_DEFAULT_STATUS;
  const rawSort = searchParams.get('sort') ?? ADU_HUB_DEFAULT_SORT;
  const sort = (SORT_OPTIONS as readonly string[]).includes(rawSort)
    ? rawSort
    : ADU_HUB_DEFAULT_SORT;
  const rawPage = Number.parseInt(searchParams.get('page') ?? '', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  return { q, status, sort, page };
}

/** Serialises hub state back to the URL; defaults are omitted so the
 *  clean hub URL stays bare. */
function buildAduHubSearchParams(state: AduHubUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.q !== '') params.set('q', state.q);
  if (state.status !== ADU_HUB_DEFAULT_STATUS) params.set('status', state.status);
  if (state.sort !== ADU_HUB_DEFAULT_SORT) params.set('sort', state.sort);
  if (state.page > 1) params.set('page', String(state.page));
  return params;
}

function AduHubPageInner({ subdomain }: { subdomain: string }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();

  // Filter/page state is seeded from the URL once at mount; later URL
  // changes flow through the adopt effect below, not this initializer.
  const initial = React.useMemo(() => resolveAduHubSearchParams(searchParams), []);
  // The last filter/page state the user chose (detail-page `?tab=`
  // pattern): handlers update it synchronously with the state, so the
  // adopt effect can tell a popstate apart from our own URL write.
  const intendedRef = React.useRef<AduHubUrlState>(initial);
  const [searchQuery, setSearchQuery] = React.useState(initial.q);
  const [statusFilter, setStatusFilter] = React.useState<string>(initial.status);
  const [sort, setSort] = React.useState<string>(initial.sort);
  const [page, setPage] = React.useState(initial.page);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  // Plan cap: the Add Page button disables at the cap, and the
  // ADU create route enforces the same cap server-side.
  const { cap: facebookCap } = useFeatureCap(subdomain, 'facebook');

  // Search runs on the debounced input (~300 ms, F4): the toolbar
  // input itself stays immediate, but no list request fires per
  // keystroke. Clearing to '' applies immediately (hook design).
  const debouncedSearch = useDebouncedValue(searchQuery, 300);
  const debouncedQuery = debouncedSearch.trim();

  // Back/forward navigation: when the URL's query string changes
  // without a click (popstate), adopt it — so Back from a detail
  // page returns to the same page, search, sort and status. The
  // guard is the intent ref: a URL that already matches what the
  // user last chose (including our own replace, below) is ignored,
  // so the adopt and the write can never chase each other.
  React.useEffect(() => {
    const next = resolveAduHubSearchParams(searchParams);
    const intended = intendedRef.current;
    if (
      next.q === intended.q &&
      next.status === intended.status &&
      next.sort === intended.sort &&
      next.page === intended.page
    ) {
      return;
    }
    intendedRef.current = next;
    setSearchQuery(next.q);
    setStatusFilter(next.status);
    setSort(next.sort);
    setPage(next.page);
  }, [searchParams]);

  // Every filter/page change goes through here: state + intent ref +
  // URL, in the same handler tick. Writing the URL in the handler
  // (not in an effect) is what keeps the adopt effect from seeing a
  // stale URL and reverting the change it just made — the detail
  // page's `?tab=` handler does the same. Replace, never push: a
  // filter keystroke is not a history entry.
  const updateHubState = React.useCallback(
    (patch: Partial<AduHubUrlState>) => {
      const next: AduHubUrlState = {
        q: searchQuery,
        status: statusFilter,
        sort,
        page,
        ...patch,
      };
      intendedRef.current = next;
      setSearchQuery(next.q);
      setStatusFilter(next.status);
      setSort(next.sort);
      setPage(next.page);
      const serialized = buildAduHubSearchParams(next).toString();
      if (serialized !== searchParams.toString()) {
        router.replace(serialized ? `?${serialized}` : '?', { scroll: false });
      }
    },
    [router, searchParams, searchQuery, statusFilter, sort, page],
  );

  // F5: the hub list is a React Query entry on the shell's client —
  // keyed by every filter + page, `keepPreviousData` so a page turn
  // renders over the previous page instead of blanking, staleTime
  // 60 s (the shared reference default, named here). An earlier
  // response can only populate its own key's cache entry, never the
  // current key's data — the F4 stale-response race is gone by
  // construction. The list query ignores `body.stats` (see F6).
  const listQuery = useQuery({
    queryKey: ['adu-hub', subdomain, debouncedQuery, statusFilter, sort, page],
    queryFn: ({ signal }) =>
      fetchAduHubList(subdomain, { q: debouncedQuery, status: statusFilter, sort, page }, signal),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  // F6: stats are their own query — same filters, no page, no sort —
  // with a 5-minute staleTime, so a pure page turn never refetches
  // them. Reads `response.stats` only; pre-split the server returns
  // the combined response and its configs are ignored here.
  const statsQuery = useQuery({
    queryKey: ['adu-hub-stats', subdomain, debouncedQuery, statusFilter],
    queryFn: ({ signal }) =>
      fetchAduHubStats(subdomain, { q: debouncedQuery, status: statusFilter }, signal),
    staleTime: 300_000,
  });

  const configs = listQuery.data?.configs ?? [];
  const totalPages = listQuery.data?.totalPages ?? 0;
  const migrationMissing = listQuery.data?.migrationMissing ?? false;
  // The hub query the cards carry through to the detail page
  // (pagination step 3): serialised from live state, defaults omitted.
  const hubSearch = buildAduHubSearchParams({ q: searchQuery, status: statusFilter, sort, page }).toString();
  const stats = statsQuery.data ?? EMPTY_ADU_HUB_STATS;
  // `isPending` is true only while no data exists at all: a page turn
  // serves placeholder data, so the list never blanks mid-flight.
  const loading = listQuery.isPending;
  const error = listQuery.isError
    ? (listQuery.error instanceof Error ? listQuery.error.message : 'Failed to load pages.')
    : null;
  // Page buttons disable while a load is in flight (step 7).
  const isFetchingPage = listQuery.isFetching;

  const hasActiveFilter = debouncedQuery !== '' || statusFilter !== ADU_HUB_DEFAULT_STATUS;

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
        <Input type="search" aria-label="Search pages or sources" placeholder="Search pages or sources…" value={searchQuery} onChange={(e) => updateHubState({ q: e.target.value, page: 1 })} className="min-w-55 flex-1 sm:max-w-80" />
        <Select value={statusFilter} onValueChange={(v) => updateHubState({ status: v, page: 1 })}>
          <SelectTrigger aria-label="Filter by status"><SelectValue /></SelectTrigger>
          <SelectContent>{STATUS_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => updateHubState({ sort: v, page: 1 })}>
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
          <EmptyState type="no-results" title="No pages match your search or filters." action={<Button type="button" variant="outline" onClick={() => updateHubState({ q: '', status: 'All Statuses', page: 1 })}>Clear filters</Button>} />
        ) : (
          <EmptyState type="first-use" title="No pages found" description="Connect a Facebook account and add your first page to start automation." />
        )
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {configs.map((config) => (
              <AduPageCard key={config.id} config={config} subdomain={subdomain} hubSearch={hubSearch} />
            ))}
          </div>
          {totalPages > 1 ? (
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" disabled={page <= 1 || isFetchingPage} onClick={() => updateHubState({ page: page - 1 })}>Previous</Button>
              <span className="text-body text-ink-sub">Page {page} of {totalPages}</span>
              <Button type="button" variant="outline" disabled={page >= totalPages || isFetchingPage} onClick={() => updateHubState({ page: page + 1 })}>Next</Button>
            </div>
          ) : null}
        </>
      )}

      <AddPageDialog
        subdomain={subdomain}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        // F12: one load per create. The old code did setPage(1) AND
        // an explicit load() — if not already on page 1 the setPage
        // effect fired a second load and the two raced. Now the
        // invalidation below is the only refetch trigger: it marks
        // every hub + stats entry stale, so the page-1 query (new key
        // after setPage, or invalidated cache if already on page 1)
        // fires exactly one refetch.
        onCreated={() => {
          setDialogOpen(false);
          updateHubState({ page: 1 });
          void queryClient.invalidateQueries({ queryKey: ['adu-hub', subdomain] });
          void queryClient.invalidateQueries({ queryKey: ['adu-hub-stats', subdomain] });
        }}
      />
    </div>
  );
}

/**
 * `useSearchParams` requires a Suspense boundary for prerendering, so
 * the URL-syncing inner component sits behind one. The route wrapper
 * itself is untouched (detail-page pattern).
 */
export function AduHubPage({ subdomain }: { subdomain: string }) {
  return (
    <React.Suspense fallback={<p className="text-body text-ink-sub">Loading pages…</p>}>
      <AduHubPageInner subdomain={subdomain} />
    </React.Suspense>
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
 * One live-discovered page row in step 2. The key is
 * `${accountId}:${fbPageId}` — a page managed by two selected
 * accounts appears twice, once per account, and a page with no
 * `destinations` row yet has no destination id at all. The
 * `destinationId` (when present) is the `destinations` row for
 * exactly this (account, page) pair — matching by page id alone
 * would be wrong, since one workspace can hold two rows for the
 * same Facebook page id under different accounts.
 */
interface DiscoveredAduRow {
  key: string;
  accountId: string;
  accountName: string;
  fbPageId: string;
  pageName: string;
  profilePictureUrl: string | null;
  category: string | null;
  followers: number;
  destinationId: string | null;
  alreadyAdded: boolean;
}

interface DiscoverEntry {
  status: 'loading' | 'ready' | 'error';
  pages: DiscoveredPage[];
  error: string | null;
  truncated: boolean;
  partial: boolean;
  droppedCount: number;
}

const EMPTY_DISCOVER_ENTRY: DiscoverEntry = {
  status: 'loading',
  pages: [],
  error: null,
  truncated: false,
  partial: false,
  droppedCount: 0,
};

/**
 * Loads one account's pages live from Facebook, through the same
 * typed discover call the Pages picker uses. Mirrors
 * `executeDiscoverPages` in `components/pages/add-page-modal.tsx`:
 * a capped/partial fetch is still a success (its warnings travel
 * with it); a failure is reported, never silent, and carries the
 * user-facing message.
 */
async function executeDiscoverPages(subdomain: string, accountId: string) {
  try {
    const data = await api.get(
      buildTenantApiPath(subdomain, `/accounts/${accountId}/pages/discover?section=adu`),
      { schema: DiscoverPagesResponseSchema },
    );
    return {
      success: true as const,
      pages: data.pages,
      truncated: data.truncated,
      partial: data.partial,
      droppedCount: data.droppedCount,
      error: null,
    };
  } catch (error) {
    reportError(error, { source: 'adu-add-page-discover' });
    return {
      success: false as const,
      pages: [] as DiscoveredPage[],
      truncated: false,
      partial: false,
      droppedCount: 0,
      error:
        isApiError(error) && error.kind === 'http'
          ? "Couldn't load pages from this Facebook account. Please check the account connection and try again."
          : 'An error occurred while loading pages from Facebook. Please try again.',
    };
  }
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
  // Selection is keyed by discovered row (`${accountId}:${fbPageId}`),
  // not by destination id: a page can appear twice (two accounts)
  // and a never-imported page has no destination id yet.
  const [selectedPageKeys, setSelectedPageKeys] = React.useState<string[]>([]);
  const [discoverByAccount, setDiscoverByAccount] = React.useState<Record<string, DiscoverEntry>>({});
  const [sources, setSources] = React.useState<Record<string, { platform: Platform; username: string }>>({});
  const [pasteOpen, setPasteOpen] = React.useState(false);
  const [pasteText, setPasteText] = React.useState('');
  const [pasteFeedback, setPasteFeedback] = React.useState<string | null>(null);
  const [postsPerDay, setPostsPerDay] = React.useState(1);
  const [timezone, setTimezone] = React.useState('Asia/Karachi');
  // Search text for the Pages timezone picker: one query for the
  // shared schedule, one per page for the per-page cards.
  const [timezoneSearchQuery, setTimezoneSearchQuery] = React.useState('');
  const [pageTimezoneSearch, setPageTimezoneSearch] = React.useState<Record<string, string>>({});
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
    setDiscoverByAccount({});
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

  // Step 1 lists ONLY active accounts. Expired / disconnected /
  // error / revoked accounts do not appear at all — no dimmed
  // sections, no Accounts link: a dead token cannot discover pages,
  // so there is nothing to pick for them here.
  const activeAccounts = accounts.filter((a) =>
    a.status !== 'expired' && a.status !== 'disconnected' && a.status !== 'error' && a.status !== 'revoked');
  const filteredAccounts = activeAccounts.filter((a) => a.display_name.toLowerCase().includes(accountSearch.toLowerCase()));
  // "Pages linked" counts ONLY pages linked in ADU itself: the
  // account's destinations that have an `adu_configs` row
  // (computable from the already-loaded `configured` list).
  // Destination status is irrelevant — a disconnected ADU
  // destination is still an ADU link. Pages linked in any other
  // section are never counted here.
  const configuredDestinationIds = React.useMemo(
    () => new Set(configured.map((c) => c.destination_id)),
    [configured],
  );
  const linkedPagesCount = (accountId: string) =>
    pages.filter((p) => p.account_id === accountId && configuredDestinationIds.has(p.id)).length;
  // The `destinations` row for exactly one (account, page) pair —
  // the match chain for "Already added". Keyed by account + page
  // because one workspace can hold two rows for the same Facebook
  // page id under different accounts.
  const destinationByAccountPage = React.useMemo(() => {
    const map = new Map<string, PickerPage>();
    for (const p of pages) map.set(`${p.account_id}:${p.external_destination_id}`, p);
    return map;
  }, [pages]);
  // Step 2 shows ONLY the union of the selected accounts' LIVE
  // discovered pages — never pages of unselected accounts, never
  // the whole list. A page with no `destinations` row appears here
  // for the first time; "Already added" comes from `adu_configs`
  // only, never from discover's workspace-wide `isImported` flag.
  const discoveredRows: DiscoveredAduRow[] = selectedAccountIds.flatMap((accountId) => {
    const entry = discoverByAccount[accountId];
    if (!entry || entry.status !== 'ready') return [];
    const accountName = accounts.find((a) => a.id === accountId)?.display_name ?? '';
    return entry.pages.map((page) => {
      const destination = destinationByAccountPage.get(`${accountId}:${page.fbPageId}`);
      const destinationId = destination?.id ?? null;
      return {
        key: `${accountId}:${page.fbPageId}`,
        accountId,
        accountName,
        fbPageId: page.fbPageId,
        pageName: page.pageName,
        profilePictureUrl: page.profilePictureUrl ?? null,
        category: page.category ?? null,
        followers: page.currentFollowers ?? page.followersCount ?? 0,
        destinationId,
        alreadyAdded: destinationId !== null && configuredDestinationIds.has(destinationId),
      };
    });
  });
  const visibleRows = discoveredRows.filter((row) => row.pageName.toLowerCase().includes(pageSearch.toLowerCase()));
  const selectableRowKeys = discoveredRows.filter((row) => !row.alreadyAdded).map((row) => row.key);
  const allAccountsChecked = activeAccounts.length > 0 && activeAccounts.every((a) => selectedAccountIds.includes(a.id));
  const allPagesChecked = selectableRowKeys.length > 0 && selectableRowKeys.every((key) => selectedPageKeys.includes(key));
  const selectedRows = discoveredRows.filter((row) => selectedPageKeys.includes(row.key));
  const allSourcesFilled = selectedRows.every((row) => (sources[row.key]?.username ?? '').trim() !== '');

  const toggle = (list: string[], id: string, set: (v: string[]) => void) => {
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };

  // Deselecting an account drops its pages from the page selection
  // (and from the step-2 list, which is the union of selected
  // accounts' discovered pages). Re-selecting does not restore them.
  const toggleAccount = (id: string) => {
    const next = selectedAccountIds.includes(id)
      ? selectedAccountIds.filter((x) => x !== id)
      : [...selectedAccountIds, id];
    setSelectedAccountIds(next);
    if (!next.includes(id)) {
      setSelectedPageKeys((prev) => prev.filter((key) => !key.startsWith(`${id}:`)));
    }
  };

  const toggleAllAccounts = () => {
    if (allAccountsChecked) {
      setSelectedAccountIds([]);
      setSelectedPageKeys([]);
    } else {
      setSelectedAccountIds(activeAccounts.map((a) => a.id));
    }
  };

  const toggleAllPages = () => {
    setSelectedPageKeys(allPagesChecked ? [] : selectableRowKeys);
  };

  // Discovers one account's pages live from Facebook, replacing
  // that account's previous result in place. One account's failure
  // never touches another account's pages.
  const startDiscover = (accountIds: string[]) => {
    for (const accountId of accountIds) {
      setDiscoverByAccount((prev) => ({ ...prev, [accountId]: { ...EMPTY_DISCOVER_ENTRY } }));
      void executeDiscoverPages(subdomain, accountId).then((result) => {
        setDiscoverByAccount((prev) => ({
          ...prev,
          [accountId]: result.success
            ? {
                status: 'ready',
                pages: result.pages,
                error: null,
                truncated: result.truncated,
                partial: result.partial,
                droppedCount: result.droppedCount,
              }
            : {
                status: 'error',
                pages: [],
                error: result.error,
                truncated: false,
                partial: false,
                droppedCount: 0,
              },
        }));
      });
    }
  };

  const goToPagesStep = () => {
    setStep(2);
    startDiscover(selectedAccountIds);
  };

  const sourcePlaceholder = (platform: Platform) =>
    platform === 'youtube' ? 'channel_id' : platform === 'facebook' ? 'page_or_user_id' : '@username';

  const applyPaste = () => {
    const parsed = parseAduBulkPaste(pasteText, 'tiktok');
    if (parsed.errors.length > 0) { setPasteFeedback(parsed.errors.join(' ')); return; }
    const empty = selectedRows.filter((row) => !(sources[row.key]?.username ?? '').trim());
    const next = { ...sources };
    let assigned = 0;
    const shuffled = [...parsed.sources].sort(() => Math.random() - 0.5);
    for (const source of shuffled) {
      if (assigned >= empty.length) break;
      const row = empty[assigned];
      if (!row) break;
      next[row.key] = { platform: source.platform, username: source.username };
      assigned += 1;
    }
    setSources(next);
    setPasteFeedback(`${assigned} sources assigned to ${empty.length} empty page slots. ${parsed.warnings.join(' ')}`);
    setPasteOpen(false);
  };

  const submit = async () => {
    setSubmitting(true); setError(null); setResult(null);
    try {
      // 'all' uses the shared schedule below; 'separate' sends one
      // schedule per page. Per-page failures are reported individually.
      if (timingScope === 'separate' && scheduleType === 'fixed') {
        for (const row of selectedRows) {
          const s = pageSchedule(row.key);
          if (s.postingTimes.length !== s.postsPerDay || s.postingTimes.some((t) => !String(t ?? '').trim())) {
            throw new Error(`Fixed posting requires ${s.postsPerDay} posting times for "${row.pageName}".`);
          }
        }
      }
      if (timingScope === 'separate') {
        for (const row of selectedRows) {
          const s = pageSchedule(row.key);
          if (!s.timezone.trim() || !Number.isInteger(s.postsPerDay) || s.postsPerDay < 1 || s.postsPerDay > 12) {
            throw new Error(`Please complete timezone and posts per day for "${row.pageName}".`);
          }
        }
      }
      // A row with a destinations row submits by destination id; a
      // never-imported row submits its discovered reference and the
      // server ensures the row (re-discovering the page and storing
      // its encrypted token) before creating the config.
      const items = selectedRows.map((row) => {
        const base = row.destinationId
          ? { destinationId: row.destinationId }
          : { discovered: { fbPageId: row.fbPageId, accountId: row.accountId } };
        const source = {
          sourcePlatform: sources[row.key]?.platform ?? 'tiktok',
          sourceUsername: sources[row.key]?.username ?? '',
        };
        if (timingScope !== 'separate') return { ...base, ...source };
        const s = pageSchedule(row.key);
        return {
          ...base,
          ...source,
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
      const failedText = (body.failed ?? []).map((f: { destinationId: string; error: string }) => f.error).join(' ');
      // An all-failed batch must name the failures, not just say
      // "could not add" — a dead account token and a missing page
      // need different next steps.
      if (!response.ok && !(body.created ?? []).length) throw new Error(failedText || body.error || 'Could not add these pages.');
      const createdCount = (body.created ?? []).length;
      setResult(`Created ${createdCount} ${createdCount === 1 ? 'page' : 'pages'}.${failedText ? ` Failed: ${failedText}` : ''}`);
      if ((body.failed ?? []).length === 0) onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this page.');
    } finally {
      setSubmitting(false);
    }
  };

  const stepSubtitle =
    step === 1 ? 'Select Accounts' : step === 2 ? 'Select Pages' : step === 3 ? 'Sources' : 'Posting Time';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-dvh overflow-y-auto sm:max-w-135">
        <DialogHeader>
          <DialogTitle>Add New Page</DialogTitle>
          <DialogDescription>Step {step} of 4: {stepSubtitle}</DialogDescription>
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
              </>
            )}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="flex flex-col gap-2">
            {selectedAccountIds.map((accountId) => {
              const entry = discoverByAccount[accountId];
              const name = accounts.find((a) => a.id === accountId)?.display_name ?? '';
              // No entry yet means the discover call is in flight.
              if (!entry || entry.status === 'loading') {
                return (
                  <p
                    key={accountId}
                    data-testid={`adu-discovering-${accountId}`}
                    className="text-body text-ink-sub"
                  >
                    Finding Facebook Pages on {name}…
                  </p>
                );
              }
              if (entry.status === 'error') {
                // K9, per account: a failed discover renders an error
                // + Retry — never the "no pages" empty state next to
                // an error, and never at the expense of the other
                // accounts' pages, which stay listed below.
                return (
                  <div
                    key={accountId}
                    data-testid={`adu-discover-error-${accountId}`}
                    role="alert"
                    className="flex flex-wrap items-center justify-between gap-4 rounded-sm border border-signal-critical/25 bg-signal-critical/10 px-3 py-2"
                  >
                    <span className="text-body text-signal-critical">
                      {name}: {entry.error}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={`adu-discover-retry-${accountId}`}
                      onClick={() => startDiscover([accountId])}
                    >
                      Retry
                    </Button>
                  </div>
                );
              }
              // Completeness notes for a successful-but-incomplete
              // discover, verbatim from the Pages picker: shown above
              // the list so a partial list is never presented as
              // complete. The account name labels whose list the
              // note belongs to.
              if (!entry.truncated && !entry.partial && entry.droppedCount === 0) return null;
              return (
                <div key={accountId} className="flex flex-col gap-2">
                  <p className="text-metadata font-semibold text-ink-sub">{name}</p>
                  {entry.truncated ? (
                    <div
                      data-testid={`adu-discover-truncated-${accountId}`}
                      role="status"
                      className="rounded-sm border border-link/25 bg-link/10 px-3 py-2 text-body leading-body text-ink"
                    >
                      Only the first 500 pages from this account are shown —
                      this account has more pages on Facebook, so the list
                      below may not include every page.
                    </div>
                  ) : null}
                  {entry.partial ? (
                    <div
                      data-testid={`adu-discover-partial-${accountId}`}
                      role="status"
                      className="flex flex-wrap items-center justify-between gap-4 rounded-sm border border-link/25 bg-link/10 px-3 py-2 text-body leading-body text-ink"
                    >
                      <span>
                        Some pages couldn&apos;t be loaded from Facebook, so
                        this list may be incomplete.
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-testid={`adu-discover-retry-${accountId}`}
                        onClick={() => startDiscover([accountId])}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null}
                  {entry.droppedCount > 0 ? (
                    <div
                      data-testid={`adu-discover-dropped-${accountId}`}
                      role="status"
                      className="rounded-sm border border-link/25 bg-link/10 px-3 py-2 text-body leading-body text-ink"
                    >
                      {entry.droppedCount}{' '}
                      {entry.droppedCount === 1 ? 'item' : 'items'} from Facebook
                      {entry.droppedCount === 1 ? ' was' : ' were'} left out —{' '}
                      {entry.droppedCount === 1 ? 'it had' : 'they had'} no category
                      or page tasks, so {entry.droppedCount === 1 ? 'it may' : 'they may'}{' '}
                      not be a page.
                    </div>
                  ) : null}
                </div>
              );
            })}
            {discoveredRows.length > 0 ? (
              <>
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
                      {discoveredRows.length} {discoveredRows.length === 1 ? 'page found' : 'pages found'}
                    </span>
                    {selectableRowKeys.length > 0 ? (
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
                  {visibleRows.map((row) => {
                    const checked = row.alreadyAdded || selectedPageKeys.includes(row.key);
                    const isSelected = !row.alreadyAdded && checked;
                    return (
                      <label
                        key={row.key}
                        data-testid={`adu-page-row-${row.accountId}-${row.fbPageId}`}
                        className={cn(
                          'flex items-center gap-4 rounded-xs border-b border-line px-3 py-2.5 transition-colors',
                          isSelected ? 'bg-subtle' : 'bg-transparent',
                          row.alreadyAdded ? 'cursor-default opacity-60' : 'cursor-pointer hover:bg-hover'
                        )}
                      >
                        <Checkbox
                          data-testid={`adu-page-checkbox-${row.accountId}-${row.fbPageId}`}
                          checked={checked}
                          disabled={row.alreadyAdded}
                          onCheckedChange={() => {
                            if (!row.alreadyAdded) {
                              toggle(selectedPageKeys, row.key, setSelectedPageKeys);
                            }
                          }}
                        />
                        <PickerAvatar url={row.profilePictureUrl} name={row.pageName} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body font-semibold text-ink">{row.pageName}</span>
                          <span className="mt-0.5 block truncate text-metadata text-ink-sub">
                            {row.category ?? 'Facebook Page'} • {row.followers.toLocaleString('en-US')} followers
                          </span>
                          <span className="mt-0.5 block truncate text-metadata text-ink-sub">
                            via {row.accountName}
                          </span>
                        </span>
                        {row.alreadyAdded ? (
                          <span className="shrink-0 text-metadata font-medium text-ink-dim">Already added</span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
              </>
            ) : null}
            {discoveredRows.length === 0 &&
            !selectedAccountIds.some((id) => {
              const entry = discoverByAccount[id];
              return !entry || entry.status === 'loading' || entry.status === 'error';
            }) ? (
              <p className="p-6 text-center text-body text-ink-sub">
                No pages on the selected accounts.
              </p>
            ) : null}
            {discoveredRows.length > 0 && visibleRows.length === 0 ? (
              <p className="p-6 text-center text-body text-ink-sub">
                No pages match your search.
              </p>
            ) : null}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="font-medium">Sources</h3>
              <p className="text-body text-ink-sub">Sources are assigned to the pages you picked.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => setPasteOpen(true)}>Paste sources (random assign)</Button>
              </div>
              {pasteFeedback ? <p className="text-body text-ink-sub">{pasteFeedback}</p> : null}
              {pasteOpen ? (
                <div className="mt-2 flex flex-col gap-2 rounded-md border p-3">
                  <p className="text-body">One source per line, platform|username — for example instagram|ronaldo, facebook|messi. Sources are assigned randomly to empty page slots.</p>
                  <Textarea rows={6} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder={'instagram|ronaldo\nfacebook|messi'} />
                  <div className="flex gap-2">
                    <Button type="button" onClick={applyPaste}>Apply assignment</Button>
                    <Button type="button" variant="outline" onClick={() => setPasteOpen(false)}>Cancel</Button>
                  </div>
                </div>
              ) : null}
              <div className="mt-2 flex flex-col gap-2">
                {selectedRows.map((row) => (
                  <div key={row.key} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                    <span className="min-w-0 flex-1 truncate">{row.pageName}</span>
                    <Select value={sources[row.key]?.platform ?? 'tiktok'} onValueChange={(v) => setSources({ ...sources, [row.key]: { platform: v as Platform, username: sources[row.key]?.username ?? '' } })}>
                      <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                      <SelectContent>{PLATFORMS.map((p) => <SelectItem key={p} value={p} disabled={p === 'instagram'}>{p}</SelectItem>)}</SelectContent>
                    </Select>
                    <Input placeholder={sourcePlaceholder(sources[row.key]?.platform ?? 'tiktok')} value={sources[row.key]?.username ?? ''} onChange={(e) => setSources({ ...sources, [row.key]: { platform: sources[row.key]?.platform ?? 'tiktok', username: e.target.value } })} className="w-48" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="flex flex-col gap-4">
            <div>
              <h3 className="font-medium">Posting Time</h3>
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
                    <Select value={String(postsPerDay)} onValueChange={(v) => {
                      const n = Number(v);
                      setPostsPerDay(n);
                      setFixedTimes(Array.from({ length: n }, (_, i) => fixedTimes[i] ?? '09:00'));
                    }}>
                      <SelectTrigger id="adu-posts-per-day" data-testid="adu-posts-per-day-select">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 12 }, (_, i) => (
                          <SelectItem key={i + 1} value={String(i + 1)}>{i + 1}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="mt-2">
                    <AduTimezoneField
                      timezone={timezone}
                      searchQuery={timezoneSearchQuery}
                      onSearchChange={setTimezoneSearchQuery}
                      onSelectTimezone={setTimezone}
                      testIdPrefix="adu-timezone"
                    />
                  </div>
                  {scheduleType === 'dailyrandom' ? (
                    <p className="mt-2 text-body text-ink-sub">Balanced random times will be automatically generated upon saving.</p>
                  ) : (
                    <div className="mt-2 flex flex-col gap-2">
                      <p className="text-body">One time per post, per day:</p>
                      {Array.from({ length: postsPerDay }, (_, i) => (
                        <AduFixedTimeField
                          key={i}
                          value={fixedTimes[i] ?? '09:00'}
                          isDuplicate={fixedTimes.filter((t) => t === (fixedTimes[i] ?? '09:00')).length > 1}
                          onChange={(value) => {
                            const next = [...fixedTimes]; next[i] = value; setFixedTimes(next);
                          }}
                          testId={`adu-fixed-time-${i}`}
                        />
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  {scheduleType === 'dailyrandom' ? (
                    <p className="mt-2 text-body text-ink-sub">Balanced random times will be automatically generated upon saving.</p>
                  ) : null}
                  <div className="mt-2 flex max-h-80 flex-col gap-2 overflow-y-auto pr-2">
                    {selectedRows.map((row) => {
                      const s = pageSchedule(row.key);
                      const label = `${row.pageName} · ${row.accountName}`;
                      const times = ensureTimesLength(s.postingTimes, s.postsPerDay);
                      return (
                        <div key={`schedule-${row.key}`} className="flex flex-col gap-3 rounded-lg border p-3">
                          <p className="text-body font-semibold">{label}</p>
                          <div>
                            <label className="font-medium" htmlFor={`adu-bulk-${row.key}-posts-per-day`}>Posts Per Day</label>
                            <Select value={String(s.postsPerDay)} onValueChange={(v) => {
                              const n = Number(v);
                              updatePageSchedule(row.key, {
                                postsPerDay: n,
                                postingTimes: scheduleType === 'fixed' ? ensureTimesLength(s.postingTimes, n) : [],
                              });
                            }}>
                              <SelectTrigger id={`adu-bulk-${row.key}-posts-per-day`} data-testid={`adu-posts-per-day-select-${row.key}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {Array.from({ length: 12 }, (_, i) => (
                                  <SelectItem key={i + 1} value={String(i + 1)}>{i + 1}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <AduTimezoneField
                              timezone={s.timezone}
                              searchQuery={pageTimezoneSearch[row.key] ?? ''}
                              onSearchChange={(value) => setPageTimezoneSearch((prev) => ({ ...prev, [row.key]: value }))}
                              onSelectTimezone={(iana) => updatePageSchedule(row.key, { timezone: iana })}
                              testIdPrefix={`adu-timezone-${row.key}`}
                            />
                          </div>
                          {scheduleType === 'fixed' ? (
                            <div className="flex flex-col gap-2">
                              <p className="text-body">Fixed Posting Times</p>
                              {times.map((time, index) => (
                                <AduFixedTimeField
                                  key={index}
                                  value={time}
                                  isDuplicate={times.filter((t) => t === time).length > 1}
                                  onChange={(value) => {
                                    const next = ensureTimesLength(s.postingTimes, s.postsPerDay);
                                    next[index] = value;
                                    updatePageSchedule(row.key, { postingTimes: next });
                                  }}
                                  testId={`adu-fixed-time-${row.key}-${index}`}
                                />
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

          </div>
        ) : null}

        <DialogFooter>
          {step === 1 ? (
            <Button
              type="button"
              data-testid="adu-accounts-next-btn"
              disabled={selectedAccountIds.length === 0}
              onClick={goToPagesStep}
            >
              Next
            </Button>
          ) : step === 2 ? (
            <>
              <Button type="button" variant="outline" data-testid="adu-pages-back-btn" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button
                type="button"
                data-testid="adu-pages-next-btn"
                disabled={selectedPageKeys.length === 0}
                onClick={() => setStep(3)}
              >
                Next
              </Button>
            </>
          ) : step === 3 ? (
            <>
              <Button type="button" variant="outline" data-testid="adu-sources-back-btn" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button
                type="button"
                data-testid="adu-sources-next-btn"
                disabled={!allSourcesFilled}
                onClick={() => setStep(4)}
              >
                Next
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" data-testid="adu-posting-back-btn" onClick={() => setStep(3)}>
                Back
              </Button>
              <Button
                type="button"
                disabled={submitting || !allSourcesFilled || (timingScope === 'separate' && !selectedRows.every((row) => pageScheduleComplete(row.key)))}
                onClick={() => void submit()}
              >
                Start Automation
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
