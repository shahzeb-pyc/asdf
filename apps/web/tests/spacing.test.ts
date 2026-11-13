/**
 * Spacing-scale drift guard (spec 182 — Balanced).
 *
 * The Balanced spacing pick (owner 2026-11-13) re-pins the named space
 * ladder in tokens/primitive.json. These assertions fail if any copy of
 * the scale drifts from the others — the token source, the generated
 * :root variables, or the generated theme export — so the scale cannot
 * silently fork, and they fail on the old 4/8-system values.
 *
 * Honest scope note (see the PR body): the app's key surfaces use
 * Tailwind numeric spacing utilities (gap-4, p-6, px-3 …) on the 4px
 * base, not these named tokens. This test pins the TOKEN scale only;
 * it does not claim the surfaces render the picked values.
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
