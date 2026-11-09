/** @vitest-environment jsdom */
import * as React from "react";
import { describe, it, expect, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ensureDomShims } from "./test-utils";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarTrigger,
  SidebarInset,
} from "./sidebar";

beforeAll(ensureDomShims);

function Shell({ collapsible = "icon" as const }) {
  return (
    <SidebarProvider>
      <Sidebar collapsible={collapsible}>
        <SidebarHeader>Workspace</SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Main</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive>
                  <a href="/dashboard">Dashboard</a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a href="/queue">Queue</a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <SidebarTrigger />
        <p>Page body</p>
      </SidebarInset>
    </SidebarProvider>
  );
}

describe("Sidebar (upstream shadcn rebuild)", () => {
  it("renders menu links as single anchors — one click navigates (spec 110)", () => {
    render(<Shell />);
    const queue = screen.getByRole("link", { name: "Queue" });
    expect(queue.tagName).toBe("A");
    expect(queue.getAttribute("href")).toBe("/queue");
    expect(queue.getAttribute("data-sidebar")).toBe("menu-button");
    const dash = screen.getByRole("link", { name: "Dashboard" });
    expect(dash.getAttribute("aria-current")).toBe("page");
    expect(dash.getAttribute("data-active")).toBe("true");
  });

  it("starts expanded and the trigger collapses to icon mode", () => {
    const { container } = render(<Shell />);
    const root = container.querySelector('[data-slot="sidebar"]');
    expect(root?.getAttribute("data-state")).toBe("expanded");
    fireEvent.click(screen.getByRole("button", { name: /Toggle Sidebar/ }));
    expect(root?.getAttribute("data-state")).toBe("collapsed");
    expect(root?.getAttribute("data-collapsible")).toBe("icon");
    // Links stay single-click anchors while icon-collapsed.
    expect(screen.getByRole("link", { name: "Queue" }).getAttribute("href")).toBe("/queue");
  });

  it("supports the non-collapsible variant", () => {
    const { container } = render(
      <SidebarProvider>
        <Sidebar collapsible="none">
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <a href="/x">X</a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>
    );
    expect(container.querySelector('[data-slot="sidebar"]')?.className).toContain("w-64");
  });

  it("menu button without asChild is a button with the active state", () => {
    render(
      <SidebarProvider>
        <SidebarContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton isActive>Plain</SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
      </SidebarProvider>
    );
    const btn = screen.getByRole("button", { name: "Plain" });
    expect(btn.getAttribute("data-active")).toBe("true");
  });
});

describe("Sidebar mobile first paint (spec 152 O8)", () => {
  /**
   * The phone branch must be the FIRST render, not a post-hydration
   * effect flip: on a 390px viewport the desktop sidebar tree must
   * never mount. Testing Library's render flushes effects, which
   * would hide the difference — so this renders synchronously with
   * createRoot + flushSync and asserts before any effect could run.
   * The old effect-based hook rendered the desktop branch here.
   */
  it("renders the mobile branch on first render at 390px, no desktop tree", () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({
        matches: query === "(max-width: 767px)",
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList;
    try {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      flushSync(() => {
        root.render(
          <SidebarProvider>
            <Sidebar collapsible="icon">
              <SidebarHeader>Workspace</SidebarHeader>
              <SidebarContent>
                <p>Nav</p>
              </SidebarContent>
            </Sidebar>
          </SidebarProvider>
        );
      });
      // Mobile branch (closed sheet) mounts no sidebar element at
      // all; the desktop branch would mount the rail div.
      expect(container.querySelector('[data-slot="sidebar"]')).toBeNull();
      flushSync(() => {
        root.unmount();
      });
      container.remove();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
