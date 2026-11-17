import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Spec 200 guard — auth gold text contrast.
 *
 * The login showcase panel rendered gold text (`text-primary`,
 * `--color-brand-gold` #FFFC00) on the light canvas (#fafaf9) at
 * 1.05:1 contrast — effectively invisible. The fix is theme-aware
 * and token-backed only: bronze (`text-brand-bronze`, #716400) on
 * light theme, bright gold (`dark:text-primary`) on dark theme.
 * A flat swap would be wrong — bronze on the dark canvas is only
 * 3.32:1 — so the dark variant must stay.
 *
 * This test pins the fix at source level so a future re-merge of the
 * bare `text-primary` class fails loudly in CI instead of silently
 * re-invisibling the showcase. No hex literals, no arbitrary values,
 * no new tokens: the classes below are existing design-system
 * utilities (see the repo theme rules — literal ban).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(join(HERE, relative), 'utf8');

const PANEL = read('login-showcase-panel.tsx');
const LOGIN_PAGE = read(join('..', '..', 'app', 'login', 'page.tsx'));
const TOKENS_CSS = read(join('..', '..', 'styles', 'tokens.generated.css'));

/** Remove the dark-variant gold so only bare `text-primary` is left to find. */
const stripDarkGold = (source: string) => source.replaceAll('dark:text-primary', '');

function tokenValue(css: string, name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!match?.[1]) throw new Error(`token --color-${name} not found in generated CSS`);
  return match[1];
}

function luminance(hex: string): number {
  const clean = hex.replace(/^#/, '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(clean.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

describe('auth gold text contrast (spec 200)', () => {
  it('showcase panel uses the theme-aware gold classes (eyebrow, headline, 3 icons)', () => {
    const matches = PANEL.match(/text-brand-bronze dark:text-primary/g) ?? [];
    expect(matches).toHaveLength(5);
  });

  it('login "Create one" footer link uses the theme-aware gold classes', () => {
    expect(LOGIN_PAGE).toContain('text-brand-bronze dark:text-primary');
  });

  it('no bare text-primary remains in the showcase panel or the login page', () => {
    expect(stripDarkGold(PANEL)).not.toContain('text-primary');
    expect(stripDarkGold(LOGIN_PAGE)).not.toContain('text-primary');
  });

  it('no hex literal or arbitrary colour value in either file', () => {
    for (const source of [PANEL, LOGIN_PAGE]) {
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(source).not.toContain('text-[#');
    }
  });

  it('the token pairs behind the classes meet contrast in their own theme', () => {
    const gold = tokenValue(TOKENS_CSS, 'brand-gold');
    const bronze = tokenValue(TOKENS_CSS, 'brand-bronze');
    const lightCanvas = tokenValue(TOKENS_CSS, 'surface-light-canvas');
    const darkCanvas = tokenValue(TOKENS_CSS, 'surface-dark-canvas');
    // Light theme renders bronze: must pass WCAG AA for normal text.
    expect(contrast(bronze, lightCanvas)).toBeGreaterThanOrEqual(4.5);
    // Dark theme renders gold: must pass WCAG AA for normal text.
    expect(contrast(gold, darkCanvas)).toBeGreaterThanOrEqual(4.5);
    // And the bug itself: gold on the light canvas must stay failing,
    // which is why the theme-aware classes (not a flat swap) are required.
    expect(contrast(gold, lightCanvas)).toBeLessThan(4.5);
  });
});
