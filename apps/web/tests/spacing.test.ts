/**
 * Spacing-scale drift guard (spec 182 — Balanced).
 *
 * The Balanced spacing pick (owner 2026-11-13) re-pins the named space
 * ladder in tokens/primitive.json. These assertions fail if any copy of
 * the scale drifts from the others — the token source, the generated
 * :root variables, or the generated theme export — so the scale cannot
 * silently fork, and they fail on the old 4/8-system values.
 *
 * Honest scope note (see the PR body): the app's key surfaces used
 * Tailwind numeric spacing utilities (gap-4, p-6, px-3 …) on the 4px
 * base, not these named tokens — the token-scale block alone could not
 * catch that bug (verifier SEND BACK on PR #255). The surface-wiring
 * block below pins the token → utility → surface chain, so a revert of
 * any link fails.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPACING } from '@/lib/theme';

const generatedCss = readFileSync(
  path.resolve(process.cwd(), 'src/styles/tokens.generated.css'),
  'utf8'
);
const primitiveTokens = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tokens/primitive.json'), 'utf8')
) as {
  space: Record<
    'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl' | 'xxxl' | 'section' | 'page',
    { $value: string }
  >;
};

/** Balanced scale (spec 182): sm 10, md 16, lg 20; the rest unchanged. */
const EXPECTED: Record<keyof typeof primitiveTokens.space, string> = {
  xs: '4px',
  sm: '10px',
  md: '16px',
  lg: '20px',
  xl: '24px',
  xxl: '32px',
  xxxl: '48px',
  section: '64px',
  page: '96px',
};

describe('spacing scale (spec 182 — Balanced)', () => {
  it('pins the Balanced values in the token source of truth', () => {
    for (const [step, value] of Object.entries(EXPECTED)) {
      expect(primitiveTokens.space[step as keyof typeof EXPECTED].$value).toBe(
        value
      );
    }
  });

  it('pins the Balanced values in the generated :root variables', () => {
    for (const [step, value] of Object.entries(EXPECTED)) {
      expect(generatedCss).toContain(`--space-${step}: ${value};`);
    }
  });

  it('pins the Balanced values in the generated theme export', () => {
    expect(SPACING.sm).toBe('10px');
    expect(SPACING.md).toBe('16px');
    expect(SPACING.lg).toBe('20px');
    expect(SPACING.xs).toBe('4px');
    expect(SPACING.xl).toBe('24px');
    expect(SPACING.xxl).toBe('32px');
    expect(SPACING.xxxl).toBe('48px');
  });
});

/**
 * Surface wiring (spec 182 fix round).
 *
 * The token scale alone cannot catch the bug this fix addresses: the key
 * surfaces used Tailwind numeric utilities on the 4px base and never
 * consumed the named space tokens, so a token-only change moved nothing
 * the user sees. These assertions pin the whole chain — the @theme alias
 * maps the surface utility to the token, and the surface carries the
 * utility — so reverting any link fails. The real-browser check proves
 * the computed values; this test pins the wiring.
 */
const globalsCss = readFileSync(
  path.resolve(process.cwd(), 'src/app/globals.css'),
  'utf8'
);

/** [surface utility, space step] — the mapping from the PR body. */
const ALIASES: Array<[string, string]> = [
  ['card', 'lg'],
  ['row', 'md'],
  ['nav', 'sm'],
  ['page', 'xxl'],
  ['grid', 'md'],
  ['stack', 'xl'],
];

/** [component source file, token utility it must carry]. */
const SURFACES: Array<[string, string]> = [
  ['src/components/pages/page-card.tsx', 'p-card'],
  ['src/components/pages/page-card.tsx', 'gap-grid'],
  ['src/components/pages/add-page-steps.tsx', 'px-row'],
  ['src/components/pages/add-page-steps.tsx', 'py-row'],
  [
    'src/components/instagram/publish-now/instagram-publish-now-page.tsx',
    'px-row',
  ],
  ['src/components/pages/publish-now/publish-now-page.tsx', 'px-row'],
  [
    'src/components/pages/threads-publish-now/threads-publish-now-page.tsx',
    'px-row',
  ],
  ['src/components/shell/app-sidebar.tsx', 'px-nav'],
  ['src/components/shell/app-sidebar.tsx', 'py-nav'],
  [
    'src/app/tenant/[subdomain]/inapp-schedule/inapp-schedule-shell.tsx',
    'sm:px-page',
  ],
  [
    'src/app/tenant/[subdomain]/inapp-schedule/inapp-schedule-shell.tsx',
    'sm:py-page',
  ],
  ['src/components/pages/dedicated/tab-dashboard.tsx', 'gap-grid'],
  ['src/components/pages/dedicated/tab-dashboard.tsx', 'gap-stack'],
];

describe('surface wiring (spec 182 fix round)', () => {
  it('maps each surface utility to its space token in @theme', () => {
    for (const [utility, token] of ALIASES) {
      expect(globalsCss).toContain(
        `--spacing-${utility}: var(--space-${token});`
      );
    }
  });

  it('carries the token utilities on the key surfaces', () => {
    for (const [file, utility] of SURFACES) {
      const source = readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source).toContain(utility);
    }
  });
});
