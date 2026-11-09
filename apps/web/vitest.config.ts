import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Spec 137-A3 (T30): Vitest project split.
 *
 * - `node` project: the existing API / security / domain / lib / middleware
 *   suites. Their environment and behaviour are untouched.
 * - `jsdom` project: component / UI tests. They render into a real DOM
 *   (jsdom) and assert on behaviour — interaction, keyboard, focus, async
 *   states — via Testing Library + user-event + jest-dom matchers wired in
 *   `tests/setup/jsdom.setup.ts`.
 */
export default defineConfig({
  // Spec 160: apps/web/tsconfig.json sets jsx: "preserve" (Next.js
  // requires it). Under Vite 8 (Astro 7's vite ^8 dedup) the oxc
  // transform honours preserve, so .tsx files reach
  // vite:import-analysis with JSX intact and fail to parse ("make sure
  // to not set jsx to preserve"). Vite 7 did not do this, which is why
  // the suite passed in CI on main. Force the JSX transform for the
  // test pipeline only; production (Next/SWC) and tsconfig are
  // untouched.
  oxc: {
    jsx: {
      runtime: 'automatic',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    passWithNoTests: true,
    // Playwright specs (tests/e2e/**, spec 137-A3) are not Vitest tests —
    // PR-A6 carries the updated login spec on this stack, so the exclude
    // lands here; PR-A3's project-split config supersedes it on merge.
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json'],
      reportsDirectory: './coverage',
      // Spec 137 §3.4.3: the new architecture modules are held to 100%
      // line coverage by their own suites. Scoped per-glob so no
      // repo-wide coverage mandate is introduced; PR-A3 owns the
      // wider test-harness migration.
      thresholds: {
        'src/lib/api/**': { lines: 100 },
        'src/lib/data/**': { lines: 100 },
        'src/lib/storage/**': { lines: 100 },
        'src/lib/report-error.ts': { lines: 100 },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'src/**/*.test.ts',
            'tests/api/**/*.test.ts',
            'tests/auth/**/*.test.ts',
            'tests/domain/**/*.test.ts',
            'tests/lib/**/*.test.ts',
            // Root-level suites (e.g. the fonts drift guard, PR-A4):
            // plain node tests that live directly under tests/.
            'tests/*.test.ts',
            'tests/middleware/**/*.test.ts',
            'tests/security/**/*.test.ts',
            'tests/unit/**/*.test.ts',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
          ],
          setupFiles: ['./tests/setup/jsdom.setup.ts'],
          include: [
            'src/**/*.test.tsx',
            'tests/auth/**/*.test.tsx',
            'tests/components/**/*.test.tsx',
            // Behavioural lib suites that render (e.g. the data-layer
            // provider suite, PR-A1b) live under tests/lib as .tsx.
            'tests/lib/**/*.test.tsx',
            'tests/ui/**/*.test.{ts,tsx}',
            'tests/unit/**/*.test.tsx',
          ],
        },
      },
    ],
  },
});
