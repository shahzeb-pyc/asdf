/**
 * Radius-scale drift guard (spec 186 — Rounded).
 *
 * The Rounded roundness pick (owner 2026-11-14, re-deciding the Squared
 * pick of spec 183) re-pins the named radius ladder in
 * tokens/primitive.json. These assertions fail if any copy of the scale
 * drifts from the others — the token source, the generated :root
 * variables, or the generated theme export — so the scale cannot
 * silently fork, and they fail on the old Squared values.
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

/** Rounded scale (spec 186): xs 12, sm 20, md 28, full unchanged. */
const EXPECTED: Record<keyof typeof primitiveTokens.radius, string> = {
  xs: '12px',
  sm: '20px',
  md: '28px',
  full: '9999px',
};

describe('radius scale (spec 186 — Rounded)', () => {
  it('pins the Rounded values in the token source of truth', () => {
    for (const [step, value] of Object.entries(EXPECTED)) {
      expect(primitiveTokens.radius[step as keyof typeof EXPECTED].$value).toBe(
        value
      );
    }
  });

  it('pins the Rounded values in the generated :root variables', () => {
    for (const [step, value] of Object.entries(EXPECTED)) {
      expect(generatedCss).toContain(`--radius-${step}: ${value};`);
    }
  });

  it('pins the Rounded values in the generated theme export', () => {
    expect(RADII.xs).toBe('12px');
    expect(RADII.sm).toBe('20px');
    expect(RADII.md).toBe('28px');
    expect(RADII.full).toBe('9999px');
  });
});

/**
 * Surface wiring (spec 186).
 *
 * The picked values are display roles, not token names. The ladder has
 * three steps for five surfaces, so two surfaces render off-pick — both
 * disclosed here and in the PR body (the #256 logo-mark precedent):
 * the card takes the sm step (20px, exact), the nav takes the xs step
 * (12px, exact — re-wired from sm), the avatar tiles and the logo-mark
 * tiles share the xs step (12px — tiles 4px under their 16px pick, mark
 * 3px over its 9px pick), the app frame takes the md step (28px,
 * exact), and pill buttons take the full step (unchanged). The default
 * button keeps the sm step (renders 20px; on the standard 36px button
 * height that caps to a pill silhouette, so "buttons stay pill" holds
 * in effect — same precedent as spec 183). These assertions pin each
 * surface to its utility, so a revert of any link fails. The
 * real-browser check proves the computed values; this test pins the
 * wiring.
 */

/** [component source file, class fragment it must carry]. */
const SURFACES: Array<[string, string]> = [
  // Card → sm (20px, exact).
  ['src/components/pages/page-card.tsx', 'flex-col rounded-sm border bg-panel p-card'],
  // Nav → xs (12px, exact — re-wired from sm).
  ['src/components/shell/app-sidebar.tsx', 'rounded-xs px-nav py-nav'],
  [
    'src/components/shared/ui/sidebar.tsx',
    'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-xs p-2',
  ],
  [
    'src/components/shared/ui/sidebar.tsx',
    'flex min-h-8 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-xs px-2',
  ],
  // Avatar tiles → xs (12px; 4px under the 16px pick).
  [
    'src/components/workspace/workspace-switcher.tsx',
    'rounded-xs border border-link bg-primary text-body font-bold text-on-primary',
  ],
  [
    'src/components/workspace/workspace-switcher-list.tsx',
    'rounded-xs border border-line bg-subtle text-metadata font-semibold text-ink',
  ],
  // Logo-mark tiles → xs (12px; 3px over the 9px pick).
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
  // App frame surfaces → md (28px, exact).
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

describe('surface wiring (spec 186)', () => {
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

  it('does not leave the sidebar nav items on the old sm step', () => {
    const sidebarSource = readFileSync(
      path.resolve(process.cwd(), 'src/components/shared/ui/sidebar.tsx'),
      'utf8'
    );
    const menuButtonLine = sidebarSource
      .split('\n')
      .find((line) => line.includes('peer/menu-button'));
    expect(menuButtonLine).toBeDefined();
    expect(menuButtonLine).not.toContain('rounded-sm');
    const appSidebarSource = readFileSync(
      path.resolve(process.cwd(), 'src/components/shell/app-sidebar.tsx'),
      'utf8'
    );
    const brandingLine = appSidebarSource
      .split('\n')
      .find((line) => line.includes('px-nav py-nav'));
    expect(brandingLine).toBeDefined();
    expect(brandingLine).not.toContain('rounded-sm');
  });
});
