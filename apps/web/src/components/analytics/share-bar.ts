/**
 * Bar widths in 5% steps. Inline styles are banned by the regression
 * guardrails (inline-style ratchet), so a data-driven bar width comes
 * from token-backed fraction utilities (Tailwind v4 resolves any
 * fraction dynamically); the exact percentage or count is still shown
 * as text next to the bar, so quantizing the bar itself loses no
 * information. Same quantization as the per-page Insights tab's
 * ShareBar (`components/pages/dedicated/insights-panel.tsx`).
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

export function shareWidthClass(sharePct: number): string {
  const step = Math.min(20, Math.max(0, Math.round(sharePct / 5)));
  return SHARE_BAR_WIDTHS[step] ?? 'w-0';
}
