/**
 * Font-delivery drift guard (spec 137 §3.6.3 / PR-A4, updated for the
 * 2026-10-29 Direction 4 token redesign).
 *
 * Inter is declared in src/app/fonts.ts and carried by the
 * design-token pipeline (tokens/primitive.json -> generated CSS) and
 * the theme export, and loaded exactly once by the root layout via
 * next/font/google. The typeface is a deliberate, wired choice;
 * these assertions fail if any copy of the stack drifts from the
 * others, so the configuration cannot silently fork — and they fail
 * if Inter is replaced by the old system-only stack again.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FONT_INTER_VARIABLE,
  FONT_MONO_STACK,
  FONT_SANS_STACK,
  FONT_MONO_VARIABLE,
  FONT_SANS_VARIABLE,
} from '@/app/fonts';
import { TYPOGRAPHY } from '@/lib/theme';

const generatedCss = readFileSync(
  path.resolve(process.cwd(), 'src/styles/tokens.generated.css'),
  'utf8'
);
const primitiveTokens = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tokens/primitive.json'), 'utf8')
) as {
  font: { family: { sans: { $value: string }; mono: { $value: string } } };
};
const layoutSource = readFileSync(
  path.resolve(process.cwd(), 'src/app/layout.tsx'),
  'utf8'
);

describe('font delivery (spec 137 §3.6.3)', () => {
  it('declares the shipped Inter stack — not the old system-only stack', () => {
    expect(FONT_SANS_STACK).toBe(
      'var(--font-inter), system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    );
    expect(FONT_SANS_STACK).toContain(`var(${FONT_INTER_VARIABLE})`);
    expect(FONT_MONO_STACK).toBe(
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
    );
  });

  it('matches the token source of truth (tokens/primitive.json)', () => {
    expect(primitiveTokens.font.family.sans.$value).toBe(FONT_SANS_STACK);
    expect(primitiveTokens.font.family.mono.$value).toBe(FONT_MONO_STACK);
  });

  it('matches the generated token variables the layout consumes', () => {
    expect(generatedCss).toContain(`${FONT_SANS_VARIABLE}: ${FONT_SANS_STACK};`);
    expect(generatedCss).toContain(`${FONT_MONO_VARIABLE}: ${FONT_MONO_STACK};`);
  });

  it('matches the theme export components still consume', () => {
    expect(TYPOGRAPHY.fontFamily).toBe(FONT_SANS_STACK);
    expect(TYPOGRAPHY.mono).toBe(FONT_MONO_STACK);
  });

  it('is loaded exactly once, by the root layout via next/font/google', () => {
    expect(layoutSource).toContain("from 'next/font/google'");
    expect(layoutSource).toContain('Inter({');
    expect(layoutSource).toContain(`variable: '${FONT_INTER_VARIABLE}'`);
    expect(layoutSource).toContain('inter.variable');
  });
});
