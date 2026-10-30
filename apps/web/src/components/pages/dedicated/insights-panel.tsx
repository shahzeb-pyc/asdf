'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import {
  ChartColumnIcon,
  GlobeIcon,
  HeartIcon,
  MinusIcon,
  PercentIcon,
  PlayIcon,
  RefreshCwIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  UserCheckIcon,
  UsersIcon,
} from 'lucide-react';

import {
  PageInsightsResponseSchema,
  type PageInsightsRange,
  type PageInsightsResponse,
} from '@fbuploadpro/contracts';
import { Banner } from '@/components/shared/ui/banner';
import { Button } from '@/components/shared/ui/button';
import { Card } from '@/components/shared/ui/card';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Skeleton } from '@/components/shared/ui/skeleton';
import {
  readCachedInsights,
  writeCachedInsights,
} from '@/lib/insights/insights-local-cache';
import { insightsWindow } from '@/lib/insights/page-insights';
import type { FacebookPageItem } from '../page-card';

const InsightsChart = dynamic(
  () => import('./insights-chart').then((m) => m.InsightsChart),
  { ssr: false },
);

export interface PageTabInsightsProps {
  page: Pick<FacebookPageItem, 'id'>;
  subdomain: string;
  /** Page timezone (K3): window + trend labels follow it, not UTC. */
  pageTimezone?: string;
}

const RANGES: Array<{ value: PageInsightsRange; label: string }> = [
  { value: '7d', label: '7D' },
  { value: '14d', label: '14D' },
  { value: '28d', label: '28D' },
  { value: '90d', label: '90D' },
];

const REACTION_LABELS: Record<string, string> = {
  like: 'Like',
  love: 'Love',
  wow: 'Wow',
  haha: 'Haha',
  sad: 'Sad',
  angry: 'Angry',
};

const REACTION_EMOJI: Record<string, string> = {
  like: '👍',
  love: '❤️',
  wow: '😮',
  haha: '😂',
  sad: '😢',
  angry: '😡',
};

const REACTION_TONES: Record<string, 'gold' | 'emerald' | 'rose' | 'bronze' | 'peru' | 'critical'> = {
  like: 'gold',
  love: 'rose',
  wow: 'bronze',
  haha: 'emerald',
  sad: 'peru',
  angry: 'critical',
};

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatSigned(value: number): string {
  if (value > 0) return `+${value.toLocaleString()}`;
  return value.toLocaleString();
}

function formatWatchTime(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Actual date + time of the last fetch, in the app's "12 Oct 2026" style. */
function formatFetchedAt(fetchedAt: string): string {
  const date = new Date(fetchedAt);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** K3: trend dates are calendar dates in the page timezone, so their
 * labels render in that zone — never UTC. The date is already a
 * zone-local calendar day; formatting it at noon UTC in the page
 * zone cannot shift it across a boundary. */
function formatDayMonth(iso: string, timeZone: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }).format(date);
}

function formatDayMonthYear(iso: string, timeZone: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone,
  }).format(date);
}

/** "1 Oct – 27 Oct 2026" for a window of daily ISO dates (oldest first). */
function formatRangeLabel(dates: string[], timeZone: string): string {
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return '';
  if (first === last) return formatDayMonthYear(last, timeZone);
  const firstYear = first.slice(0, 4);
  const lastYear = last.slice(0, 4);
  return `${firstYear === lastYear ? formatDayMonth(first, timeZone) : formatDayMonthYear(first, timeZone)} – ${formatDayMonthYear(last, timeZone)}`;
}

function isFirstUse(data: PageInsightsResponse): boolean {
  return (
    data.kpis.followers === 0 &&
    data.kpis.mediaViews === 0 &&
    data.kpis.engagements === 0 &&
    data.trend.every((p) => p.views === 0 && p.viewers === 0)
  );
}

/** A fetch succeeded but nothing happened in the range (followers may be > 0). */
function isAllZeroActivity(data: PageInsightsResponse): boolean {
  return (
    data.kpis.mediaViews === 0 &&
    data.kpis.uniqueViewersDailySum === 0 &&
    data.kpis.engagements === 0 &&
    data.trend.every((p) => p.views === 0 && p.viewers === 0) &&
    data.reactions.every((r) => r.count === 0)
  );
}

/**
 * Share-bar widths in 5% steps. Inline styles are banned by the
 * regression guardrails (inline-style ratchet), so the bar width comes
 * from token-backed fraction utilities (Tailwind v4 resolves any
 * fraction dynamically); the exact percentage is still shown as text
 * next to the bar, so quantizing the bar itself loses no information.
 */
const SHARE_BAR_WIDTHS = [
  'w-0',
  'w-1/20',
  'w-1/10',
  'w-3/20',
  'w-1/5',
  'w-1/4',
  'w-3/10',
  'w-7/20',
  'w-2/5',
  'w-9/20',
  'w-1/2',
  'w-11/20',
  'w-3/5',
  'w-13/20',
  'w-7/10',
  'w-3/4',
  'w-4/5',
  'w-17/20',
  'w-9/10',
  'w-19/20',
  'w-full',
] as const;

function ShareBar({
  sharePct,
  tone,
}: Readonly<{
  sharePct: number;
  tone: 'gold' | 'emerald' | 'rose' | 'bronze' | 'peru' | 'critical';
}>): React.ReactElement {
  const barClass =
    tone === 'emerald'
      ? 'bg-brand-emerald'
      : tone === 'rose'
        ? 'bg-signal-critical'
        : tone === 'bronze'
          ? 'bg-brand-bronze'
          : tone === 'peru'
            ? 'bg-brand-peru'
            : tone === 'critical'
              ? 'bg-signal-critical'
              : 'bg-link';
  const widthClass =
    SHARE_BAR_WIDTHS[Math.min(20, Math.max(0, Math.round(sharePct / 5)))] ?? 'w-0';
  return (
    <span className="h-2 min-w-0 flex-1 rounded-full bg-subtle">
      <span className={`block h-2 rounded-full ${barClass} ${widthClass}`} />
    </span>
  );
}

export function PageTabInsights({ page, subdomain, pageTimezone = 'UTC' }: Readonly<PageTabInsightsProps>): React.ReactElement {
  const [range, setRange] = React.useState<PageInsightsRange>('28d');
  const [data, setData] = React.useState<PageInsightsResponse | null>(null);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [syncing, setSyncing] = React.useState(false);
  // K2: every load() call takes a sequence number; a response is
  // applied ONLY if its number is still the latest. Without this, a
  // slow fetch for range A (or a Sync) that resolves after the user
  // switched to range B overwrote B's data — including a cache hit
  // for B, which the old effect-cleanup flag never guarded because
  // it was checked only before the await, never after. The flag
  // below is checked after every await, in success and in catch.
  const loadIdRef = React.useRef(0);
  // R9: a forced sync (Sync / Retry) that fails while data for the
  // CURRENT range is already on screen must not hide that data —
  // the banner promises it stays available for one hour. `data`
  // in the catch closure would be stale, so a ref tracks it.
  const [syncError, setSyncError] = React.useState(false);
  const dataRef = React.useRef<PageInsightsResponse | null>(null);

  const load = React.useCallback(
    async (targetRange: PageInsightsRange, force: boolean): Promise<void> => {
      // K2: claim this load's sequence number up front; any later
      // load (range switch, Sync) supersedes it, and its response
      // must then be dropped wholesale — cache hits included,
      // because a cache hit for the superseded range is also stale
      // for the range now on screen.
      const myId = ++loadIdRef.current;
      const isCurrent = () => myId === loadIdRef.current;
      if (!force) {
        const cached = readCachedInsights(page.id, targetRange);
        if (cached) {
          if (!isCurrent()) return;
          dataRef.current = cached;
          setData(cached);
          setStatus('ready');
          setSyncError(false);
          return;
        }
      }
      setSyncError(false);
      if (force) setSyncing(true);
      else setStatus('loading');
      try {
        const res = await fetch(
          `/api/tenant/${encodeURIComponent(subdomain)}/pages/${encodeURIComponent(page.id)}/insights?range=${targetRange}`,
        );
        if (!res.ok) throw new Error(`Insights request failed (${res.status})`);
        const json: unknown = await res.json();
        const checked = PageInsightsResponseSchema.safeParse(json);
        if (!checked.success) throw new Error('Insights response failed validation');
        // K2: the stale-range check AFTER the await — this is the
        // line the old code was missing. A losing fetch never
        // writes the cache, the ref, or the state.
        if (!isCurrent()) return;
        writeCachedInsights(checked.data);
        dataRef.current = checked.data;
        setData(checked.data);
        setStatus('ready');
      } catch {
        if (!isCurrent()) return;
        // Forced sync with current-range data on screen: keep the
        // data (status stays 'ready') and show the sync-error banner
        // below. Any other failure — initial load, or a range
        // change whose old data belongs to a different range — is
        // the plain error state with no data shown.
        if (force && dataRef.current !== null) {
          setSyncError(true);
          setStatus('ready');
        } else {
          setStatus('error');
        }
      } finally {
        // Only the current load may clear the spinner: a stale
        // load finishing must not switch off a newer Sync's spinner.
        if (isCurrent()) setSyncing(false);
      }
    },
    [page.id, subdomain],
  );

  React.useEffect(() => {
    void load(range, false);
    // Unmount supersedes the in-flight load, exactly like a range
    // switch does: its response is dropped by the id check.
    return () => {
      loadIdRef.current += 1;
    };
  }, [load, range]);

  const handleSync = (): void => {
    void load(range, true);
  };

  const firstUse = data !== null && isFirstUse(data);
  const allZeroActivity = data !== null && !firstUse && isAllZeroActivity(data);
  const netGrowth = data?.kpis.netFollowerGrowth ?? 0;
  // The loaded trend dates are the window; before any load, the window for
  // the selected range is. Both come from the same window function,
  // in the page timezone (K3).
  const windowDates = React.useMemo(
    () => insightsWindow(range, undefined, pageTimezone).dates,
    [range, pageTimezone],
  );
  const rangeDates = data && data.trend.length > 0 ? data.trend.map((p) => p.date) : windowDates;
  const rangeLabel = formatRangeLabel(rangeDates, pageTimezone);
  const fetchedLabel = data ? formatFetchedAt(data.fetchedAt) : '';

  // Header Sync and empty-state Sync are the same action and styling; each
  // keeps its own test id so the two buttons stay individually addressable.
  const renderSyncButton = (testId: string): React.ReactElement => (
    <Button
      data-testid={testId}
      variant="outline"
      size="lg"
      className="hit-area-44"
      onClick={handleSync}
      disabled={syncing || status === 'loading'}
    >
      <RefreshCwIcon className={syncing ? 'animate-spin' : undefined} />
      {syncing ? 'Syncing…' : 'Sync'}
    </Button>
  );

  return (
    <div data-testid="page-tab-insights" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <p className="text-body text-ink-sub">
            Live from Facebook
            {data && firstUse
              ? ' · No insight data returned'
              : data && fetchedLabel
                ? ` · Updated ${fetchedLabel}`
                : ''}
          </p>
          <p className="text-body text-ink-dim">
            Stored only in this browser for one hour. Sync fetches fresh numbers from Facebook.
          </p>
        </div>
        <div className="flex gap-1 rounded-md border border-line bg-subtle p-1" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <Button
              key={r.value}
              data-testid={`insights-range-${r.value}`}
              variant={range === r.value ? 'default' : 'ghost'}
              size="lg"
              className="hit-area-44"
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </Button>
          ))}
        </div>
        {renderSyncButton('insights-sync-btn')}
      </div>
      {rangeLabel ? (
        <p className="text-body text-ink-sub" aria-label="Selected date range">
          {rangeLabel}
        </p>
      ) : null}

      {status === 'loading' && (
        <div className="flex flex-col gap-6" aria-label="Loading insights">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-70" />
        </div>
      )}

      {status === 'error' && (
        <Banner
          variant="critical"
          title="Couldn't load insights"
          description="Facebook didn't return fresh numbers. Your last loaded data, if any, is still in this browser for one hour."
          action={
            <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
              {syncing ? 'Retrying…' : 'Retry'}
            </Button>
          }
        />
      )}

      {syncError && data && (
        <Banner
          variant="critical"
          title="Couldn't load insights"
          description="Facebook didn't return fresh numbers. Your last loaded data is still in this browser for one hour."
          action={
            <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
              {syncing ? 'Retrying…' : 'Retry'}
            </Button>
          }
        />
      )}

      {status === 'ready' && data && firstUse && (
        <EmptyState
          type="first-use"
          title="No insights yet"
          description="Insights will appear here after your first posts publish."
          className="min-h-[55svh] justify-center"
          icon={<ChartColumnIcon className="h-10 w-10 text-link" aria-hidden />}
          action={renderSyncButton('insights-empty-sync-btn')}
        />
      )}

      {status === 'ready' && data && !firstUse && (
        <>
          <p className="text-body text-ink-sub">
            Followers is the live total. All other cards cover {rangeLabel}.
          </p>
          <div data-testid="insights-kpi-grid" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Card className="p-4">
              <p className="flex items-center gap-2 text-body text-ink-sub">
                <UsersIcon className="h-5 w-5 shrink-0 text-ink" /> Followers
              </p>
              <p className="mt-1 text-xxl font-bold text-ink">{formatCount(data.kpis.followers)}</p>
              <p className="mt-1 text-xs text-ink-dim">Live total</p>
            </Card>
            <Card className="p-4">
              <p className="flex items-center gap-2 text-body text-ink-sub">
                <PlayIcon className="h-5 w-5 shrink-0 text-link" /> Media views
              </p>
              <p className="mt-1 text-xxl font-bold text-ink">{formatCount(data.kpis.mediaViews)}</p>
              <p className="mt-1 text-xs text-ink-dim">In this range</p>
            </Card>
            <Card className="p-4">
              <p className="flex items-center gap-2 text-body text-ink-sub">
                <UserCheckIcon className="h-5 w-5 shrink-0 text-brand-emerald" /> Unique viewers
              </p>
              <p className="mt-1 text-xxl font-bold text-ink">
                {formatCount(data.kpis.uniqueViewersDailySum)}
              </p>
              <p className="mt-1 text-xs text-ink-dim">Sum of daily viewers in this range</p>
            </Card>
            <Card className="p-4">
              <p className="flex items-center gap-2 text-body text-ink-sub">
                <HeartIcon className="h-5 w-5 shrink-0 text-signal-critical" /> Engagements
              </p>
              <p className="mt-1 text-xxl font-bold text-ink">{formatCount(data.kpis.engagements)}</p>
              <p className="mt-1 text-xs text-ink-dim">Reactions, comments and shares in this range</p>
            </Card>
            <Card className="p-4">
              <p className="flex items-center gap-2 text-body text-ink-sub">
                <PercentIcon className="h-5 w-5 shrink-0 text-ink" /> Engagement rate
              </p>
              <p className="mt-1 text-xxl font-bold text-ink">
                {data.kpis.engagementRatePct === null ? 'N/A' : `${data.kpis.engagementRatePct}%`}
              </p>
              <p className="mt-1 text-xs text-ink-dim">
                {data.kpis.engagementRatePct === null
                  ? 'No media views yet in this range'
                  : 'Engagements as a share of media views in this range'}
              </p>
            </Card>
            <Card className="p-4">
              <p className="flex items-center gap-2 text-body text-ink-sub">
                {netGrowth > 0 ? (
                  <TrendingUpIcon className="h-5 w-5 shrink-0 text-signal-operational" />
                ) : netGrowth < 0 ? (
                  <TrendingDownIcon className="h-5 w-5 shrink-0 text-signal-critical" />
                ) : (
                  <MinusIcon className="h-5 w-5 shrink-0 text-ink" />
                )}
                Net follower growth
              </p>
              <p className="mt-1 text-xxl font-bold text-ink">{formatSigned(netGrowth)}</p>
              <p className="mt-1 text-xs text-ink-dim">New follows minus unfollows in this range</p>
            </Card>
          </div>

          <Card className="p-5">
            <p className="text-body font-medium text-ink">Media views &amp; unique viewers</p>
            <p className="text-xs text-ink-dim">
              Daily · {rangeLabel} · Total watch time {formatWatchTime(data.kpis.videoWatchTimeMinutes)}
            </p>
            {allZeroActivity ? (
              <p className="mt-2 text-body text-ink-sub">No activity recorded in this range.</p>
            ) : null}
            <div className="mt-3 flex items-center gap-4 text-body text-ink">
              <span>
                <span className="text-link">●</span> Media views {formatCount(data.kpis.mediaViews)}
              </span>
              <span>
                <span className="text-brand-emerald">●</span> Unique viewers{' '}
                {formatCount(data.kpis.uniqueViewersDailySum)}
              </span>
            </div>
            <div className="mt-2">
              <InsightsChart trend={data.trend} />
            </div>
          </Card>

          <div className="grid gap-3 lg:grid-cols-2">
            <Card className="p-5">
              <p className="text-body font-medium text-ink">How people reacted</p>
              <p className="text-xs text-ink-dim">Share of all reactions in this range</p>
              {allZeroActivity ? (
                <p className="mt-2 text-body text-ink-sub">No activity recorded in this range.</p>
              ) : null}
              <div className="mt-4 flex flex-col gap-3">
                {data.reactions.map((r) => (
                  <div key={r.kind} className="flex items-center gap-3">
                    <span className="flex w-24 shrink-0 items-center gap-1.5 text-body text-ink-sub">
                      <span aria-hidden>{REACTION_EMOJI[r.kind] ?? ''}</span>
                      {REACTION_LABELS[r.kind] ?? r.kind}
                    </span>
                    <ShareBar
                      sharePct={r.sharePct}
                      tone={REACTION_TONES[r.kind] ?? 'gold'}
                    />
                    <span className="flex shrink-0 items-baseline gap-1.5">
                      <span className="text-body text-ink">{formatCount(r.count)}</span>
                      <span className="text-xs text-ink-dim">{r.sharePct}%</span>
                    </span>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-5">
              <p className="flex items-center gap-2 text-body font-medium text-ink">
                <GlobeIcon className="h-5 w-5 shrink-0" /> Where followers are
              </p>
              <p className="text-xs text-ink-dim">
                All-time audience from Facebook — not limited to the selected range
              </p>
              {data.topCountries.length === 0 && data.topCities.length === 0 ? (
                <p className="mt-4 text-body text-ink-sub">
                  Audience data appears once the page has enough followers.
                </p>
              ) : (
                <div className="mt-4 flex flex-col gap-5">
                  <div>
                    <p className="text-xs font-medium text-ink-sub">Top countries</p>
                    <div className="mt-2 flex flex-col gap-2">
                      {data.topCountries.map((c) => (
                        <div key={c.name} className="flex items-center gap-3">
                          <span className="w-24 truncate text-body text-ink-sub">{c.name}</span>
                          <ShareBar sharePct={c.sharePct} tone="emerald" />
                          <span className="w-16 text-right text-body text-ink">{formatCount(c.count)}</span>
                          <span className="w-12 text-right text-xs text-ink-dim">{c.sharePct}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-ink-sub">Top cities</p>
                    <div className="mt-2 flex flex-col gap-2">
                      {data.topCities.map((c) => (
                        <div key={c.name} className="flex items-center gap-3">
                          <span className="w-24 truncate text-body text-ink-sub">{c.name}</span>
                          <ShareBar sharePct={c.sharePct} tone="emerald" />
                          <span className="w-16 text-right text-body text-ink">{formatCount(c.count)}</span>
                          <span className="w-12 text-right text-xs text-ink-dim">{c.sharePct}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
