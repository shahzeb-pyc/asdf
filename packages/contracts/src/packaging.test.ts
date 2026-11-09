import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Spec 159 O1 guard — the contracts package must stay tree-shakeable.
 *
 * The web client imports a handful of helpers from this package
 * (`DesktopTitleBar`'s desktop helpers, a few zod schemas). Without
 * `"sideEffects": false`, webpack cannot drop the other 56 modules
 * re-exported by the barrel, and the whole package (~28 KB gzip)
 * plus `libphonenumber-js` (~25 KB, pulled in by `domain/auth.ts`)
 * ships on every page — including pages that never use them.
 *
 * This test pins the flag at source level so a future edit doesn't
 * silently re-add ~53 KB to every page's first load. The build-output
 * proof (chunk 1755 absent from the auth first-load script lists) is
 * measured in the spec 159 build stage with the HTML-script method.
 *
 * Safety basis for the flag: every module in `src/` is declarations
 * only (zod schema construction, pure functions, types) — no
 * top-level executable statements, no IIFEs, no global mutation.
 * The full contracts test suite (1067 tests) is the runtime guard
 * that nothing relies on import-time side effects.
 */
describe('contracts packaging (spec 159 O1)', () => {
  it('declares "sideEffects": false', () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
    ) as { sideEffects?: unknown };
    expect(pkg.sideEffects).toBe(false);
  });

  it('has no top-level executable statements in src (spot check)', () => {
    // A module with import-time side effects would break tree-shaking
    // assumptions. This is a coarse grep-guard, not a proof: the
    // authoritative check is the contract test suite passing with the
    // flag set, plus the measured first-load numbers.
    const index = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'index.ts'),
      'utf8'
    );
    expect(index).not.toMatch(/^\s*(console\.|globalThis\.|process\.env)/m);
  });
});
