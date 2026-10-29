/**
 * Viewport + safe-area foundation contracts (spec 142, F03 / PR-M142-2).
 *
 * These are SOURCE contract tests in the style of tests/fonts.test.ts:
 * jsdom cannot evaluate `env(safe-area-inset-*)` (it computes to nothing
 * there) and Playwright cannot emulate non-zero safe-area insets, so the
 * foundation is pinned at the source level instead — the exact viewport
 * export, the exact utility → env() mappings in globals.css, and the
 * exact safe-area applications in the shared Toast and Sidebar. A real
 * notched-device check remains the closing evidence (see PR body).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const layout = read('src/app/layout.tsx');
const globals = read('src/app/globals.css');
const toastSource = read('src/components/shared/ui/toast.tsx');
const sidebarSource = read('src/components/shared/ui/sidebar.tsx');

/** Extract the declaration body of one `@utility <name> { … }` block. */
function utilityBody(name: string): string | null {
  const match = globals.match(new RegExp(`@utility ${name} \\{([^}]*)\\}`));
  return match?.[1] ?? null;
}

describe('root viewport export (spec 142 F03)', () => {
  it('imports the Viewport type from next', () => {
    expect(layout).toMatch(/import type \{[^}]*\bViewport\b[^}]*\} from 'next';/);
  });

  it('exports a viewport with device-width, initialScale 1 and viewportFit cover', () => {
    const match = layout.match(/export const viewport: Viewport = \{([^}]*)\};/);
    expect(match, 'layout.tsx must export `viewport: Viewport`').not.toBeNull();
    const body = match?.[1] ?? '';
    expect(body).toContain("width: 'device-width'");
    expect(body).toMatch(/initialScale:\s*1\b/);
    expect(body).toContain("viewportFit: 'cover'");
  });

  it('does NOT put viewportFit inside the metadata export (Next ignores it there)', () => {
    // Match the metadata object literal itself — prose comments between
    // the two exports legitimately discuss the viewport.
    const metadataBlock = layout.match(/export const metadata: Metadata = \{[\s\S]*?\n\};/)?.[0] ?? '';
    expect(metadataBlock).not.toBe('');
    expect(metadataBlock).not.toContain('viewportFit');
    expect(metadataBlock).not.toContain('viewport');
    expect(layout.indexOf('export const viewport')).toBeGreaterThan(
      layout.indexOf('export const metadata')
    );
  });

  it('never disables pinch zoom (no maximumScale, no userScalable false)', () => {
    const viewportBody =
      layout.match(/export const viewport: Viewport = \{([^}]*)\};/)?.[1] ?? '';
    expect(viewportBody).not.toContain('maximumScale');
    expect(viewportBody).not.toContain('userScalable');
  });

  it('leaves the themeInitScript body byte-identical (spec 139 PR #677 pins its SHA-256)', () => {
    const match = layout.match(/const themeInitScript = `([\s\S]*?)`;/);
    expect(match, 'themeInitScript template literal must exist').not.toBeNull();
    const hash = createHash('sha256').update(match?.[1] ?? '', 'utf8').digest('hex');
    // Re-pinned for the approved Direction 4 light-first change to themeInitScript (was the spec 139 hash above in history); the pin still guards against unintended changes.
    expect(hash).toBe('1b8edd924e4ed3b4d9c6308b6e00c3e32170f98bb4273a89c0e898f87e1e6275');
  });
});

describe('globals.css safe-area utilities (spec 142 F03)', () => {
  it.each([
    ['pt-safe', 'padding-top: env(safe-area-inset-top);'],
    ['pb-safe', 'padding-bottom: env(safe-area-inset-bottom);'],
    ['pl-safe', 'padding-left: env(safe-area-inset-left);'],
    ['pr-safe', 'padding-right: env(safe-area-inset-right);'],
  ])('defines @utility %s mapping to the correct env() inset', (name, declaration) => {
    const body = utilityBody(name);
    expect(body, `@utility ${name} must exist in globals.css`).not.toBeNull();
    expect(body).toContain(declaration);
  });

  it('defines the composed pb-safe-offset utility for fixed bottom elements', () => {
    const body = utilityBody('pb-safe-offset');
    expect(body, '@utility pb-safe-offset must exist in globals.css').not.toBeNull();
    // max(<base>, env(safe-area-inset-bottom)): the token base keeps a
    // minimum clearance when the inset is 0, the inset wins on notched
    // devices.
    expect(body).toContain(
      'padding-bottom: max(var(--space-lg), env(safe-area-inset-bottom));'
    );
  });
});

describe('shared Toast safe-area defaults (spec 142 F03)', () => {
  it('defaults mobileOffset bottom to max(16px, env(safe-area-inset-bottom))', () => {
    expect(toastSource).toContain(
      'mobileOffset={props.mobileOffset ?? { bottom: "max(16px, env(safe-area-inset-bottom))" }}'
    );
  });

  it('defaults offset bottom to max(24px, env(safe-area-inset-bottom)) (Sonner desktop base preserved)', () => {
    expect(toastSource).toContain(
      'offset={props.offset ?? { bottom: "max(24px, env(safe-area-inset-bottom))" }}'
    );
  });

  it('sets the defaults BEFORE the {...props} spread so callers can override', () => {
    // Scope to the Sonner JSX — the header comment also mentions the
    // spread when documenting this ordering.
    const jsx = toastSource.slice(toastSource.indexOf('<Sonner\n'));
    const spreadIndex = jsx.indexOf('{...props}');
    expect(spreadIndex).toBeGreaterThanOrEqual(0);
    expect(jsx.indexOf('offset={props.offset')).toBeLessThan(spreadIndex);
    expect(jsx.indexOf('mobileOffset={props.mobileOffset')).toBeLessThan(spreadIndex);
  });
});

describe('shared Sidebar mobile sheet safe padding (spec 142 F03)', () => {
  const mobileStart = sidebarSource.indexOf('if (isMobile) {');
  const desktopStart = sidebarSource.indexOf('group peer hidden');
  const mobileSheet = sidebarSource.slice(mobileStart, desktopStart);
  const desktopRail = sidebarSource.slice(desktopStart);

  it('locates the mobile sheet branch before the desktop rail', () => {
    expect(mobileStart).toBeGreaterThanOrEqual(0);
    expect(desktopStart).toBeGreaterThan(mobileStart);
  });

  it('applies pt-safe and pb-safe to the mobile sheet content', () => {
    expect(mobileSheet).toContain('pt-safe');
    expect(mobileSheet).toContain('pb-safe');
  });

  it('applies the anchored-edge safe padding (pl-safe left / pr-safe right)', () => {
    expect(mobileSheet).toContain('pl-safe');
    expect(mobileSheet).toContain('pr-safe');
  });

  it('does NOT apply safe padding to the desktop rail', () => {
    expect(desktopRail).not.toContain('pt-safe');
    expect(desktopRail).not.toContain('pb-safe');
    expect(desktopRail).not.toContain('pl-safe');
    expect(desktopRail).not.toContain('pr-safe');
    expect(desktopRail).not.toContain('pb-safe-offset');
  });
});
