/** @vitest-environment jsdom */
/**
 * Login showcase panel — behavioural suite.
 *
 * Migrated in spec 136 PR-136A from the legacy static-markup suite
 * (which asserted byte-level inline styles) when the panel was
 * rebuilt on design tokens: the expectations are unchanged — the
 * approved copy of spec 136 §3.1, verbatim, with the headline as
 * the page's sole top-level heading — but they are asserted on the
 * rendered DOM (text, structure, token classes), not on style
 * strings. Accent/structure checks target the token utilities
 * (text-primary) that replaced the inline styles.
 *
 * login-fixes migration: the approved Option 1 / v3 redesign
 * dropped the brand tagline and the separate platform line, made
 * the headline two lines (first phrase on one line), and removed
 * the hairline dividers between feature rows (spacing alone
 * separates them). Those expectations are updated here; the
 * approved copy itself is unchanged.
 */
import * as React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { LoginShowcasePanel } from "@/components/auth/login-showcase-panel";
import LoginPage from "@/app/login/page";

const SUBHEAD =
  "Schedule reels and posts across Facebook, Instagram, TikTok, YouTube, Threads, and X — they publish on time, even when your device is off.";

const FEATURES: ReadonlyArray<{ title: string; desc: string }> = [
  {
    title: "Post from anywhere",
    desc: "Schedule from your phone or laptop; publishing runs in the cloud.",
  },
  {
    title: "Every platform, one dashboard",
    desc: "Connect each account once, then run everything from a single place.",
  },
  {
    title: "Your accounts stay yours",
    desc: "You sign in on each platform itself, so we never see your passwords.",
  },
];

describe("Login Showcase Panel (Spec 061 copy, spec 136 token rebuild)", () => {
  it("renders brand row with logo mark and bold title, and no tagline", () => {
    const { container } = render(<LoginShowcasePanel />);

    expect(screen.getByText("FBUploadPro")).toBeTruthy();
    // Option 1 redesign: the tagline repeated the headline, so it
    // was dropped as approved — it must not come back.
    expect(screen.queryByText("Content automation for creators")).toBeNull();
    // BrandMark presence via its SVG aria-label
    expect(container.innerHTML).toContain('aria-label="FBUploadPro"');
  });

  it("renders the unboxed eyebrow in the accent colour, uppercase with wide tracking", () => {
    render(<LoginShowcasePanel />);

    const eyebrow = screen.getByText("CREATE · SCHEDULE · GROW");
    expect(eyebrow.className).toContain("uppercase");
    expect(eyebrow.className).toContain("tracking-widest");
    expect(eyebrow.className).toContain("text-primary");
  });

  it("renders the two-line headline as the sole h1, final segment in the accent colour", () => {
    const { container } = render(<LoginShowcasePanel />);

    const headings = container.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    const headline = headings[0]!;
    // The approved v3 line structure: one line break, two lines —
    // the first phrase on one line, the gold segment on the second.
    expect(headline.querySelectorAll("br")).toHaveLength(1);
    expect(headline.textContent).toContain("Your pages, posting themselves —");
    const accent = within(headline).getByText("100% on the cloud.");
    expect(accent.className).toContain("text-primary");
  });

  it("renders the exact approved subhead", () => {
    render(<LoginShowcasePanel />);
    expect(screen.getByText(SUBHEAD)).toBeTruthy();
  });

  it("renders all three feature rows with accent icons and no divider lines", () => {
    const { container } = render(<LoginShowcasePanel />);

    for (const feature of FEATURES) {
      expect(screen.getByText(feature.title)).toBeTruthy();
      expect(screen.getByText(feature.desc)).toBeTruthy();
    }

    // One accent icon per row, in the token accent colour.
    const icons = container.querySelectorAll("svg.lucide");
    expect(icons.length).toBeGreaterThanOrEqual(FEATURES.length);
    for (const icon of icons) {
      expect(icon.getAttribute("class")).toContain("text-primary");
    }

    // Option 1 redesign: no divider lines — spacing alone
    // separates the rows, so no row carries a bottom border.
    const rows = FEATURES.map((feature) => screen.getByText(feature.title).parentElement!.parentElement!);
    for (const row of rows) {
      expect(row!.className).not.toContain("border-b");
    }
  });

  it("renders trust footer with zero forbidden links or emojis, and no separate platform line", () => {
    const { container } = render(<LoginShowcasePanel />);

    // Option 1 redesign: the separate platform line was dropped as
    // approved — the platforms live in the subhead instead.
    expect(screen.queryByText("Facebook · Instagram · TikTok · YouTube · Threads · X")).toBeNull();
    expect(screen.getByText(SUBHEAD)).toBeTruthy();
    expect(screen.getByText("Sign in on the platforms themselves · Your data is encrypted")).toBeTruthy();

    // Strictly forbidden by the approved record (§3.1 absent list).
    expect(screen.queryByText("See how it works")).toBeNull();
    expect(container.innerHTML).not.toContain("See how it works");
    expect(container.querySelector('a[href*="how"]')).toBeNull();
    // Zero emoji unicode characters.
    expect(/[\u{1F300}-\u{1F9FF}]/u.test(container.innerHTML)).toBe(false);
  });

  it("renders inside LoginPage with the welcome-back subtext and the showcase", () => {
    const { container } = render(<LoginPage />);

    // Left card subtext (approved welcome-back copy).
    expect(
      screen.getByText("Welcome back. Sign in to your workspace.")
    ).toBeTruthy();

    // The showcase panel within the login page, still the sole h1.
    expect(screen.getByText("CREATE · SCHEDULE · GROW")).toBeTruthy();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    for (const feature of FEATURES) {
      expect(screen.getByText(feature.title)).toBeTruthy();
    }

    // Responsive contract, in utility form: the showcase section is
    // hidden below the lg breakpoint, and the mobile brand header is
    // present inside the form panel instead.
    const showcase = container.querySelector('section[aria-label="FBUploadPro Showcase"]');
    expect(showcase).not.toBeNull();
    expect(showcase!.className).toContain("hidden");
    expect(showcase!.className).toContain("lg:block");
    const formPanel = container.querySelector("main");
    expect(formPanel).not.toBeNull();
    expect(within(formPanel as HTMLElement).getByText("FBUploadPro")).toBeTruthy();
  });
});
