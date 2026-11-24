import * as React from 'react';
import type { AnalyticsAggregateResponse, AnalyticsLocationItem } from '@fbuploadpro/contracts';
import { formatCount, formatSigned } from '@/lib/analytics/aggregate';
import { shareWidthClass } from './share-bar';

/** Segment colours for the countries strip, in rank order — a
 * descending emerald scale, then the neutral greys. Token colours
 * only; the strip's widths carry the shares, the colours just tell
 * the segments apart. */
const COUNTRY_SWATCHES = [
  'bg-brand-emerald',
  'bg-brand-emerald/75',
  'bg-brand-emerald/60',
  'bg-brand-emerald/45',
  'bg-gray-400',
  'bg-gray-600',
] as const;

function formatSharePct(sharePct: number): string {
  return `${Number.isInteger(sharePct) ? sharePct : sharePct.toFixed(1)}%`;
}

function CountryStrip({ items }: Readonly<{ items: AnalyticsLocationItem[] }>): React.ReactElement {
  const label = items.map((item) => `${item.name} ${formatSharePct(item.sharePct)}`).join(', ');
  return (
    <div
      className="mt-5 flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-panel p-px"
      role="img"
      aria-label={`Proportional distribution of followers across top countries: ${label}`}
    >
      {items.map((item, index) => (
        <span
          key={item.name}
          className={[
            'h-full',
            shareWidthClass(item.sharePct),
            COUNTRY_SWATCHES[index % COUNTRY_SWATCHES.length],
            index === 0 ? 'rounded-l-full' : '',
            index === items.length - 1 ? 'rounded-r-full' : '',
          ].join(' ')}
          title={`${item.name} — ${formatSharePct(item.sharePct)}`}
        />
      ))}
    </div>
  );
}

function TopCountries({ items }: Readonly<{ items: AnalyticsLocationItem[] }>): React.ReactElement {
  return (
    <div className="min-w-0">
      <div>
        <h3 className="text-lg font-bold tracking-h3 text-ink">Top countries</h3>
        <p className="mt-0.5 text-metadata text-ink-dim">
          Where followers are — combined, all-time
        </p>
      </div>
      {items.length === 0 ? (
        <p className="mt-5 text-body text-ink-dim">No location data yet.</p>
      ) : (
        <>
          <CountryStrip items={items} />
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <tbody className="divide-y divide-line">
                {items.map((item, index) => (
                  <tr key={item.name} className="transition-colors hover:bg-panel/70">
                    <td className="py-2.5 pr-3">
                      <span className="inline-flex items-center gap-2.5 text-body font-semibold text-ink">
                        <span
                          className={`h-2.5 w-2.5 shrink-0 rounded-xs ${COUNTRY_SWATCHES[index % COUNTRY_SWATCHES.length]}`}
                          aria-hidden="true"
                        />
                        <span>{item.name}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-body font-bold tabular-nums text-ink">
                      {formatCount(item.count)}
                    </td>
                    <td className="w-14 py-2.5 pl-3 text-right text-body font-semibold tabular-nums text-ink-sub">
                      {formatSharePct(item.sharePct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function TopCities({ items }: Readonly<{ items: AnalyticsLocationItem[] }>): React.ReactElement {
  return (
    <div className="min-w-0">
      <div>
        <h3 className="text-lg font-bold tracking-h3 text-ink">Top cities</h3>
        <p className="mt-0.5 text-metadata text-ink-dim">
          Where followers are — combined, all-time
        </p>
      </div>
      {items.length === 0 ? (
        <p className="mt-5 text-body text-ink-dim">No location data yet.</p>
      ) : (
        <ul className="mt-5 space-y-2">
          {items.map((item) => (
            <li key={item.name} className="relative overflow-hidden rounded-lg bg-panel/90">
              <span
                className={`pointer-events-none absolute inset-y-0 left-0 rounded-lg bg-brand-emerald/15 ${shareWidthClass(item.sharePct)}`}
                aria-hidden="true"
              />
              <div className="relative flex items-center justify-between gap-4 px-3.5 py-2.5">
                <span className="truncate text-body font-semibold text-ink">{item.name}</span>
                <div className="flex shrink-0 items-center gap-4 tabular-nums">
                  <span className="text-body font-bold text-ink">{formatCount(item.count)}</span>
                  <span className="w-9 text-right text-metadata font-semibold text-ink-sub">
                    {formatSharePct(item.sharePct)}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Audience overview (spec 241, analytics-final §3) — the all-time
 * totals and where followers are. The two hero numbers are the
 * combined totals across the picked scope; the countries and cities
 * come from the stored lifetime locations, shares computed from the
 * combined total followers at read time.
 */
export function AnalyticsAudience({
  data,
}: Readonly<{ data: AnalyticsAggregateResponse }>): React.ReactElement {
  return (
    <section aria-labelledby="heading-audience">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2
          id="heading-audience"
          className="text-xs font-bold uppercase tracking-caption text-ink-dim"
        >
          Audience overview
        </h2>
      </div>

      <div className="grid grid-cols-1 divide-y divide-line border-y border-line sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <div className="py-6 sm:pr-8 lg:py-7 lg:pr-12">
          <div className="flex items-center gap-2 text-body font-semibold text-ink-sub">
            <span className="h-1.5 w-1.5 rounded-full bg-link" aria-hidden="true" />
            <span>Total followers</span>
          </div>
          <div className="mt-2.5 text-4xl leading-none font-bold tracking-display tabular-nums text-ink sm:text-5xl">
            {formatCount(data.followers.total)}
          </div>
        </div>

        <div className="py-6 sm:pl-8 lg:py-7 lg:pl-12">
          <div className="flex items-center gap-2 text-body font-semibold text-ink-sub">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-emerald" aria-hidden="true" />
            <span>Total followers gained</span>
          </div>
          <div className="mt-2.5 text-4xl leading-none font-bold tracking-display tabular-nums text-brand-emerald sm:text-5xl">
            {formatSigned(data.followers.gained)}
          </div>
        </div>
      </div>

      <div className="mt-9 grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-12">
        <TopCountries items={data.topCountries} />
        <TopCities items={data.topCities} />
      </div>
    </section>
  );
}
