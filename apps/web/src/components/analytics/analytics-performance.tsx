'use client';

import * as React from 'react';
import {
  CalendarIcon,
  ClockIcon,
  HeartIcon,
  IdCardIcon,
  InfoIcon,
  ZapIcon,
} from 'lucide-react';
import type {
  AnalyticsAggregateResponse,
  AnalyticsPeriod,
} from '@fbuploadpro/contracts';
import { formatCount, formatSigned, formatWatchTime } from '@/lib/analytics/aggregate';
import { InsightsChart } from '@/components/pages/dedicated/insights-chart';
import { shareWidthClass } from './share-bar';

const PERIOD_OPTIONS: ReadonlyArray<{ value: AnalyticsPeriod; label: string }> = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '28', label: '28 days' },
];

/** Whole-percent share of movement, or null when nothing moved. */
function movementShare(part: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((part / total) * 100);
}

function ViewsAndReach({ data }: Readonly<{ data: AnalyticsAggregateResponse }>): React.ReactElement {
  const trend = data.chart.map((point) => ({
    date: point.date,
    views: point.mediaViews,
    viewers: point.uniqueViewers,
  }));
  return (
    <section className="mt-8" aria-labelledby="heading-reach">
      <div>
        <div className="flex flex-col gap-6 border-b border-line pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h3
              id="heading-reach"
              className="text-lg font-bold tracking-h3 text-ink"
            >
              Media views &amp; unique viewers over time
            </h3>
            <p className="mt-0.5 text-metadata font-medium text-ink-dim">
              {data.dateRangeLabel ? `Daily · ${data.dateRangeLabel}` : 'Daily'}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-6 sm:flex sm:items-end sm:gap-10">
            <div className="border-l-4 border-l-link pl-3.5">
              <div className="text-metadata font-semibold text-ink-sub">Media views</div>
              <div className="mt-1 text-xxxl leading-none font-bold tracking-display tabular-nums text-ink">
                {formatCount(data.mediaViews)}
              </div>
            </div>

            <div className="border-l-4 border-l-brand-emerald pl-3.5">
              <div className="text-metadata font-semibold text-ink-sub">Unique viewers</div>
              <div className="mt-1 text-xxxl leading-none font-bold tracking-display tabular-nums text-ink">
                {formatCount(data.uniqueViewers)}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 px-0.5">
          {trend.length === 0 ? (
            <p className="text-body text-ink-dim">No daily data for this period yet.</p>
          ) : (
            <div
              role="img"
              aria-label={`Line chart of combined daily media views and unique viewers over ${data.dateRangeLabel || data.periodLabel}. Media views total ${formatCount(data.mediaViews)} and unique viewers total ${formatCount(data.uniqueViewers)}.`}
            >
              <InsightsChart trend={trend} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function VideoSection({ data }: Readonly<{ data: AnalyticsAggregateResponse }>): React.ReactElement {
  const thirtySecondPct =
    data.videoViews > 0 ? (data.videoCompleteViews30s / data.videoViews) * 100 : 0;
  const [watchValue, watchUnit] = formatWatchTime(data.watchTimeMs).split(' ');
  return (
    <section className="mt-11 border-t border-line pt-8" aria-labelledby="heading-video">
      <h3
        id="heading-video"
        className="text-xs font-bold uppercase tracking-caption text-ink-dim"
      >
        Video
      </h3>

      <div className="mt-5 flex flex-col gap-8 lg:flex-row lg:items-center lg:gap-10">
        <div className="min-w-0 flex-1 space-y-6">
          <div>
            <div className="mb-2 flex items-baseline justify-between gap-4">
              <span className="text-body font-semibold text-ink-sub">Video views</span>
              <span className="text-xl leading-none font-bold tracking-display tabular-nums text-ink">
                {formatCount(data.videoViews)}
              </span>
            </div>
            <div className="h-3.5 w-full overflow-hidden rounded-md bg-panel">
              <div className="h-full w-full rounded-md bg-linear-to-r from-link/80 to-link transition-all duration-base ease-standard" />
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-baseline justify-between gap-4">
              <span className="text-body font-semibold text-ink-sub">30-second views</span>
              <span className="text-xl leading-none font-bold tracking-display tabular-nums text-ink">
                {formatCount(data.videoCompleteViews30s)}
              </span>
            </div>
            <div className="h-3.5 w-full overflow-hidden rounded-md bg-panel">
              <div
                className={`h-full rounded-md bg-linear-to-r from-brand-emerald/75 to-brand-emerald transition-all duration-base ease-standard ${shareWidthClass(thirtySecondPct)}`}
              />
            </div>
          </div>
        </div>

        <div className="h-px w-full bg-line lg:h-auto lg:min-h-29 lg:w-px lg:self-stretch" role="separator" />

        <div className="flex shrink-0 flex-col justify-center lg:pl-2">
          <div className="flex items-center gap-2 text-body font-semibold text-ink-sub">
            <span
              className="flex size-7 items-center justify-center rounded-lg border border-line-strong bg-panel text-ink-sub"
              aria-hidden="true"
            >
              <ClockIcon className="size-3.5" />
            </span>
            <span>Watch time</span>
          </div>

          <div className="mt-3 text-4xl leading-none font-bold tracking-display tabular-nums text-ink sm:text-5xl">
            {watchValue}{' '}
            <span className="text-xl font-bold tracking-normal text-ink-sub">{watchUnit}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function InteractionsLedger({
  data,
}: Readonly<{ data: AnalyticsAggregateResponse }>): React.ReactElement {
  const rows = [
    {
      label: 'Engagement',
      value: data.engagement,
      widthPct: 100,
      barClass: 'bg-link',
      icon: <HeartIcon className="size-4" />,
    },
    {
      label: 'Profile views',
      value: data.profileViews,
      widthPct: data.engagement > 0 ? (data.profileViews / data.engagement) * 100 : 0,
      barClass: 'bg-link/75',
      icon: <IdCardIcon className="size-4" />,
    },
    {
      label: 'Page actions',
      value: data.totalActions,
      widthPct: data.engagement > 0 ? (data.totalActions / data.engagement) * 100 : 0,
      barClass: 'bg-link/60',
      icon: <ZapIcon className="size-4" />,
    },
  ];
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-bold uppercase tracking-caption text-ink-dim">Interactions</h3>

      <ul className="mt-4 divide-y divide-line border-y border-line">
        {rows.map((row) => (
          <li key={row.label} className="flex items-center justify-between gap-4 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <span
                className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-panel text-ink-sub"
                aria-hidden="true"
              >
                {row.icon}
              </span>
              <span className="truncate text-body font-semibold text-ink">{row.label}</span>
            </div>

            <div className="flex shrink-0 items-center gap-4">
              <div
                className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-panel sm:block"
                aria-hidden="true"
              >
                <div
                  className={`h-full rounded-full transition-all duration-base ease-standard ${row.barClass} ${shareWidthClass(row.widthPct)}`}
                />
              </div>
              <span className="min-w-17 text-right text-lg font-bold tracking-display tabular-nums text-ink">
                {formatCount(row.value)}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FollowsSection({ data }: Readonly<{ data: AnalyticsAggregateResponse }>): React.ReactElement {
  const movement = data.newFollows + data.unfollows;
  const newShare = movementShare(data.newFollows, movement);
  const unfollowsShare = movementShare(data.unfollows, movement);
  const newBarPct = movement > 0 ? (data.newFollows / movement) * 100 : 0;
  const unfollowsBarPct = movement > 0 ? (data.unfollows / movement) * 100 : 0;
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-bold uppercase tracking-caption text-ink-dim">Follows</h3>

      <div className="mt-4">
        <div>
          <div className="flex items-center gap-2 text-body font-semibold text-ink-sub">
            <span className="h-2 w-2 shrink-0 rounded-full bg-brand-emerald" aria-hidden="true" />
            <span>Net follows</span>
          </div>
          <div
            className={`mt-2 text-4xl leading-none font-bold tracking-display tabular-nums sm:text-5xl ${
              data.netFollows >= 0 ? 'text-brand-emerald' : 'text-brand-rose'
            }`}
          >
            {formatSigned(data.netFollows)}
          </div>
          <p className="mt-2 text-metadata text-ink-dim">New follows minus unfollows</p>
        </div>

        <div
          className="mt-6 flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-panel"
          aria-hidden="true"
        >
          <div
            className={`h-full rounded-l-full bg-brand-emerald transition-all duration-base ease-standard ${shareWidthClass(newBarPct)}`}
          />
          <div
            className={`h-full rounded-r-full bg-brand-rose/85 transition-all duration-base ease-standard ${shareWidthClass(unfollowsBarPct)}`}
          />
        </div>

        <ul className="mt-2 divide-y divide-line">
          <li className="py-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="flex items-center gap-2 text-body font-semibold text-ink">
                <span className="h-2 w-2 shrink-0 rounded-full bg-brand-emerald" aria-hidden="true" />
                <span>New follows</span>
              </span>
              <span className="text-xl leading-none font-bold tracking-display tabular-nums text-ink">
                {formatCount(data.newFollows)}
              </span>
            </div>
            <div className="mt-1.5 flex items-baseline justify-between gap-4 pl-4">
              <span className="flex items-start gap-2 text-xs leading-snug text-ink-dim">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>Facebook&apos;s count in the period — not the gained number</span>
              </span>
              <span className="shrink-0 text-xs font-semibold tabular-nums text-ink-sub">
                {newShare === null ? '—' : `${newShare}% of movement`}
              </span>
            </div>
          </li>

          <li className="py-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="flex items-center gap-2 text-body font-semibold text-ink">
                <span className="h-2 w-2 shrink-0 rounded-full bg-brand-rose" aria-hidden="true" />
                <span>Unfollows</span>
              </span>
              <span className="text-xl leading-none font-bold tracking-display tabular-nums text-ink">
                {formatCount(data.unfollows)}
              </span>
            </div>
            <div className="mt-1.5 flex items-baseline justify-end gap-4 pl-4">
              <span className="shrink-0 text-xs font-semibold tabular-nums text-ink-sub">
                {unfollowsShare === null ? '—' : `${unfollowsShare}% of movement`}
              </span>
            </div>
          </li>
        </ul>
      </div>
    </div>
  );
}

/**
 * Period performance (spec 241, analytics-final §4–7) — the sticky
 * Performance bar (date chip + 1/7/28-day switcher), the Views &
 * reach chart, the Video funnel with the Watch time callout, the
 * Interactions ledger, and Follows net-first. Every number comes
 * from the aggregate response for the picked period; switching the
 * period swaps every value on the page.
 */
export function AnalyticsPerformance({
  data,
  period,
  onPeriodChange,
  isFetching,
}: Readonly<{
  data: AnalyticsAggregateResponse;
  period: AnalyticsPeriod;
  onPeriodChange: (period: AnalyticsPeriod) => void;
  isFetching: boolean;
}>): React.ReactElement {
  return (
    <div className="mt-12 border-t border-line pt-9" aria-busy={isFetching}>
      <div className="sticky top-0 z-40 -mx-4 border-b border-line bg-canvas/80 px-4 pb-3 pt-4 shadow-sm backdrop-blur-xl sm:-mx-6 sm:px-6">
        <div className="flex flex-col gap-3.5 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-h2 text-ink">Performance</h2>
            <p className="mt-0.5 text-body font-medium text-ink-sub">{data.periodLabel}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-line-strong bg-panel px-3.5 py-1.5 text-body font-bold tabular-nums text-ink">
              <CalendarIcon className="size-4 shrink-0 text-ink-dim" aria-hidden="true" />
              <span>{data.dateRangeLabel || 'No data yet'}</span>
            </div>

            <div
              className="inline-flex items-center gap-1 rounded-xl border border-line-strong bg-panel p-1"
              role="group"
              aria-label="Period"
            >
              {PERIOD_OPTIONS.map((option) => {
                const active = option.value === period;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => onPeriodChange(option.value)}
                    className={`h-control-sm cursor-pointer rounded-lg border px-3.5 text-body font-bold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/80 ${
                      active
                        ? 'border-link/25 bg-link/10 text-link'
                        : 'border-transparent text-ink-sub hover:text-ink'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <ViewsAndReach data={data} />
      <VideoSection data={data} />

      <section className="mt-11 border-t border-line pt-8 pb-6" aria-label="Interactions and follower activity">
        <div className="grid grid-cols-1 gap-11 lg:grid-cols-11 lg:gap-14">
          <div className="lg:col-span-6">
            <InteractionsLedger data={data} />
          </div>
          <div className="lg:col-span-5">
            <FollowsSection data={data} />
          </div>
        </div>
      </section>
    </div>
  );
}
