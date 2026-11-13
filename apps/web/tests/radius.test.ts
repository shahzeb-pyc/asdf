/**
 * Radius-scale drift guard (spec 183 — Squared).
 *
 * The Squared roundness pick (owner 2026-11-13) re-pins the named radius
 * ladder in tokens/primitive.json. These assertions fail if any copy of
 * the scale drifts from the others — the token source, the generated
 * :root variables, or the generated theme export — so the scale cannot
 * silently fork, and they fail on the old Direction 4 values.
 *
 * Honest scope note (see the PR body): the token-scale block alone could
 * not catch the spacing bug (verifier SEND BACK on PR #255), because the
 * key surfaces used numeric utilities that never consumed the tokens.
 * Radius differs — the key surfaces DO consume the named radius
 * utilities (rounded-xs/sm/md/full resolve through @theme inline) — but
 * the scale alone still cannot prove each surface carries the utility
 * for its picked value, so the surface-wiring block below pins the
 * token → utility → surface chain, and the real-browser check proves
 * the computed values.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RADII } from '@/lib/theme';

const generatedCss = readFileSync(
  path.resolve(process.cwd(), 'src/styles/tokens.generated.css'),
  'utf8'
);
const primitiveTokens = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tokens/primitive.json'), 'utf8')
) as {
  radius: Record<'xs' | 'sm' | 'md' | 'full', { $value: string }>;
};

/** Squared scale (spec 183): xs 4, sm 6, md 8, full unchanged. */
const EXPECTED: Record<keyof typeof primitiveTokens.radius, string> = {
  xs: '4px',
  sm: '6px',
  md: '8px',
  full: '9999px',
};

describe('radius scale (spec 183 — Squared)', () => {
  it('pins the Squared values in the token source of truth', () => {
    for (const [step, value] of Object.entries(EXPECTED)) {
      expect(primitiveTokens.radius[step as keyof typeof EXPECTED].$value).toBe(
        value
      );
    }
  });

  it('pins the Squared values in the generated :root variables', () => {
    for (const [step, value] of Object.entries(EXPECTED)) {
      expect(generatedCss).toContain(`--radius-${step}: ${value};`);
    }
  });

  it('pins the Squared values in the generated theme export', () => {
    expect(RADII.xs).toBe('4px');
    expect(RADII.sm).toBe('6px');
    expect(RADII.md).toBe('8px');
    expect(RADII.full).toBe('9999px');
  });
});

/**
 * Surface wiring (spec 183).
 *
 * The picked values are display roles, not token names: the card takes
 * the sm step (6px), the nav takes sm (6px), the avatar tiles and the
 * logo-mark tiles take the xs step (4px — the closest step to the 3px
 * mark pick, which has no token home), the app frame takes the md step
 * (8px), and pill buttons take the full step (unchanged). These
 * assertions pin each surface to its utility, so a revert of any link
 * fails. The real-browser check proves the computed values; this test
 * pins the wiring.
 */

/** [component source file, class fragment it must carry]. */
const SURFACES: Array<[string, string]> = [
  // Card → sm (6px).
  ['src/components/pages/page-card.tsx', 'flex-col rounded-sm border bg-panel p-card'],
  // Nav item → sm (6px).
  ['src/components/shell/app-sidebar.tsx', 'rounded-sm px-nav py-nav'],
  // Avatar tiles → xs (4px).
  [
    'src/components/workspace/workspace-switcher.tsx',
    'rounded-xs bg-primary text-body font-bold text-on-primary',
  ],
  [
    'src/components/workspace/workspace-switcher-list.tsx',
    'rounded-xs border border-line bg-subtle text-metadata font-semibold text-ink',
  ],
  // Logo-mark tiles → xs (4px, closest step to the 3px pick).
  [
    'src/components/shell/app-sidebar.tsx',
    'rounded-xs border border-line bg-canvas',
  ],
  [
    'src/components/auth/auth-split-layout.tsx',
    'rounded-xs border border-line bg-subtle',
  ],
  [
    'src/components/auth/login-showcase-panel.tsx',
    'rounded-xs border border-line bg-subtle',
  ],
  // App frame surfaces → md (8px).
  [
    'src/components/shared/ui/dialog.tsx',
    'overflow-y-auto rounded-md border border-line bg-panel',
  ],
  [
    'src/components/auth/auth-split-layout.tsx',
    'rounded-md border border-line bg-panel px-7 py-8',
  ],
  [
    'src/components/shared/ui/sidebar.tsx',
    'group-data-[variant=floating]:rounded-md',
  ],
  // Buttons: pill shape stays full, default shape stays sm.
  ['src/components/shared/ui/button.tsx', 'pill: "rounded-full"'],
  ['src/components/shared/ui/button.tsx', 'default: "rounded-sm"'],
];

describe('surface wiring (spec 183)', () => {
  it('carries the token utilities on the key surfaces', () => {
    for (const [file, fragment] of SURFACES) {
      const source = readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source).toContain(fragment);
    }
  });

  it('does not leave the page card on the old md step', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/components/pages/page-card.tsx'),
      'utf8'
    );
    const cardLine = source
      .split('\n')
      .find((line) => line.includes('p-card'));
    expect(cardLine).toBeDefined();
    expect(cardLine).not.toContain('rounded-md');
  });
});
