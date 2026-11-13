/**
 * Colour-delivery drift guard (spec 181 — official Snapchat palette).
 *
 * The brand accent is Snap Yellow #FFFC00 (official Snapchat palette,
 * Snap's own brand guidelines April 2025), carried by the design-token
 * pipeline (tokens/primitive.json -> generated CSS + theme.ts). White on
 * #FFFC00 is 1.10:1, so on-accent text is black #000000 (19.18:1); light
 * accent text and the focus ring go through the deep-yellow step #716400
 * (5.70:1 on canvas). These assertions fail if any copy of the palette
 * drifts from the others, so the configuration cannot silently fork — and
 * they fail on the old Cyber Yellow values, so a revert is caught.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DARK_THEME, LIGHT_THEME, PALETTE, STATUS_SIGNALS } from '@/lib/theme';

type ColourToken = { $value: string };
type PrimitiveColour = {
  alpha: Record<string, ColourToken>;
  border: Record<string, ColourToken>;
  brand: Record<string, ColourToken>;
  status: Record<string, ColourToken>;
  text: Record<string, ColourToken>;
};

const generatedCss = readFileSync(
  path.resolve(process.cwd(), 'src/styles/tokens.generated.css'),
  'utf8'
);
const themeTs = readFileSync(
  path.resolve(process.cwd(), 'src/lib/theme.ts'),
  'utf8'
);
const primitiveTokens = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tokens/primitive.json'), 'utf8')
) as { color: PrimitiveColour };
const semanticTokens = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'tokens/semantic.json'), 'utf8')
) as {
  semantic: {
    dark: { border: { focus: ColourToken } };
    light: { border: { focus: ColourToken } };
  };
};
const buttonSource = readFileSync(
  path.resolve(
    process.cwd(),
    'src/components/shared/ui/button.tsx'
  ),
  'utf8'
);

/** WCAG 2.x relative luminance + contrast ratio (same formula the spec used). */
function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const channel = (i: number): number => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
  );
}
function contrastRatio(fg: string, bg: string): number {
  const hi = Math.max(luminance(fg), luminance(bg));
  const lo = Math.min(luminance(fg), luminance(bg));
  return (hi + 0.05) / (lo + 0.05);
}

describe('colours (spec 181 — official Snapchat palette)', () => {
  it('declares Snap Yellow as the accent — not Cyber Yellow', () => {
    const brand = primitiveTokens.color.brand;
    expect(brand.gold.$value).toBe('#FFFC00');
    expect(brand.peru.$value).toBe('#FCF000');
    expect(brand.pale.$value).toBe('#FEFF85');
    expect(brand.bronze.$value).toBe('#716400');
    // Untouched by the change: Facebook blue and the legacy emerald
    // (kept — dozens of success surfaces still consume brand-emerald).
    expect(brand.facebook.$value).toBe('#1877f2');
    expect(brand.emerald.$value).toBe('#0ecb81');
  });

  it('puts black text on the accent — white on #FFFC00 is forbidden', () => {
    expect(primitiveTokens.color.text.onPrimary.$value).toBe('#000000');
    // 1.10:1 — white on the accent fails AA outright; the pairing the
    // app actually ships (black on accent) passes by a wide margin.
    expect(contrastRatio('#FFFFFF', '#FFFC00')).toBeLessThan(4.5);
    expect(contrastRatio('#000000', '#FFFC00')).toBeGreaterThanOrEqual(19);
    // The accent itself is unusable as light-mode text (1.05:1).
    expect(contrastRatio('#FFFC00', '#FAFAF9')).toBeLessThan(4.5);
  });

  it('uses solid deep-yellow focus and links in light mode, accent in dark', () => {
    expect(semanticTokens.semantic.light.border.focus.$value).toBe(
      '{color.brand.bronze}'
    );
    expect(semanticTokens.semantic.dark.border.focus.$value).toBe(
      '{color.brand.gold}'
    );
    expect(contrastRatio('#716400', '#FAFAF9')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#FFFC00', '#0C0A09')).toBeGreaterThanOrEqual(4.5);
    // The translucent goldFocus token is deleted — focus is solid now.
    expect(primitiveTokens.color.alpha.goldFocus).toBeUndefined();
    expect(primitiveTokens.color.alpha.goldHalo.$value).toBe(
      'rgba(255, 252, 0, 0.50)'
    );
  });

  it('declares the spec 181 status system and input borders', () => {
    const status = primitiveTokens.color.status;
    expect(status.warningLight.$value).toBe('#C2410C');
    expect(status.warningDark.$value).toBe('#FB923C');
    expect(status.warningSoftLight.$value).toBe('#FFF7ED');
    expect(status.warningSoftDark.$value).toBe('#422E22');
    expect(status.warningSolidLight.$value).toBe('#EA580C');
    expect(status.warningSolidDark.$value).toBe('#F97316');
    expect(status.infoLight.$value).toBe('#1D4ED8');
    expect(status.infoDark.$value).toBe('#60A5FA');
    expect(status.infoSoftLight.$value).toBe('#EFF6FF');
    expect(status.infoSoftDark.$value).toBe('#30343E');
    expect(status.infoSolidLight.$value).toBe('#2563EB');
    expect(status.infoSolidDark.$value).toBe('#3B82F6');
    expect(status.successSoftLight.$value).toBe('#F0FDF4');
    expect(status.successSoftDark.$value).toBe('#2D3B2F');
    expect(status.successSolidLight.$value).toBe('#16A34A');
    expect(status.successSolidDark.$value).toBe('#22C55E');
    expect(status.criticalSoftLight.$value).toBe('#FEF2F2');
    expect(status.criticalSoftDark.$value).toBe('#422E2D');
    expect(status.criticalSolidLight.$value).toBe('#DC2626');
    expect(status.criticalSolidDark.$value).toBe('#EF4444');
    // Error text on a soft background uses the on-tint step, not rose.
    expect(status.criticalOnTintLight.$value).toBe('#b91c1c');
    // Input borders pass the 3:1 non-text rule in both modes.
    expect(primitiveTokens.color.border.lightInput.$value).toBe('#78716C');
    expect(primitiveTokens.color.border.darkInput.$value).toBe('#A8A29E');
    expect(contrastRatio('#78716C', '#FFFFFF')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio('#A8A29E', '#292524')).toBeGreaterThanOrEqual(3);
    // Light strong border is the official Snapchat Light Grey.
    expect(primitiveTokens.color.border.lightStrong.$value).toBe('#D9D9D9');
    // Every status text on its soft background passes AA text (4.5:1).
    const softPairs: Array<[string, string]> = [
      ['#C2410C', '#FFF7ED'],
      ['#1D4ED8', '#EFF6FF'],
      ['#B91C1C', '#FEF2F2'],
      ['#15803D', '#F0FDF4'],
      ['#FB923C', '#422E22'],
      ['#60A5FA', '#30343E'],
      ['#F87171', '#422E2D'],
      ['#4ADE80', '#2D3B2F'],
    ];
    for (const [fg, bg] of softPairs) {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('matches the generated CSS variables the app consumes', () => {
    expect(generatedCss).toContain('--color-brand-gold: #FFFC00;');
    expect(generatedCss).toContain('--color-brand-peru: #FCF000;');
    expect(generatedCss).toContain('--color-brand-pale: #FEFF85;');
    expect(generatedCss).toContain('--color-brand-bronze: #716400;');
    expect(generatedCss).toContain('--color-text-on-primary: #000000;');
    expect(generatedCss).toContain(
      '--color-alpha-gold-halo: rgba(255, 252, 0, 0.50);'
    );
    expect(generatedCss).toContain('--border-focus: #716400;');
    expect(generatedCss).toContain('--border-focus: #FFFC00;');
    expect(generatedCss).toContain('--border-strong: #D9D9D9;');
    expect(generatedCss).toContain('--text-link: #716400;');
    expect(generatedCss).toContain('--text-link: #FFFC00;');
    // No old accent value and no deleted token survive in the output.
    expect(generatedCss).not.toContain('#FFD300');
    expect(generatedCss).not.toContain('#FCD535');
    expect(generatedCss).not.toContain('#F38020');
    expect(generatedCss).not.toContain('#CFFF04');
    expect(generatedCss).not.toContain('#181a20');
    expect(generatedCss).not.toContain('gold-focus');
    expect(generatedCss).not.toContain('rgba(255, 211, 0');
  });

  it('matches the theme export components still consume', () => {
    expect(PALETTE.primary).toBe('#FFFC00');
    expect(PALETTE.accent1).toBe('#FCF000');
    expect(PALETTE.accent2).toBe('#716400');
    expect(PALETTE.accent4).toBe('#0ecb81');
    expect(LIGHT_THEME.text.onPrimary).toBe('#000000');
    expect(DARK_THEME.text.onPrimary).toBe('#000000');
    expect(LIGHT_THEME.borders.focus).toBe('#716400');
    expect(DARK_THEME.borders.focus).toBe('#FFFC00');
    expect(LIGHT_THEME.text.link).toBe('#716400');
    expect(DARK_THEME.text.link).toBe('#FFFC00');
    expect(LIGHT_THEME.borders.strong).toBe('#D9D9D9');
    expect(STATUS_SIGNALS.queued.color).toBe('#FFFC00');
    expect(STATUS_SIGNALS.queued.halo).toBe(
      '0 0 8px rgba(255, 252, 0, 0.50)'
    );
    expect(themeTs).not.toContain('#FFD300');
    expect(themeTs).not.toContain('#181a20');
    expect(themeTs).not.toContain('rgba(255, 211, 0');
  });

  it('gives primary buttons a visible light-mode border (spec 181)', () => {
    // #FFFC00 fill vs light canvas is ~1.05:1, so the button needs the
    // 1px deep-yellow border to be visible. In dark mode the border is
    // the fill colour (invisible) — effectively light-only.
    expect(buttonSource).toContain('border border-link bg-primary');
    expect(buttonSource).toContain('dark:hover:bg-brand-pale');
    expect(contrastRatio('#716400', '#FFFC00')).toBeGreaterThanOrEqual(3);
  });
});
