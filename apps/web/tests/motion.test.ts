/**
 * Motion-scale drift guard (spec 185 — Expressive).
 *
 * The Expressive motion pick (owner 2026-11-13) re-pins the named motion
 * ladder in tokens/primitive.json: hover & press 200ms, menus & dialogs
 * 300ms, page entrance 420ms, spring easing cubic-bezier(.34,1.4,.64,1).
 * These assertions fail if any copy of the scale drifts from the others
 * — the token source, the generated :root variables, or the generated
 * theme export — so the scale cannot silently fork, and they fail on the
 * old Calm values.
 *
 * Honest scope note (see the PR body): the token-scale block alone could
 * not catch the spacing bug (verifier SEND BACK on PR #255), because the
 * key surfaces used numeric utilities that never consumed the tokens.
 * Motion differs for durations/easings — the key surfaces DO consume the
 * named utilities (duration-fast/base/slow/slower and ease-enter/exit/
 * standard/linear resolve through @theme inline) — but the scale alone
 * still cannot prove each surface carries the utility for its picked
 * value, so the surface-wiring block below pins the token → utility →
 * surface chain, and the real-browser check proves the computed values.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOTION } from '@/lib/theme';

const generatedCss = readFileSync(
  path.resolve(process.cwd(), 'src/styles/tokens.generated.css'),
  'utf8'
);
const primitiveTokens = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tokens/primitive.json'), 'utf8')
) as {
  motion: {
    duration: Record<
      'fast' | 'base' | 'slow' | 'slower',
      { $value: { unit: string; value: number } }
    >;
    easing: Record<
      'enter' | 'exit' | 'linear' | 'standard',
      { $value: number[] }
    >;
  };
};

/** Expressive scale (spec 185): fast 200, base 300, slow 420, slower 520. */
const EXPECTED_DURATIONS: Record<
  keyof typeof primitiveTokens.motion.duration,
  number
> = {
  fast: 200,
  base: 300,
  slow: 420,
  slower: 520,
};

/** Expressive easings (spec 185): spring replaces enter + standard. */
const EXPECTED_EASINGS: Record<
  keyof typeof primitiveTokens.motion.easing,
  number[]
> = {
  enter: [0.34, 1.4, 0.64, 1],
  standard: [0.34, 1.4, 0.64, 1],
  exit: [0.4, 0, 1, 1],
  linear: [0, 0, 1, 1],
};

describe('motion scale (spec 185 — Expressive)', () => {
  it('pins the Expressive values in the token source of truth', () => {
    for (const [step, value] of Object.entries(EXPECTED_DURATIONS)) {
      const token =
        primitiveTokens.motion.duration[
          step as keyof typeof EXPECTED_DURATIONS
        ];
      expect(token.$value.unit).toBe('ms');
      expect(token.$value.value).toBe(value);
    }
    for (const [step, value] of Object.entries(EXPECTED_EASINGS)) {
      expect(
        primitiveTokens.motion.easing[step as keyof typeof EXPECTED_EASINGS]
          .$value
      ).toEqual(value);
    }
  });

  it('pins the Expressive values in the generated :root variables', () => {
    for (const [step, value] of Object.entries(EXPECTED_DURATIONS)) {
      expect(generatedCss).toContain(`--motion-duration-${step}: ${value}ms;`);
    }
    expect(generatedCss).toContain(
      '--motion-easing-enter: cubic-bezier(0.34, 1.4, 0.64, 1);'
    );
    expect(generatedCss).toContain(
      '--motion-easing-standard: cubic-bezier(0.34, 1.4, 0.64, 1);'
    );
    expect(generatedCss).toContain(
      '--motion-easing-exit: cubic-bezier(0.4, 0, 1, 1);'
    );
    expect(generatedCss).toContain(
      '--motion-easing-linear: cubic-bezier(0, 0, 1, 1);'
    );
  });

  it('pins the Expressive values in the generated theme export', () => {
    expect(MOTION.duration.fast).toBe('200ms');
    expect(MOTION.duration.base).toBe('300ms');
    expect(MOTION.duration.slow).toBe('420ms');
    expect(MOTION.duration.slower).toBe('520ms');
    expect(MOTION.easing.enter).toBe('cubic-bezier(0.34, 1.4, 0.64, 1)');
    expect(MOTION.easing.standard).toBe('cubic-bezier(0.34, 1.4, 0.64, 1)');
    expect(MOTION.easing.exit).toBe('cubic-bezier(0.4, 0, 1, 1)');
    expect(MOTION.easing.linear).toBe('cubic-bezier(0, 0, 1, 1)');
  });
});

/**
 * Surface wiring (spec 185).
 *
 * The picked values are display roles, not token names: hover & press
 * take the fast step (200ms), menus & dialogs take base (300ms), the
 * page entrance takes slow (420ms) for its step — while the entrance
 * animation itself runs at the pick's exact 380ms (see below). These
 * assertions pin each surface to its utility, so a revert of any link
 * fails. The real-browser check proves the computed values; this test
 * pins the wiring.
 *
 * Entrance (spec 185): no token home exists for the 380ms entrance —
 * the duration ladder is 200/300/420/520 and no step equals 380ms, and
 * inventing a token is forbidden — so the entrance duration is literal
 * in the single `--animate-page-enter` token in globals.css, cited to
 * the pick, with the spring easing as a pure var() reference to the
 * enter token. Fill is `backwards`, not the mock's `both`: `both`
 * would retain the final keyframe (translateY(0)) forever and pin the
 * transform, blocking the hover lift on the same cards.
 */

/** [component source file, class fragment it must carry]. */
const SURFACES: Array<[string, string]> = [
  // Button: hover/press at fast (200ms) with the spring easing, and the
  // 1px lift on the filled variants (see the lift test below).
  [
    'src/components/shared/ui/button.tsx',
    'transition-[background-color,border-color,color,transform,box-shadow] duration-fast ease-enter',
  ],
  // Cards: hover lift at fast (200ms) with the spring easing, and the
  // page entrance (380ms, rises 14px from opacity 0).
  [
    'src/components/pages/page-card.tsx',
    'animate-page-enter transition-all duration-fast ease-enter',
  ],
  [
    'src/components/accounts/account-card.tsx',
    'animate-page-enter transition-all duration-fast ease-enter',
  ],
  [
    'src/components/accounts/instagram-account-card.tsx',
    'animate-page-enter transition-all duration-fast ease-enter',
  ],
  [
    'src/components/accounts/threads-account-card.tsx',
    'animate-page-enter transition-all duration-fast ease-enter',
  ],
  [
    'src/components/auto-download-upload/adu-hub-page.tsx',
    'animate-page-enter transition-all duration-fast ease-enter',
  ],
  [
    'src/components/tiktok/tiktok-card.tsx',
    'animate-page-enter transition-all duration-fast ease-enter',
  ],
  [
    'src/components/threads-schedule/schedule-card.tsx',
    'animate-page-enter transition-all duration-fast ease-enter',
  ],
  [
    'src/components/prompts/prompt-card-grid.tsx',
    'animate-page-enter transition-all duration-fast ease-enter',
  ],
  // Shadow-only card: timing pinned, entrance carried.
  [
    'src/components/instagram/schedule/schedule-card.tsx',
    'animate-page-enter transition-shadow duration-fast ease-enter',
  ],
];

describe('surface wiring (spec 185)', () => {
  it('carries the token utilities on the key surfaces', () => {
    for (const [file, fragment] of SURFACES) {
      const source = readFileSync(path.resolve(process.cwd(), file), 'utf8');
      expect(source).toContain(fragment);
    }
  });

  it('lifts the filled button variants 1px on hover, not ghost/link', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/components/shared/ui/button.tsx'),
      'utf8'
    );
    for (const variant of ['default', 'destructive', 'outline', 'secondary']) {
      const line = source
        .split('\n')
        .find((l) => l.trim().startsWith(`${variant}:`));
      expect(line).toBeDefined();
      expect(line).toContain('hover:-translate-y-px');
    }
    for (const variant of ['ghost', 'link']) {
      const line = source
        .split('\n')
        .find((l) => l.trim().startsWith(`${variant}:`));
      expect(line).toBeDefined();
      expect(line).not.toContain('hover:-translate-y-px');
    }
  });

  it('does not leave the button on the old base step', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/components/shared/ui/button.tsx'),
      'utf8'
    );
    expect(source).not.toContain('duration-base');
  });

  it('defines the page-entrance keyframes and animation token', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/app/globals.css'),
      'utf8'
    );
    expect(source).toContain('@keyframes page-enter');
    expect(source).toContain(
      'from { opacity: 0; transform: translateY(14px); }'
    );
    expect(source).toContain('to { opacity: 1; transform: translateY(0); }');
    expect(source).toContain(
      '--animate-page-enter: page-enter 380ms var(--motion-easing-enter) backwards;'
    );
  });
});
