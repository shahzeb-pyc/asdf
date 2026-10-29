'use client';

import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { InsightsTrendPoint } from '@fbuploadpro/contracts';

/**
 * Modern trend chart for the rebuilt Insights tab — designed 2026-10-27
 * from current dashboard standards, not from the deleted chart.
 *
 * - Two gradient areas (Media Views in gold, Unique Viewers in emerald),
 *   no dots on the lines, one hover dot per series, minimal grid.
 * - Colours come only from design-system CSS variables; no hex literals.
 * - Compact numbers on the Y axis (1.2k / 3.0M); short month-day labels.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(iso: string): string {
  const [, month, day] = iso.split('-');
  const m = Number(month);
  return `${MONTHS[(Number.isFinite(m) ? m : 1) - 1]} ${Number(day)}`;
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

function TrendTooltip(props: {
  active?: boolean;
  payload?: ReadonlyArray<{ dataKey?: string | number; value?: number | string }>;
  label?: string | number;
}): React.ReactElement | null {
  if (!props.active || !props.payload || props.payload.length === 0) return null;
  const views = props.payload.find((p) => p.dataKey === 'views')?.value;
  const viewers = props.payload.find((p) => p.dataKey === 'viewers')?.value;
  return (
    <div className="rounded-md border border-line bg-panel p-3 shadow-card">
      <p className="text-xs font-medium text-ink-sub">
        {typeof props.label === 'string' ? shortDate(props.label) : props.label}
      </p>
      <p className="mt-1 text-body text-ink">
        <span className="text-link">●</span> Media views{' '}
        <strong>{typeof views === 'number' ? views.toLocaleString() : '—'}</strong>
      </p>
      <p className="text-body text-ink">
        <span className="text-brand-emerald">●</span> Unique viewers{' '}
        <strong>{typeof viewers === 'number' ? viewers.toLocaleString() : '—'}</strong>
      </p>
    </div>
  );
}

export function InsightsChart({
  trend,
}: Readonly<{ trend: InsightsTrendPoint[] }>): React.ReactElement {
  // Data-driven ceiling: the largest daily value, with a little headroom.
  // All-zero data gets a floor of 1 so the baseline still renders — never
  // an invented ceiling like 0–4 from the chart library's auto domain.
  const peak = trend.reduce((max, p) => Math.max(max, p.views, p.viewers), 0);
  const domainMax = peak === 0 ? 1 : Math.ceil(peak * 1.1);
  return (
    <div className="h-70 w-full" data-testid="insights-trend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="insightsViewsFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-link)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--color-link)" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="insightsViewersFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-brand-emerald)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="var(--color-brand-emerald)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border-subtle)" />
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            minTickGap={32}
          />
          <YAxis
            tickFormatter={compactNumber}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            width={44}
            domain={[0, domainMax]}
            allowDecimals={false}
          />
          <Tooltip content={<TrendTooltip />} />
          <Area
            type="monotone"
            dataKey="views"
            stroke="var(--color-link)"
            strokeWidth={2}
            fill="url(#insightsViewsFill)"
            dot={false}
            activeDot={{ r: 4 }}
          />
          <Area
            type="monotone"
            dataKey="viewers"
            stroke="var(--color-brand-emerald)"
            strokeWidth={2}
            fill="url(#insightsViewersFill)"
            dot={false}
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
