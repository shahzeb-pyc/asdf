/**
 * Shared Style Dictionary configuration for the FBUploadPro design tokens
 * (spec 129, PR-F1). The single source of truth is apps/web/tokens/*.json
 * (W3C DTCG). This module generates:
 *   (a) src/styles/tokens.generated.css — CSS custom properties
 *   (b) src/lib/theme.ts               — TypeScript theme (export shape preserved)
 *
 * Both outputs are GENERATED — never hand-edit them. Edit the token JSON and
 * run `pnpm --filter @fbuploadpro/web tokens:build`; CI runs `tokens:check`
 * to prove the committed outputs match the token source byte-for-byte.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const webRoot = path.resolve(here, '..');
const tokensGlob = path.join(webRoot, 'tokens', '*.json');

const GENERATED_CSS_BANNER = [
  '/* ============================================================================',
  ' * GENERATED — do not edit; source: apps/web/tokens/',
  ' * Regenerate with: pnpm --filter @fbuploadpro/web tokens:build',
  ' * ========================================================================== */',
  '',
].join('\n');

const GENERATED_TS_BANNER = [
  '/**',
  ' * GENERATED — do not edit; source: apps/web/tokens/',
  ' * Regenerate with: pnpm --filter @fbuploadpro/web tokens:build',
  ' *',
  ' * Canonical Design System Theme Configuration & Tokens for FBUploadPro Webapp.',
  ' * Hand-edit the DTCG token JSON in apps/web/tokens/ only — this file is a',
  ' * generated mirror. CI (tokens:check) fails if it drifts from the source.',
  ' */',
  '',
].join('\n');

/** Render a resolved token value to a plain string for CSS/TS output. */
function renderValue(token) {
  const value = token.$value ?? token.value;
  if (Array.isArray(value)) {
    // DTCG cubicBezier
    return `cubic-bezier(${value.join(', ')})`;
  }
  if (value && typeof value === 'object') {
    // DTCG dimension / duration object form { value, unit }
    return `${value.value}${value.unit}`;
  }
  return String(value);
}

function kebab(parts) {
  return parts
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase())
    .join('-');
}

/**
 * Explicit CSS variable names for the semantic tokens, preserving the
 * variable contract the shipped globals.css established (consumed by
 * PR-F2's tokens layer). Keyed by token path without the mode segment.
 */
const SEMANTIC_CSS_VARS = {
  'surface.canvas': '--bg-canvas',
  'surface.panel': '--bg-panel',
  'surface.subtle': '--bg-subtle',
  'surface.hover': '--bg-hover',
  'surface.active': '--bg-active',
  'text.primary': '--text-main',
  'text.secondary': '--text-sub',
  'text.muted': '--text-dim',
  'text.onPrimary': '--text-on-primary',
  'text.link': '--text-link',
  'border.hairline': '--border-subtle',
  'border.strong': '--border-strong',
  'border.focus': '--border-focus',
  'shadow.card': '--shadow-card',
  'shadow.elevated': '--shadow-elevated',
  'shadow.modal': '--shadow-modal',
  'status.operational.color': '--signal-operational',
  'status.queued.color': '--signal-queued',
  'status.critical.color': '--signal-critical',
  'status.critical.onTint': '--signal-critical-on-tint',
  'status.idle.color': '--signal-idle',
  'status.idle.dot': '--signal-idle-dot',
};

function cssVarFor(token) {
  const p = token.path;
  if (p[0] === 'semantic') {
    const key = p.slice(2).join('.');
    const mapped = SEMANTIC_CSS_VARS[key];
    if (!mapped) throw new Error(`No CSS variable mapping for semantic token ${p.join('.')}`);
    return mapped;
  }
  return `--${kebab(p)}`;
}

function sortedTokens(dictionary) {
  return [...dictionary.allTokens].sort((a, b) =>
    a.path.join('.').localeCompare(b.path.join('.')),
  );
}

function formatTokensCss({ dictionary }) {
  const tokens = sortedTokens(dictionary);
  const primitives = tokens.filter((t) => t.path[0] !== 'semantic');
  // Status dot colours duplicate the status colour var for every status
  // except idle (whose dot differs); emit only the distinct idle dot var.
  const isDuplicateStatusDot = (t) =>
    t.path[2] === 'status' && t.path[4] === 'dot' && t.path[3] !== 'idle';
  const dark = tokens.filter(
    (t) => t.path[0] === 'semantic' && t.path[1] === 'dark' && !isDuplicateStatusDot(t),
  );
  const light = tokens.filter(
    (t) => t.path[0] === 'semantic' && t.path[1] === 'light' && !isDuplicateStatusDot(t),
  );

  const block = (selector, list, comment) => {
    const lines = list.map((t) => `  ${cssVarFor(t)}: ${renderValue(t)};`);
    return `${comment}\n${selector} {\n${lines.join('\n')}\n}`;
  };

  return [
    GENERATED_CSS_BANNER,
    block(':root', primitives, '/* Primitives + scales (mode-independent) */'),
    '',
    block(
      ':root, [data-theme="dark"]',
      dark,
      '/* Semantic tokens — dark */',
    ),
    '',
    block('[data-theme="light"]', light, '/* Semantic tokens — light */'),
    '',
  ].join('\n');
}

function formatThemeTs({ dictionary }) {
  const byPath = new Map(dictionary.allTokens.map((t) => [t.path.join('.'), t]));
  const val = (p) => {
    const token = byPath.get(p);
    if (!token) throw new Error(`Missing token ${p}`);
    return renderValue(token);
  };
  const q = (p) => `'${val(p)}'`;

  const statusEntry = (mode, key, label) => {
    const haloAlpha = val(
      {
        operational: 'color.alpha.emeraldHalo',
        queued: 'color.alpha.goldHalo',
        critical: 'color.alpha.roseHalo',
        idle: 'color.alpha.idleHalo',
      }[key],
    );
    const haloBlur = key === 'idle' ? '4px' : '8px';
    const lines = [
      `    color: ${q(`semantic.${mode}.status.${key}.color`)},`,
      `    dot: ${q(`semantic.${mode}.status.${key}.dot`)},`,
    ];
    if (key === 'idle') {
      lines.push(`    dotLight: ${q('semantic.light.status.idle.dot')},`);
    }
    lines.push(`    halo: '0 0 ${haloBlur} ${haloAlpha}',`);
    lines.push(`    label: '${label}',`);
    return `  ${key}: {\n${lines.join('\n')}\n  },`;
  };

  const themeObject = (mode) => {
    const s = (k) => q(`semantic.${mode}.${k}`);
    return [
      `  mode: '${mode}',`,
      '  surfaces: {',
      `    canvas: ${s('surface.canvas')},`,
      `    panel: ${s('surface.panel')},`,
      `    subtle: ${s('surface.subtle')},`,
      `    hover: ${s('surface.hover')},`,
      `    active: ${s('surface.active')},`,
      '  },',
      '  borders: {',
      `    hairline: ${s('border.hairline')},`,
      `    strong: ${s('border.strong')},`,
      `    focus: ${s('border.focus')},`,
      '  },',
      '  text: {',
      `    primary: ${s('text.primary')},`,
      `    secondary: ${s('text.secondary')},`,
      `    muted: ${s('text.muted')},`,
      `    onPrimary: ${s('text.onPrimary')},`,
      `    link: ${s('text.link')},`,
      '  },',
      '  shadows: {',
      `    card: ${s('shadow.card')},`,
      `    elevated: ${s('shadow.elevated')},`,
      `    modal: ${s('shadow.modal')},`,
      '  },',
      '  status: STATUS_SIGNALS,',
      '  spacing: SPACING,',
      '  radii: RADII,',
      '  typography: TYPOGRAPHY,',
      '}',
    ].join('\n');
  };

  return `${GENERATED_TS_BANNER}
// ============================================================================
// 1. PRIMITIVE PALETTE (Official 8-Color Palette)
// ============================================================================

export const PALETTE = {
  /** Dominant brand keystone — primary buttons, active moments (14.86:1 AAA on black) */
  primary: ${q('color.brand.gold')},
  /** Secondary highlight — links, callouts, active underline tabs */
  accent1: ${q('color.brand.peru')},
  /** Deep bronze — tertiary highlight, active tab borders, deep pressed states */
  accent2: ${q('color.brand.bronze')},
  /** Rose / Danger — negative status, error states, sell indicator, critical alerts */
  accent3: ${q('color.brand.rose')},
  /** Emerald / Success — positive status, operational states, buy indicator, success */
  accent4: ${q('color.brand.emerald')},
  /** Pitch Black — base canvas surface in dark mode */
  background: ${q('color.neutral.black')},
  /** Pure White — readable foreground typography in dark mode (21.0:1 AAA on black) */
  text: ${q('color.neutral.white')},
  /** Pitch Slate — 1px hairline borders, dividers, subtle recessed UI surfaces */
  neutral: ${q('color.neutral.slate')},
} as const;

export type PaletteKey = keyof typeof PALETTE;

// ============================================================================
// 2. SPATIAL GRID & CORNER RADII TOKENS
// ============================================================================

export const SPACING = {
  /** 4px: Micro gaps, inline icon margins */
  xs: ${q('space.xs')},
  /** 8px: Compact element spacing, input internal padding Y */
  sm: ${q('space.sm')},
  /** 12px: Standard control padding X */
  md: ${q('space.md')},
  /** 16px: Standard container padding, card inner margins */
  lg: ${q('space.lg')},
  /** 24px: Card sectional gap, grid gutters */
  xl: ${q('space.xl')},
  /** 32px: Page section rhythm */
  xxl: ${q('space.xxl')},
  /** 48px: Major boundary margins */
  xxxl: ${q('space.xxxl')},
} as const;

export const RADII = {
  /** 4px: Checkboxes, micro switches, segmented toggles */
  xs: ${q('radius.xs')},
  /** 6px: Primary/Secondary buttons, form text inputs, select triggers */
  sm: ${q('radius.sm')},
  /** 8px: Cards, data tables, sheet containers, dialog modals */
  md: ${q('radius.md')},
  /** 9999px: Strictly reserved for circular avatars and round indicators. */
  full: ${q('radius.full')},
} as const;

// ============================================================================
// 3. OPTICAL TYPOGRAPHY METRICS
// ============================================================================

export const TYPOGRAPHY = {
  fontFamily: ${q('font.family.sans')},
  mono: ${q('font.family.mono')},
  fontFeatureSettings: "${val('font.featureSettings')}",
  tabularNums: ${q('font.tabularNums')},
  tracking: {
    display: ${q('font.tracking.display')},
    h1: ${q('font.tracking.h1')},
    h2: ${q('font.tracking.h2')},
    h3: ${q('font.tracking.h3')},
    body: ${q('font.tracking.body')},
    caption: ${q('font.tracking.caption')},
  },
  weights: {
    regular: ${val('font.weight.regular')},
    medium: ${val('font.weight.medium')},
    semibold: ${val('font.weight.semibold')},
    bold: ${val('font.weight.bold')},
    heavy: ${val('font.weight.heavy')},
  },
} as const;

// ============================================================================
// 4. STATUS SIGNALS (colour + icon + text — spec 129 OD-3; never colour alone)
// ============================================================================

export const STATUS_SIGNALS = {
${statusEntry('dark', 'operational', 'Operational')}
${statusEntry('dark', 'queued', 'Queued')}
${statusEntry('dark', 'critical', 'Critical')}
${statusEntry('dark', 'idle', 'Idle')}
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
${themeObject('dark')};

export const LIGHT_THEME: ThemeTokens = {
${themeObject('light')};

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
    fast: ${q('motion.duration.fast')},
    base: ${q('motion.duration.base')},
    slow: ${q('motion.duration.slow')},
    slower: ${q('motion.duration.slower')},
  },
  easing: {
    standard: ${q('motion.easing.standard')},
    enter: ${q('motion.easing.enter')},
    exit: ${q('motion.easing.exit')},
    linear: ${q('motion.easing.linear')},
  },
} as const;

/** Named z-index scale — replaces ad-hoc 9500/9999/10000 values. */
export const Z_INDEX = {
  base: ${val('zIndex.base')},
  sticky: ${val('zIndex.sticky')},
  drawer: ${val('zIndex.drawer')},
  popover: ${val('zIndex.popover')},
  dialog: ${val('zIndex.dialog')},
  toast: ${val('zIndex.toast')},
  overlayTop: ${val('zIndex.overlayTop')},
} as const;

/** One breakpoint set (px) — replaces the 440/639/767/768/1023 scatter. */
export const BREAKPOINTS = {
  sm: ${q('breakpoint.sm')},
  md: ${q('breakpoint.md')},
  lg: ${q('breakpoint.lg')},
  xl: ${q('breakpoint.xl')},
} as const;

export { COMPONENT_STYLES } from "./component-styles";
`;
}

export function makeTokenConfig({ cssDestination, tsDestination }) {
  return {
    source: [tokensGlob],
    hooks: {
      formats: {
        'fbu/css-tokens': formatTokensCss,
        'fbu/ts-theme': formatThemeTs,
      },
    },
    platforms: {
      css: {
        buildPath: `${path.dirname(cssDestination)}${path.sep}`,
        files: [
          {
            destination: path.basename(cssDestination),
            format: 'fbu/css-tokens',
          },
        ],
      },
      ts: {
        buildPath: `${path.dirname(tsDestination)}${path.sep}`,
        files: [
          {
            destination: path.basename(tsDestination),
            format: 'fbu/ts-theme',
          },
        ],
      },
    },
  };
}

export const defaultDestinations = {
  cssDestination: path.join(webRoot, 'src', 'styles', 'tokens.generated.css'),
  tsDestination: path.join(webRoot, 'src', 'lib', 'theme.ts'),
};
