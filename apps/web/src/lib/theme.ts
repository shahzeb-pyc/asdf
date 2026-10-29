/**
 * GENERATED — do not edit; source: apps/web/tokens/
 * Regenerate with: pnpm --filter @fbuploadpro/web tokens:build
 *
 * Canonical Design System Theme Configuration & Tokens for FBUploadPro Webapp.
 * Hand-edit the DTCG token JSON in apps/web/tokens/ only — this file is a
 * generated mirror. CI (tokens:check) fails if it drifts from the source.
 */

// ============================================================================
// 1. PRIMITIVE PALETTE (Official 8-Color Palette)
// ============================================================================

export const PALETTE = {
  /** Dominant brand keystone — primary buttons, active moments (14.86:1 AAA on black) */
  primary: '#FFD300',
  /** Secondary highlight — links, callouts, active underline tabs */
  accent1: '#cca900',
  /** Deep bronze — tertiary highlight, active tab borders, deep pressed states */
  accent2: '#766018',
  /** Rose / Danger — negative status, error states, sell indicator, critical alerts */
  accent3: '#dc2626',
  /** Emerald / Success — positive status, operational states, buy indicator, success */
  accent4: '#0ecb81',
  /** Pitch Black — base canvas surface in dark mode */
  background: '#000000',
  /** Pure White — readable foreground typography in dark mode (21.0:1 AAA on black) */
  text: '#ffffff',
  /** Pitch Slate — 1px hairline borders, dividers, subtle recessed UI surfaces */
  neutral: '#292524',
} as const;

export type PaletteKey = keyof typeof PALETTE;

// ============================================================================
// 2. SPATIAL GRID & CORNER RADII TOKENS
// ============================================================================

export const SPACING = {
  /** 4px: Micro gaps, inline icon margins */
  xs: '4px',
  /** 8px: Compact element spacing, input internal padding Y */
  sm: '8px',
  /** 12px: Standard control padding X */
  md: '12px',
  /** 16px: Standard container padding, card inner margins */
  lg: '16px',
  /** 24px: Card sectional gap, grid gutters */
  xl: '24px',
  /** 32px: Page section rhythm */
  xxl: '32px',
  /** 48px: Major boundary margins */
  xxxl: '48px',
} as const;

export const RADII = {
  /** 4px: Checkboxes, micro switches, segmented toggles */
  xs: '8px',
  /** 6px: Primary/Secondary buttons, form text inputs, select triggers */
  sm: '12px',
  /** 8px: Cards, data tables, sheet containers, dialog modals */
  md: '16px',
  /** 9999px: Strictly reserved for circular avatars and round indicators. */
  full: '9999px',
} as const;

// ============================================================================
// 3. OPTICAL TYPOGRAPHY METRICS
// ============================================================================

export const TYPOGRAPHY = {
  fontFamily: 'var(--font-inter), system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontFeatureSettings: "'cv02', 'cv03', 'cv04', 'cv11'",
  tabularNums: 'tabular-nums',
  tracking: {
    display: '-0.025em',
    h1: '-0.020em',
    h2: '-0.015em',
    h3: '-0.010em',
    body: '0.000em',
    caption: '+0.040em',
  },
  weights: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    heavy: 800,
  },
} as const;

// ============================================================================
// 4. STATUS SIGNALS (colour + icon + text — spec 129 OD-3; never colour alone)
// ============================================================================

export const STATUS_SIGNALS = {
  operational: {
    color: '#4ade80',
    dot: '#4ade80',
    halo: '0 0 8px rgba(74, 222, 128, 0.50)',
    label: 'Operational',
  },
  queued: {
    color: '#FFD300',
    dot: '#FFD300',
    halo: '0 0 8px rgba(255, 211, 0, 0.50)',
    label: 'Queued',
  },
  critical: {
    color: '#f87171',
    dot: '#f87171',
    halo: '0 0 8px rgba(248, 113, 113, 0.50)',
    label: 'Critical',
  },
  idle: {
    color: '#a8a29e',
    dot: '#a8a29e',
    dotLight: '#78716c',
    halo: '0 0 4px rgba(120, 113, 108, 0.40)',
    label: 'Idle',
  },
} as const;

// ============================================================================
// 5. SEMANTIC THEME TOKENS (Dark & Light Mode)
// ============================================================================

export interface ThemeTokens {
  mode: 'dark' | 'light';
  surfaces: {
    canvas: string;
    panel: string;
    subtle: string;
    hover: string;
    active: string;
  };
  borders: {
    hairline: string;
    strong: string;
    focus: string;
  };
  text: {
    primary: string;
    secondary: string;
    muted: string;
    onPrimary: string;
    link: string;
  };
  shadows: {
    card: string;
    elevated: string;
    modal: string;
  };
  status: typeof STATUS_SIGNALS;
  spacing: typeof SPACING;
  radii: typeof RADII;
  typography: typeof TYPOGRAPHY;
}

export const DARK_THEME: ThemeTokens = {
  mode: 'dark',
  surfaces: {
    canvas: '#0c0a09',
    panel: '#292524',
    subtle: '#1c1917',
    hover: '#44403c',
    active: '#57534e',
  },
  borders: {
    hairline: '#292524',
    strong: '#44403c',
    focus: 'rgba(255, 211, 0, 0.35)',
  },
  text: {
    primary: '#fafaf9',
    secondary: '#d6d3d1',
    muted: '#a8a29e',
    onPrimary: '#181a20',
    link: '#FFD300',
  },
  shadows: {
    card: '0 2px 8px rgba(0, 0, 0, 0.60)',
    elevated: '0 12px 24px -4px rgba(0, 0, 0, 0.85)',
    modal: '0 24px 48px -8px rgba(0, 0, 0, 0.95)',
  },
  status: STATUS_SIGNALS,
  spacing: SPACING,
  radii: RADII,
  typography: TYPOGRAPHY,
};

export const LIGHT_THEME: ThemeTokens = {
  mode: 'light',
  surfaces: {
    canvas: '#fafaf9',
    panel: '#ffffff',
    subtle: '#f5f5f4',
    hover: '#f5f5f4',
    active: '#e7e5e4',
  },
  borders: {
    hairline: '#e7e5e4',
    strong: '#d6d3d1',
    focus: 'rgba(255, 211, 0, 0.35)',
  },
  text: {
    primary: '#1c1917',
    secondary: '#57534e',
    muted: '#78716c',
    onPrimary: '#181a20',
    link: '#766018',
  },
  shadows: {
    card: '0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.02)',
    elevated: '0 4px 12px -2px rgba(0, 0, 0, 0.08)',
    modal: '0 20px 32px -4px rgba(0, 0, 0, 0.12)',
  },
  status: STATUS_SIGNALS,
  spacing: SPACING,
  radii: RADII,
  typography: TYPOGRAPHY,
};

// ============================================================================
// 6. CANONICAL ACCESSORS & SCALES
// ============================================================================

export const THEME = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
  default: LIGHT_THEME,
} as const;

/** Motion scale — duration tokens + easings (exit faster than enter). */
export const MOTION = {
  duration: {
    fast: '100ms',
    base: '150ms',
    slow: '200ms',
    slower: '300ms',
  },
  easing: {
    standard: 'cubic-bezier(0.4, 0, 0.2, 1)',
    enter: 'cubic-bezier(0, 0, 0.2, 1)',
    exit: 'cubic-bezier(0.4, 0, 1, 1)',
    linear: 'cubic-bezier(0, 0, 1, 1)',
  },
} as const;

/** Named z-index scale — replaces ad-hoc 9500/9999/10000 values. */
export const Z_INDEX = {
  base: 0,
  sticky: 30,
  drawer: 1000,
  popover: 9000,
  dialog: 9500,
  toast: 9999,
  overlayTop: 10000,
} as const;

/** One breakpoint set (px) — replaces the 440/639/767/768/1023 scatter. */
export const BREAKPOINTS = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
} as const;

export { COMPONENT_STYLES } from "./component-styles";
