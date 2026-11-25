import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Spec 256 guard — thin gold text contrast (workspace tick + audit).
 *
 * The workspace-switcher tick rendered bright gold (`text-primary`,
 * the `--color-brand-gold` token) on white at ~1.1:1 contrast —
 * effectively invisible. The same bare gold was used for thin
 * foreground text/icons on light backgrounds in ten more places
 * (connect link, account/studio icon boxes, folder icons, prompt
 * links/buttons/tag, Upgrade pill). The fix is theme-aware and
 * token-backed only: bronze (`text-brand-bronze`) on light theme,
 * bright gold (`dark:text-primary`) on dark theme. A flat swap
 * would be wrong — bronze on the dark canvas is only 3.32:1 — so
 * the dark variant must stay.
 *
 * Deliberately left on bright gold (named in the PR, not here by
 * accident): the gold check on the green payment-method fill
 * (4.58:1 on green-700 in light mode; bronze there would be
 * 1.19:1), the 8px bulk-delete progress ring (thick shape, not
 * thin text), and the favourite heart on the dark card button
 * (gold on dark, ~18:1).
 *
 * This test pins the fix at source level so a future re-merge of
 * the bare gold classes fails loudly in CI instead of silently
 * re-invisibling the tick. No hex literals, no arbitrary values,
 * no new tokens: the classes below are existing design-system
 * utilities. Token values are read from the generated CSS at
 * runtime, never written here, so this file itself stays
 * literal-free.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(join(HERE, relative), 'utf8');

/** Remove the dark-variant gold so only bare gold is left to find. */
const stripDarkGold = (source: string) =>
  source.replaceAll('dark:text-primary', '').replaceAll('dark:border-primary', '');

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

/** Every file switched by spec 256, with its bronze-pattern count. */
const SWITCHED: Array<{ file: string; bronzeUses: number }> = [
  { file: 'workspace-switcher-list.tsx', bronzeUses: 1 },
  { file: '../../app/tenant/[subdomain]/connect/[platform]/page.tsx', bronzeUses: 1 },
  { file: '../accounts/platform-accounts-shell.tsx', bronzeUses: 1 },
  { file: '../studio/fdola-studio-gate.tsx', bronzeUses: 1 },
  { file: '../media/media-library-subfolders.tsx', bronzeUses: 1 },
  { file: '../pages/dedicated/create-posts/media-library-picker.tsx', bronzeUses: 1 },
  { file: '../prompts/prompt-detail-section.tsx', bronzeUses: 3 },
  { file: '../prompts/prompt-guide-dialog.tsx', bronzeUses: 1 },
  { file: '../prompts/prompt-top-section.tsx', bronzeUses: 3 },
  { file: '../shell/topbar-plan-pill.tsx', bronzeUses: 1 },
];

describe('thin gold text contrast (spec 256)', () => {
  it('the workspace tick uses the theme-aware gold classes', () => {
    const source = read('workspace-switcher-list.tsx');
    const matches = source.match(/text-brand-bronze (?:dark:border-primary )?dark:text-primary/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('every audited file uses the bronze pattern and no bare gold', () => {
    for (const { file, bronzeUses } of SWITCHED) {
      const source = read(file);
      const matches = source.match(/text-brand-bronze (?:dark:border-primary )?dark:text-primary/g) ?? [];
      expect(matches, file).toHaveLength(bronzeUses);
      const stripped = stripDarkGold(source);
      expect(stripped, `${file} still has bare text-primary`).not.toContain('text-primary');
      expect(stripped, `${file} still has bare text-brand-gold`).not.toContain('text-brand-gold');
      expect(stripped, `${file} still has bare border-brand-gold`).not.toContain('border-brand-gold');
    }
  });

  it('the tokens behind the swap are what the swap assumes', () => {
    const css = read('../../styles/tokens.generated.css');
    const bronze = tokenValue(css, 'brand-bronze');
    const gold = tokenValue(css, 'brand-gold');
    const lightCanvas = tokenValue(css, 'surface-light-canvas');
    const darkCanvas = tokenValue(css, 'surface-dark-canvas');
    // Bronze must pass AA on the light canvas; bright gold must pass
    // AA on the dark canvas — otherwise the theme-aware swap is
    // pointless. And the bug itself: gold on the light canvas must
    // stay failing, which is why the theme-aware classes (not a flat
    // swap) are required.
    expect(contrast(bronze, lightCanvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(gold, darkCanvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(gold, lightCanvas)).toBeLessThan(4.5);
  });
});
