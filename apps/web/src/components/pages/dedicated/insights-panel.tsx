'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import {
  ClockIcon,
  EyeIcon,
  GlobeIcon,
  HeartIcon,
  MinusIcon,
  RefreshCwIcon,
  TrendingDownIcon,
  TrendingUpIcon,
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

function formatUpdated(fetchedAt: string, nowMs: number): string {
  const fetchedMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedMs)) return 'just now';
  const diffMin = Math.max(0, Math.floor((nowMs - fetchedMs) / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function isFirstUse(data: PageInsightsResponse): boolean {
  return (
    data.kpis.followers === 0 &&
    data.kpis.mediaViews === 0 &&
    data.kpis.engagements === 0 &&
    data.trend.every((p) => p.views === 0 && p.viewers === 0)
  );
}

function ShareBar({
  sharePct,
  tone,
}: Readonly<{ sharePct: number; tone: 'gold' | 'emerald' | 'rose' }>): React.ReactElement {
  const barClass =
    tone === 'emerald' ? 'bg-brand-emerald' : tone === 'rose' ? 'bg-brand-rose' : 'bg-brand-gold';
  return (
    <span className="h-2 flex-1 rounded-full bg-subtle">
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
  const netGrowth = data?.kpis.netFollowerGrowth ?? 0;

  return (
    <div data-testid="page-tab-insights" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold text-ink">Insights</h2>
          <p className="text-xs text-ink-dim">
            Live from Facebook
            {data ? ` · Updated ${formatUpdated(data.fetchedAt, Date.now())}` : ''}
          </p>
        </div>
        <div className="flex gap-1 rounded-md border border-line bg-subtle p-1" role="group" aria-label="Date range">
          {RANGES.map((r) => (
            <Button
              key={r.value}
              data-testid={`insights-range-${r.value}`}
              variant={range === r.value ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </Button>
          ))}
        </div>
        <Button
          data-testid="insights-sync-btn"
          variant="outline"
          size="sm"
          onClick={handleSync}
          disabled={syncing || status === 'loading'}
        >
          <RefreshCwIcon className={syncing ? 'animate-spin' : undefined} />
          {syncing ? 'Syncing…' : 'Sync'}
        </Button>
      </div>

      {status === 'loading' && (
        <div className="flex flex-col gap-6" aria-label="Loading insights">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
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
          action={
            <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync'}
            </Button>
          }
        />
      )}

      {status === 'ready' && data && !firstUse && (
        <>
          <div data-testid="insights-kpi-grid" className="grid grid-cols-2 gap-3 xl:grid-cols-3">
            <Card className="p-5">
              <p className="flex items-center gap-2 text-body text-ink-sub">
                <UsersIcon /> Followers
              </p>
              <p className="mt-2 text-xxl font-bold text-ink">{formatCount(data.kpis.followers)}</p>
              <p className="text-xs text-ink-dim">Live total</p>
            </Card>
            <Card className="p-5">
              <p className="flex items-center gap-2 text-body text-ink-sub">
                <EyeIcon /> Media views
              </p>
              <p className="mt-2 text-xxl font-bold text-ink">{formatCount(data.kpis.mediaViews)}</p>
              <p className="text-xs text-ink-dim">In the selected range</p>
            </Card>
            <Card className="p-5">
              <p className="flex items-center gap-2 text-body text-ink-sub">
                <UsersIcon /> Unique viewers
              </p>
              <p className="mt-2 text-xxl font-bold text-ink">
                {formatCount(data.kpis.uniqueViewersDailySum)}
              </p>
              <p className="text-xs text-ink-dim">Sum of daily viewers in range</p>
            </Card>
            <Card className="p-5">
              <p className="flex items-center gap-2 text-body text-ink-sub">
                <HeartIcon /> Engagements
              </p>
              <p className="mt-2 text-xxl font-bold text-ink">{formatCount(data.kpis.engagements)}</p>
              <p className="text-xs text-ink-dim">Reactions, comments, shares</p>
            </Card>
            <Card className="p-5">
              <p className="flex items-center gap-2 text-body text-ink-sub">
                <HeartIcon /> Engagement rate
              </p>
              <p className="mt-2 text-xxl font-bold text-ink">
                {data.kpis.engagementRatePct === null ? '—' : `${data.kpis.engagementRatePct}%`}
              </p>
              <p className="text-xs text-ink-dim">Engagements per view</p>
            </Card>
            <Card className="p-5">
              <p className="flex items-center gap-2 text-body text-ink-sub">
                {netGrowth > 0 ? (
                  <TrendingUpIcon className="text-signal-operational" />
                ) : netGrowth < 0 ? (
                  <TrendingDownIcon className="text-signal-critical" />
                ) : (
                  <MinusIcon />
                )}
                Net follower growth
              </p>
              <p className="mt-2 text-xxl font-bold text-ink">{formatSigned(netGrowth)}</p>
              <p className="text-xs text-ink-dim">New follows minus unfollows in range</p>
            </Card>
          </div>

          <Card className="p-5">
            <p className="text-body font-medium text-ink">Views &amp; viewers</p>
            <p className="text-xs text-ink-dim">
              Daily in the selected range · Total watch time {formatWatchTime(data.kpis.videoWatchTimeMinutes)}
            </p>
            <div className="mt-3 flex items-center gap-4 text-xs text-ink-sub">
              <span>
                <span className="text-brand-gold">●</span> Views
              </span>
              <span>
                <span className="text-brand-emerald">●</span> Viewers
              </span>
            </div>
            <div className="mt-2">
              <InsightsChart trend={data.trend} />
            </div>
          </Card>

          <div className="grid gap-3 lg:grid-cols-2">
            <Card className="p-5">
              <p className="text-body font-medium text-ink">How people reacted</p>
              <p className="text-xs text-ink-dim">Share of all reactions in the selected range</p>
              <div className="mt-4 flex flex-col gap-3">
                {data.reactions.map((r) => (
                  <div key={r.kind} className="flex items-center gap-3">
                    <span className="w-12 text-body text-ink-sub">
                      {REACTION_LABELS[r.kind] ?? r.kind}
                    </span>
                    <ShareBar
                      sharePct={r.sharePct}
                      tone={r.kind === 'sad' || r.kind === 'angry' ? 'rose' : 'gold'}
                    />
                    <span className="w-16 text-right text-body text-ink">{formatCount(r.count)}</span>
                    <span className="w-12 text-right text-xs text-ink-dim">{r.sharePct}%</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-5">
              <p className="flex items-center gap-2 text-body font-medium text-ink">
                <GlobeIcon /> Where followers are
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

          <p className="flex items-center gap-2 text-xs text-ink-dim">
            <ClockIcon /> Stored only in this browser for one hour. Sync fetches fresh numbers
            from Facebook.
          </p>
        </>
      )}
    </div>
  );
}
