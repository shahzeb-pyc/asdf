/** @vitest-environment jsdom */
/**
 * Route boundary tests (spec 137 §3.4.3 / PR-A2, T28).
 *
 * Behavioural: each boundary renders its designed state, the error
 * boundary reports through the reportError seam and its Retry invokes
 * `reset`, and global-error renders standalone (its own <html>/<body>).
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/tenant/acme/accounts",
}));

import RootError from "@/app/error";
import RootNotFound from "@/app/not-found";
import RootLoading from "@/app/loading";
import GlobalError from "@/app/global-error";
import TenantError from "@/app/tenant/[subdomain]/error";
import TenantNotFound from "@/app/tenant/[subdomain]/not-found";
import TenantLoading from "@/app/tenant/[subdomain]/loading";
import AccountsLoading from "@/app/tenant/[subdomain]/accounts/loading";
import PagesLoading from "@/app/tenant/[subdomain]/pages/loading";
import PageDetailLoading from "@/app/tenant/[subdomain]/pages/[pageId]/loading";
import MediaLoading from "@/app/tenant/[subdomain]/media/loading";
import SettingsLoading from "@/app/tenant/[subdomain]/settings/loading";
import { tenantHomeHrefFromPathname } from "@/app/_boundaries/route-boundary";
import {
  reportError,
  setReportErrorTransport,
  resetReportErrorTransport,
} from "@/lib/report-error";
import { metadata as loginMetadata } from "@/app/login/layout";
import { metadata as accountsMetadata } from "@/app/tenant/[subdomain]/accounts/layout";
import { metadata as mediaMetadata } from "@/app/tenant/[subdomain]/media/layout";
import { generateMetadata as connectGenerateMetadata } from "@/app/tenant/[subdomain]/connect/[platform]/page";

function skeletonCount(container: HTMLElement): number {
  return container.querySelectorAll('[data-slot="skeleton"]').length;
}

describe("error boundaries", () => {
  const reported: Array<{ error: unknown; source: string | undefined }> = [];

  beforeEach(() => {
    reported.length = 0;
    setReportErrorTransport((error, context) => {
      reported.push({ error, source: context?.source });
    });
  });

  afterEach(() => {
    resetReportErrorTransport();
  });

  it("root error renders the designed state, reports via reportError, and Retry invokes reset", () => {
    const reset = vi.fn();
    const failure = new Error("boom-secret-detail");
    render(<RootError error={failure} reset={reset} />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    // Plain-language copy only — the raw error never reaches the user.
    expect(document.body.textContent).not.toContain("boom-secret-detail");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.error).toBe(failure);
    expect(reported[0]?.source).toBe("error-boundary");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);

    const escape = screen.getByRole("link", { name: "Go to home" });
    expect(escape.getAttribute("href")).toBe("/");
  });

  it("tenant error escapes to the tenant dashboard derived from the pathname", () => {
    const reset = vi.fn();
    render(<TenantError error={new Error("x")} reset={reset} />);
    const escape = screen.getByRole("link", { name: "Go to dashboard" });
    expect(escape.getAttribute("href")).toBe("/tenant/acme");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("global-error renders standalone with its own html/body and a Retry that invokes reset", () => {
    const reset = vi.fn();
    const html = renderToStaticMarkup(<GlobalError error={new Error("x")} reset={reset} />);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<body>");
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Try again");
    // Self-contained fallback styling carries the Binance gold token value.
    expect(html).toContain("#fcd535");
    expect(typeof reset).toBe("function");
  });

  it("reportError seam is the same one boundaries report through", () => {
    reportError(new Error("direct"), { source: "error-boundary" });
    expect(reported).toHaveLength(1);
  });
});

describe("not-found boundaries", () => {
  it("root not-found renders the typed EmptyState with one primary action", () => {
    render(<RootNotFound />);
    const state = screen.getByRole("status");
    expect(state.getAttribute("data-slot")).toBe("empty-state");
    // The dedicated `not-found` cause (spec 130 §5.7 / spec 137 §11(a)).
    expect(state.getAttribute("data-type")).toBe("not-found");
    expect(screen.getByText("This page is not here")).toBeTruthy();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/");
  });

  it("tenant not-found escapes to the tenant dashboard", () => {
    render(<TenantNotFound />);
    const link = screen.getByRole("link", { name: "Go to dashboard" });
    expect(link.getAttribute("href")).toBe("/tenant/acme");
  });

  it("tenantHomeHrefFromPathname handles tenant, clean and empty paths", () => {
    expect(tenantHomeHrefFromPathname("/tenant/acme/pages")).toBe("/tenant/acme");
    expect(tenantHomeHrefFromPathname("/accounts")).toBe("/");
    expect(tenantHomeHrefFromPathname(null)).toBe("/");
  });
});

describe("loading boundaries", () => {
  const cases: Array<[string, React.ComponentType]> = [
    ["root", RootLoading],
    ["tenant/home", TenantLoading],
    ["accounts", AccountsLoading],
    ["pages list", PagesLoading],
    ["page detail", PageDetailLoading],
    ["media", MediaLoading],
    ["settings", SettingsLoading],
  ];

  it.each(cases)("%s loading renders an aria-busy skeleton composition", (_name, Component) => {
    const { container } = render(<Component />);
    const region = container.querySelector('[aria-busy="true"]');
    expect(region).not.toBeNull();
    expect(skeletonCount(container)).toBeGreaterThan(2);
  });

  it("media loading uses a tile grid at the library's final geometry", () => {
    const { container } = render(<MediaLoading />);
    expect(skeletonCount(container)).toBeGreaterThanOrEqual(12);
    expect(container.querySelector(".aspect-video")).not.toBeNull();
  });
});

describe("metadata standard (spec §3.3.4)", () => {
  it("entry and tenant segments export plain section titles", () => {
    expect(loginMetadata.title).toBe("Sign in");
    expect(accountsMetadata.title).toBe("Accounts");
    expect(mediaMetadata.title).toBe("Media Library");
  });

  it("connect route generates a per-platform title", async () => {
    const meta = await connectGenerateMetadata({
      params: Promise.resolve({ subdomain: "acme", platform: "instagram" }),
      searchParams: Promise.resolve({}),
    });
    expect(meta.title).toBe("Connect Instagram");
    const fallback = await connectGenerateMetadata({
      params: Promise.resolve({ subdomain: "acme", platform: "myspace" }),
      searchParams: Promise.resolve({}),
    });
    expect(fallback.title).toBe("Connect account");
  });
});
