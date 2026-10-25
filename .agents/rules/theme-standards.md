# Theme Standards & Design System Enforcement

**Source of Truth (tokens)**: `apps/web/tokens/` — W3C DTCG JSON (`primitive.json`, `semantic.json`, `component.json`)  
**Generated Outputs (never hand-edit)**: `apps/web/src/lib/theme.ts` & `apps/web/src/styles/tokens.generated.css`  
**Legacy Preserved Presets**: `apps/web/src/lib/component-styles.ts` (see §3)

---

## 0. The Token System Is the Authority (DESIGN.md deleted 2026-10-22)

> **DIRECTIVE (spec 129, Shahzeb's order 2026-10-22)**: The design system lives **in code**, not in a prose document. The token files in `apps/web/tokens/` are the single source of truth for every frontend styling value. `apps/web/src/lib/theme.ts` and `apps/web/src/styles/tokens.generated.css` are **generated** from those tokens by Style Dictionary (`tokens:build`) and must never be hand-edited; CI runs `tokens:check` and fails on any drift between the token source and the committed generated outputs.
>
> Historical note: the repo-root `DESIGN.md` ("Binance Precision") was **deleted on 2026-10-22** (spec 129, PR-F1) and superseded by this token system. It is not an authority, must not be recreated, and must not be cited as one. The old "never modify DESIGN.md" immutability clause is void — there is no DESIGN.md.

To change a design value: edit the token JSON in `apps/web/tokens/`, run `pnpm --filter @fbuploadpro/web tokens:build`, and commit the token change **and** the regenerated outputs together.

---

## 1. The Cardinal Rule: Never Declare, Always Reference

AI agents and software engineers operating in this workspace MUST follow this non-negotiable directive:

> **ALL visual tokens, colors, borders, typography metrics, spacing units, corner radii, elevation shadows, and status signals MUST be imported and referenced directly from `apps/web/src/lib/theme.ts` (or consumed via CSS variables from the generated token CSS). NEVER declare, invent, or hardcode ad-hoc styling literals in component files. Components consume semantic tokens only; primitives in the token JSON are never referenced directly from component code.**

---

## 2. Forbidden Anti-Patterns vs. Mandated Patterns

### A. Color Declarations
* ❌ **FORBIDDEN**: Hardcoding hex codes, RGB, or HSL strings in inline styles, CSS, or Tailwind classes:
  ```tsx
  // VIOLATION: Ad-hoc hardcoded colors
  <div style={{ backgroundColor: '#000000', color: '#ffffff', borderColor: '#1f242d' }}>
  <button style={{ backgroundColor: '#fad734', color: '#000000' }}>Submit</button>
  <span style={{ color: '#2ebd85' }}>Active</span>
  ```
* ✅ **MANDATED**: Importing from `PALETTE`, `THEME`, or the legacy presets in `apps/web/src/lib/component-styles.ts` (`COMPONENT_STYLES`, re-exported from `apps/web/src/lib/theme.ts`):
  ```tsx
  // COMPLIANT: Referencing canonical tokens
  import { PALETTE, THEME, COMPONENT_STYLES } from '@/lib/theme';

  <div style={{ backgroundColor: THEME.default.surfaces.canvas, color: THEME.default.text.primary, borderColor: THEME.default.borders.hairline }}>
  <button style={COMPONENT_STYLES.primaryButton}>Submit</button>
  <span style={{ color: PALETTE.accent4 }}>Active</span>
  ```
  Or using CSS custom properties:
  ```tsx
  <div style={{ backgroundColor: 'var(--bg-canvas)', color: 'var(--text-main)', borderColor: 'var(--border-subtle)' }}>
  ```

---

### B. Status Indicators (Colour + Icon + Text — spec 129 OD-3)
* **DECIDED 2026-10-22 (OD-3, research pattern)**: Status is ALWAYS presented as **colour + icon + text** together. State never travels by colour alone (UX Rule 27). Use the `STATUS_SIGNALS` colours and labels alongside an icon and visible text (tags/badges per the UI decision matrix).
* ❌ **FORBIDDEN**: Colour-only status — a bare coloured dot, or status text coloured with no icon/label pairing:
  ```tsx
  // VIOLATION: Colour alone carries the state
  <span style={{ width: '6px', height: '6px', borderRadius: '9999px', backgroundColor: '#2ebd85' }} />
  ```
* ✅ **MANDATED**: Colour + icon + text, using `STATUS_SIGNALS` for the colour and label:
  ```tsx
  // COMPLIANT: Colour + icon + text
  import { STATUS_SIGNALS, THEME } from '@/lib/theme';

  <div style={{ display: 'flex', alignItems: 'center', gap: THEME.default.spacing.sm }}>
    <StatusIcon status="operational" color={STATUS_SIGNALS.operational.color} />
    <span style={{ color: THEME.default.text.primary, fontWeight: 600, fontSize: '0.875rem' }}>
      {STATUS_SIGNALS.operational.label}
    </span>
  </div>
  ```
  The former luminous-micro-dot mandate is **superseded** by this section (OD-3). The legacy `COMPONENT_STYLES.statusDot` preset survives only until its consumers convert to the primitives (deletion tracked in spec 129 T23); do not build new status UI on it.

---

### C. Borders & Hairlines
* ❌ **FORBIDDEN**: Arbitrary border widths, random gray borders, or thick outlines:
  ```tsx
  // VIOLATION: Arbitrary borders
  <div style={{ border: '1px solid #ccc' }}>
  <div style={{ border: '2px solid #333' }}>
  ```
* ✅ **MANDATED**: Explicit 1px hairline borders referencing the neutral token:
  ```tsx
  // COMPLIANT: 1px hairline definition
  <div style={{ border: `1px solid ${THEME.default.borders.hairline}` }}>
  // or
  <div style={{ border: '1px solid var(--border-subtle)' }}>
  ```

---

### D. Corner Radii & Spacing
* ❌ **FORBIDDEN**: Random pixel values (`borderRadius: '5px'`, `padding: '13px'`).
* ✅ **MANDATED**: Referencing `RADII` and `SPACING`:
  ```tsx
  import { RADII, SPACING } from '@/lib/theme';

  // Controls (4px), Buttons/Inputs (6px), Cards/Dialogs (8px)
  <div style={{ borderRadius: RADII.md, padding: SPACING.lg }}>
  ```

---

### E. Primary Action Buttons
* ❌ **FORBIDDEN**: Multiple solid yellow/gold buttons on the same view, or yellow buttons with low-contrast white text.
* ✅ **MANDATED**: Exactly ONE primary button per screen or major action surface, pairing Gold (`#fcd535`) with bold Pitch Black (`#000000`) text for 14.71:1 WCAG AAA contrast, using `COMPONENT_STYLES.primaryButton`.

---

## 3. Quick Reference: Token Hierarchy in `apps/web/src/lib/theme.ts`

`apps/web/src/lib/theme.ts` is **generated** from `apps/web/tokens/` — this table describes its export surface; the values themselves live in the token JSON.

| Token Group | Export Name | Sample Keys | Usage |
| :--- | :--- | :--- | :--- |
| **Primitives** | `PALETTE` | `primary`, `accent1`, `accent2`, `accent3`, `accent4`, `background`, `text`, `neutral` | Raw 8-color palette anchors |
| **Theme Modes** | `THEME.dark`, `THEME.light`, `THEME.default` | `surfaces.*`, `borders.*`, `text.*`, `shadows.*` | Active theme surface & text mapping |
| **Spacing** | `SPACING` | `xs` (4px), `sm` (8px), `md` (12px), `lg` (16px), `xl` (24px), `xxl` (32px), `xxxl` (48px) | Padding, margin, gap |
| **Radii** | `RADII` | `xs` (4px), `sm` (6px), `md` (8px), `full` (9999px) | Corner curvature |
| **Typography** | `TYPOGRAPHY` | `fontFamily`, `tabularNums`, `tracking.*`, `weights.*` | Fonts, letter-spacing, numbers |
| **Status** | `STATUS_SIGNALS` | `operational`, `queued`, `critical`, `idle` | Status colours & labels — always presented as colour + icon + text (§2.B) |
| **Scales** | `MOTION`, `Z_INDEX`, `BREAKPOINTS` | durations/easings, named z steps, one breakpoint set | Motion, stacking, responsive boundaries |
| **Component Presets (legacy)** | `COMPONENT_STYLES` | `primaryButton`, `secondaryButton()`, `input()`, `card()`, `statusDot()` | Preserved verbatim in `apps/web/src/lib/component-styles.ts`; superseded by the `components/shared/ui/` primitives and deleted preset-by-preset as consumers convert (spec 129 T23) |

---

## 4. Verification & Enforcement Gate

Enforcement is mechanical, not prose (spec 129 §5.4):

- **Token parity**: CI runs `tokens:check` (regenerate → diff → fail). A hand-edited generated file, or a token edit without regeneration, is a red build.
- **Literal ban**: Any pull request or code review that introduces hardcoded color literals (e.g., regex `#[0-9a-fA-F]{3,8}`) in component JSX/TSX files outside the token source and the generated files violates repository quality standards and will be blocked (guardrail/lint wiring: PR-F1 parity + PR-F2 enforcement).
