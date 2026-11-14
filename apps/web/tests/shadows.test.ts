/**
 * Shadow-scale drift guard (spec 184 — Lifted).
 *
 * The Lifted shadows pick (owner 2026-11-13) re-pins the named shadow
 * ladder in tokens/primitive.json. These assertions fail if any copy of
 * the scale drifts from the others — the token source, the generated
 * :root variables, or the generated theme export — so the scale cannot
 * silently fork, and they fail on the old Subtle values.
 *
 * Roles (Font Options page, Lifted option): card = cards & lists,
 * raised = the main yellow button, menus and popovers (the `elevated`
 * step), modal = dialogs and the Add Page dialogue. The app-frame role
 * has no token and no real surface — in the mockup it is the shadow
 * around the miniature preview box; the real shell is full-viewport
 * with no frame — so no frame value is applied (see the PR body).
 *
 * Dark values are derived, not picked: one step deeper from the
 * current dark set by the same relative step as light (same y/blur
 * multipliers, same absolute alpha deltas, spread removed where light
 * removed it), alpha capped at 0.95, the system's existing ceiling
 * (the current dark modal value — it is already at the ceiling, so
 * its depth comes from geometry alone).
 *
 * Honest scope note (see the PR body): the token-scale block alone
 * could not catch the spacing bug (verifier SEND BACK on PR #255),
 * because the key surfaces used numeric utilities that never consumed
 * the tokens. Shadows differ — the key surfaces DO consume the named
 * shadow utilities (shadow-card/elevated/modal resolve through @theme
 * inline) — but the scale alone still cannot prove each surface
 * carries the utility for its picked value, so the surface-wiring
 * block below pins the token → utility → surface chain, and the
 * real-browser check proves the computed values.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DARK_THEME, LIGHT_THEME } from '@/lib/theme';

const generatedCss = readFileSync(
  path.resolve(process.cwd(), 'src/styles/tokens.generated.css'),
  'utf8'
);
const primitiveTokens = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tokens/primitive.json'), 'utf8')
) as {
  shadow: {
    light: Record<'card' | 'elevated' | 'modal', { $value: string }>;
    dark: Record<'card' | 'elevated' | 'modal', { $value: string }>;
  };
};

/** Lifted scale (spec 184): light picked exact, dark derived. */
const EXPECTED_LIGHT: Record<'card' | 'elevated' | 'modal', string> = {
  card: '0 2px 6px rgba(0, 0, 0, 0.07), 0 10px 24px rgba(0, 0, 0, 0.06)',
  elevated: '0 8px 24px rgba(0, 0, 0, 0.14)',
  modal: '0 24px 60px rgba(0, 0, 0, 0.22)',
};
const EXPECTED_DARK: Record<'card' | 'elevated' | 'modal', string> = {
  card: '0 4px 16px rgba(0, 0, 0, 0.62)',
  elevated: '0 24px 48px rgba(0, 0, 0, 0.91)',
  modal: '0 28px 90px rgba(0, 0, 0, 0.95)',
};

describe('shadow scale (spec 184 — Lifted)', () => {
  it('pins the Lifted values in the token source of truth', () => {
    for (const [step, value] of Object.entries(EXPECTED_LIGHT)) {
      expect(
        primitiveTokens.shadow.light[step as keyof typeof EXPECTED_LIGHT]
          .$value
      ).toBe(value);
    }
    for (const [step, value] of Object.entries(EXPECTED_DARK)) {
      expect(
        primitiveTokens.shadow.dark[step as keyof typeof EXPECTED_DARK].$value
      ).toBe(value);
    }
  });

  it('pins the Lifted values in the generated :root variables', () => {
    for (const [step, value] of Object.entries(EXPECTED_LIGHT)) {
      expect(generatedCss).toContain(`--shadow-light-${step}: ${value};`);
    }
    for (const [step, value] of Object.entries(EXPECTED_DARK)) {
      expect(generatedCss).toContain(`--shadow-dark-${step}: ${value};`);
    }
  });

  it('pins the Lifted values in the generated theme export', () => {
    for (const [step, value] of Object.entries(EXPECTED_LIGHT)) {
      expect(
        LIGHT_THEME.shadows[step as keyof typeof EXPECTED_LIGHT]
      ).toBe(value);
    }
    for (const [step, value] of Object.entries(EXPECTED_DARK)) {
      expect(DARK_THEME.shadows[step as keyof typeof EXPECTED_DARK]).toBe(
        value
      );
    }
  });
});

/**
 * Surface wiring (spec 184).
 *
 * The picked values are display roles, not token names: the card takes
 * the card step, the raised role (main yellow button, menus, popovers,
 * toasts) takes the elevated step, dialogs take the modal step. These
 * assertions pin each surface to its utility, so a revert of any link
 * fails. The real-browser check proves the computed values; this test
 * pins the wiring.
 */

/** [component source file, class fragment it must carry]. */
const SURFACES: Array<[string, string]> = [
  // Card → card step.
  [
    'src/components/shared/ui/card.tsx',
    'rounded-md border border-line bg-panel py-6 text-ink shadow-card',
  ],
  [
    'src/components/pages/page-card.tsx',
    'border bg-panel p-card shadow-card',
  ],
  // Raised → elevated step: primary (yellow) button, menus, popovers,
  // toasts, dropdowns.
  [
    'src/components/shared/ui/button.tsx',
    'default: "border border-link bg-primary text-on-primary shadow-elevated',
  ],
  ['src/components/shared/ui/menu.tsx', 'bg-panel p-1 text-ink shadow-elevated'],
  ['src/components/shared/ui/popover.tsx', 'bg-panel p-4 text-ink shadow-elevated'],
  ['src/components/shared/ui/toast.tsx', 'bg-panel p-4 text-body text-ink shadow-elevated'],
  // Dialog → modal step.
  [
    'src/components/shared/ui/dialog.tsx',
    'bg-panel p-5 text-ink shadow-modal',
  ],
  [
    'src/components/shared/ui/alert-dialog.tsx',
    'bg-panel p-5 text-ink shadow-modal',
  ],
  // Auto-repost card: was on the Tailwind default shadow-sm, now on
  // the card token like every other card.
  [
    'src/components/threads-auto-repost/threads-auto-repost-card.tsx',
    'rounded-md border border-line bg-panel p-4 text-left shadow-card',
  ],
];

describe('surface wiring (spec 184)', () => {
  it('carries the token utilities on the key surfaces', () => {
    for (const [file, fragment] of SURFACES) {
      const source = readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source).toContain(fragment);
    }
  });

  it('does not leave the auto-repost card on the Tailwind default', () => {
    const source = readFileSync(
      path.resolve(
        process.cwd(),
        'src/components/threads-auto-repost/threads-auto-repost-card.tsx'
      ),
      'utf8'
    );
    expect(source).not.toContain('shadow-sm');
  });

  it('does not leave the primary button without its raised shadow', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/components/shared/ui/button.tsx'),
      'utf8'
    );
    const defaultLine = source
      .split('\n')
      .find((line) => line.includes('default: "border border-link bg-primary'));
    expect(defaultLine).toBeDefined();
    expect(defaultLine).toContain('shadow-elevated');
  });
});
