/**
 * Font delivery (spec 137 §3.6.3 / PR-A4, updated for the 2026-10-29
 * Direction 4 token redesign) — Inter, chosen and wired deliberately.
 *
 * The product's typeface is Inter. The stacks below are the single
 * declaration of the choice. The design-token pipeline carries the same
 * values (`tokens/primitive.json` font.family, generated to
 * `--font-family-sans` / `--font-family-mono` in
 * `src/styles/tokens.generated.css`, surfaced to Tailwind as
 * `--font-sans` / `--font-mono` in globals.css `@theme`), and
 * `tests/fonts.test.ts` fails if the copies ever drift apart.
 *
 * Canonical loading: the root layout loads Inter exactly once, via
 * `next/font/google` (`latin`, `display: swap`, variable
 * `--font-inter`), and applies that variable to `<body>` alongside
 * the token-backed `font-sans` utility (see `fontSansClassName`).
 * The wired path is therefore:
 * layout (next/font, `--font-inter`) → token utility `font-sans` →
 * generated token variable `--font-family-sans` → stack below.
 * This module declares the stack only — it must NOT also load Inter,
 * or two competing font definitions would exist. The mono stack is
 * unchanged (system mono, no downloadable font).
 */

/** Inter variable provided by the layout's next/font loader. */
export const FONT_INTER_VARIABLE = '--font-inter' as const;

/** Sans stack — identical to the tokens' font.family.sans value. */
export const FONT_SANS_STACK =
  'var(--font-inter), system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' as const;

/** Mono stack — identical to the tokens' font.family.mono value. */
export const FONT_MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace' as const;

/** Generated token variables carrying the stacks (globals.css @theme maps them to --font-sans/--font-mono). */
export const FONT_SANS_VARIABLE = '--font-family-sans' as const;
export const FONT_MONO_VARIABLE = '--font-family-mono' as const;

/**
 * Token-backed Tailwind utilities the root layout applies. `font-sans`
 * resolves through globals.css @theme to the generated
 * --font-family-sans variable, i.e. FONT_SANS_STACK.
 */
export const fontSansClassName = 'font-sans';
export const fontMonoClassName = 'font-mono';
