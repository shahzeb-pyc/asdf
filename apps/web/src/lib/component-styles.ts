/**
 * @file component-styles.ts
 * @description LEGACY PRESERVED PRESETS — spec 129 PR-F1 (coordinator ruling, Option B).
 *
 * These pre-composed component style presets were moved VERBATIM (values
 * byte-identical, rendering parity) out of the hand-written theme.ts when
 * theme.ts became a generated file. They are NOT part of the token generator
 * output and are NOT the design system going forward: the primitives in
 * apps/web/src/components/shared/ui/ (PR-F3) supersede them.
 *
 * Deletion tracking: spec 129 task T23 — each preset is deleted as its last
 * consumer converts (F3 / specs 130–136). Do not add new presets here and do
 * not add new consumers.
 *
 * Note on `primaryButton`: it is exposed through a getter so this module can
 * be re-exported from the generated theme.ts without an import-cycle TDZ
 * error (theme.ts re-exports COMPONENT_STYLES from here; the function presets
 * only read theme values when called, after both modules have loaded).
 */
import {
  PALETTE,
  SPACING,
  RADII,
  TYPOGRAPHY,
  STATUS_SIGNALS,
  DARK_THEME,
  type ThemeTokens,
} from './theme';

/**
 * Pre-composed, standard component style presets to prevent ad-hoc styling.
 * (Legacy preserved — see file header.)
 */
export const COMPONENT_STYLES = {
  /**
   * Primary Action Button Preset (Gold fill, bold black text, inset highlight)
   * WCAG AAA 14.71:1 contrast ratio (Binance gold on black).
   */
  get primaryButton() {
    return {
      height: '38px',
      padding: `0 ${SPACING.md}`,
      backgroundColor: PALETTE.primary,
      color: PALETTE.background,
      border: 'none',
      borderRadius: RADII.sm,
      fontWeight: TYPOGRAPHY.weights.bold,
      fontSize: '0.875rem',
      cursor: 'pointer',
      boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.35)',
      transition: 'all 0.12s ease',
    };
  },
  /**
   * Secondary Action Button Preset (1px hairline border)
   */
  secondaryButton: (theme: ThemeTokens = DARK_THEME) => ({
    height: '38px',
    padding: `0 ${SPACING.md}`,
    backgroundColor: 'transparent',
    color: `var(--text-main, ${theme.text.primary})`,
    border: `1px solid var(--border-subtle, ${theme.borders.hairline})`,
    borderRadius: RADII.sm,
    fontWeight: TYPOGRAPHY.weights.semibold,
    fontSize: '0.875rem',
    cursor: 'pointer',
    transition: 'all 0.12s ease',
  }),
  /**
   * Text Input Resting State Preset
   */
  input: (theme: ThemeTokens = DARK_THEME) => ({
    height: '38px',
    backgroundColor: theme.surfaces.canvas,
    color: theme.text.primary,
    border: `1px solid ${theme.mode === 'light' ? theme.borders.strong : theme.borders.hairline}`,
    borderRadius: RADII.sm,
    padding: `0 ${SPACING.sm}`,
    fontSize: '0.875rem',
    outline: 'none',
    transition: 'all 0.15s ease',
  }),
  /**
   * Card / Panel Container Preset
   */
  card: (theme: ThemeTokens = DARK_THEME) => ({
    backgroundColor: theme.surfaces.panel,
    border: `1px solid ${theme.borders.hairline}`,
    borderRadius: RADII.md,
    boxShadow: theme.shadows.card,
  }),
  /**
   * Status Dot Preset (legacy — status presentation is colour + icon + text
   * per spec 129 OD-3; this dot-only preset is superseded by the primitives)
   */
  statusDot: (type: keyof typeof STATUS_SIGNALS, mode: 'dark' | 'light' = 'dark') => ({
    width: '6px',
    height: '6px',
    borderRadius: RADII.full,
    backgroundColor: type === 'idle' && mode === 'light' ? STATUS_SIGNALS.idle.dotLight : STATUS_SIGNALS[type].dot,
    boxShadow: STATUS_SIGNALS[type].halo,
    display: 'inline-block',
    flexShrink: 0,
  }),
} as const;
