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

function formatDayMonth(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
}

function formatDayMonthYear(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** "1 Oct – 27 Oct 2026" for a window of daily ISO dates (oldest first). */
function formatRangeLabel(dates: string[]): string {
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return '';
  if (first === last) return formatDayMonthYear(last);
  const firstYear = first.slice(0, 4);
  const lastYear = last.slice(0, 4);
  return `${firstYear === lastYear ? formatDayMonth(first) : formatDayMonthYear(first)} – ${formatDayMonthYear(last)}`;
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
        ? 'bg-brand-rose'
        : tone === 'bronze'
          ? 'bg-brand-bronze'
          : tone === 'peru'
            ? 'bg-brand-peru'
            : tone === 'critical'
              ? 'bg-signal-critical'
              : 'bg-brand-gold';
  return (
    <span className="h-2 min-w-0 flex-1 rounded-full bg-subtle">
      <span className={`block h-2 rounded-full ${barClass}`} style={{ width: `${sharePct}%` }} />
    </span>
  );
}

export function PageTabInsights({ page, subdomain }: Readonly<PageTabInsightsProps>): React.ReactElement {
  const [range, setRange] = React.useState<PageInsightsRange>('28d');
  const [data, setData] = React.useState<PageInsightsResponse | null>(null);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [syncing, setSyncing] = React.useState(false);

  const load = React.useCallback(
    async (targetRange: PageInsightsRange, force: boolean): Promise<void> => {
      if (!force) {
        const cached = readCachedInsights(page.id, targetRange);
        if (cached) {
          setData(cached);
          setStatus('ready');
          return;
        }
      }
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
        writeCachedInsights(checked.data);
        setData(checked.data);
        setStatus('ready');
      } catch {
        setStatus('error');
      } finally {
        setSyncing(false);
      }
    },
    [page.id, subdomain],
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await load(range, false);
    })();
    return () => {
      cancelled = true;
    };
  }, [load, range]);

  const handleSync = (): void => {
    void load(range, true);
  };

  const firstUse = data !== null && isFirstUse(data);
  const allZeroActivity = data !== null && !firstUse && isAllZeroActivity(data);
  const netGrowth = data?.kpis.netFollowerGrowth ?? 0;
  // The loaded trend dates are the window; before any load, the window for
  // the selected range is. Both come from the same window function.
  const windowDates = React.useMemo(() => insightsWindow(range).dates, [range]);
  const rangeDates = data && data.trend.length > 0 ? data.trend.map((p) => p.date) : windowDates;
  const rangeLabel = formatRangeLabel(rangeDates);
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
          <Skeleton className="h-[280px]" />
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

      {status === 'ready' && data && firstUse && (
        <EmptyState
          type="first-use"
          title="No insights yet"
          description="Insights will appear here after your first posts publish."
          className="min-h-[55svh] justify-center"
          icon={<ChartColumnIcon className="h-10 w-10 text-brand-gold" aria-hidden />}
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
                <PlayIcon className="h-5 w-5 shrink-0 text-brand-gold" /> Media views
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
                <HeartIcon className="h-5 w-5 shrink-0 text-brand-rose" /> Engagements
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
                <span className="text-brand-gold">●</span> Media views {formatCount(data.kpis.mediaViews)}
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
