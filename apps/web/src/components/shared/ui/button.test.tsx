import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./button";

describe("Button", () => {
  it("renders a real button with the Snap Yellow primary variant by default", () => {
    render(<Button>Publish</Button>);
    const btn = screen.getByRole("button", { name: "Publish" });
    expect(btn).toHaveAttribute("data-variant", "default");
    expect(btn.className).toContain("bg-primary");
    expect(btn.className).toContain("text-on-primary");
    expect(btn.className).toContain("h-control");
  });

  it("compact default density (spec 129 OD-4 as amended, Shahzeb 2026-10-24 — supersedes spec 142 F01): default and icon sizes are the 36px control height; sm/icon-sm stay dense 32px", () => {
    const { rerender } = render(<Button>Publish</Button>);
    expect(screen.getByRole("button", { name: "Publish" }).className).toContain("h-control");
    rerender(
      <Button size="icon" aria-label="More actions">
        …
      </Button>
    );
    expect(screen.getByRole("button", { name: "More actions" }).className).toContain("size-control");
    rerender(
      <Button size="sm">Dense</Button>
    );
    const sm = screen.getByRole("button", { name: "Dense" });
    expect(sm.className).toContain("h-control-sm");
    expect(sm.className).not.toMatch(/(^|\s)h-control(\s|$)/);
    rerender(
      <Button size="icon-sm" aria-label="Dense icon">
        …
      </Button>
    );
    expect(screen.getByRole("button", { name: "Dense icon" }).className).toContain("size-control-sm");
  });

  it("uses token classes only — no arbitrary values", () => {
    render(<Button variant="destructive">Delete</Button>);
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn.className).not.toMatch(/-\[/);
  });

  it("fires onClick and is a non-submit button by default", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).toHaveAttribute("type", "button");
    await user.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keyboard: Tab reaches it, Enter and Space activate it", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await user.tab();
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("loading state: spinner geometry, aria-busy, activation blocked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>
    );
    const btn = screen.getByRole("button", { name: /Saving/ });
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disabled button cannot be activated by click or keyboard", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Schedule
      </Button>
    );
    const btn = screen.getByRole("button", { name: "Schedule" });
    expect(btn).toBeDisabled();
    await user.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disabled-with-a-reason exposes the reason as its description", () => {
    render(<Button disabledReason="Connect a Page first">Schedule</Button>);
    const btn = screen.getByRole("button", { name: "Schedule" });
    expect(btn).toBeDisabled();
    const describedBy = btn.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe("Connect a Page first");
  });

  it("asChild renders the child element with button styling (single-click link)", () => {
    render(
      <Button asChild>
        <a href="/queue">Queue</a>
      </Button>
    );
    const link = screen.getByRole("link", { name: "Queue" });
    expect(link).toHaveAttribute("href", "/queue");
    expect(link.className).toContain("bg-primary");
  });
});
