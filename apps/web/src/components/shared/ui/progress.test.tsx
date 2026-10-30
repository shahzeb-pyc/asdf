/** @vitest-environment jsdom */
import * as React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Progress } from "./progress";

describe("Progress (Radix, token track + fill, no inline width)", () => {
  it("announces the value through the progressbar role", () => {
    render(<Progress value={40} aria-label="Download progress" />);
    const bar = screen.getByRole("progressbar", { name: "Download progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
  });

  it("renders an indeterminate bar without a value", () => {
    render(<Progress value={null} aria-label="Unknown progress" />);
    const bar = screen.getByRole("progressbar", { name: "Unknown progress" });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.getAttribute("data-state")).toBe("indeterminate");
  });

  it("uses the token track and fill, and merges the caller's class", () => {
    render(<Progress value={25} aria-label="Quarter" className="flex-1" />);
    const bar = screen.getByRole("progressbar", { name: "Quarter" });
    expect(bar.className).toContain("bg-line");
    expect(bar.className).toContain("flex-1");
    const fill = bar.querySelector('[data-slot="progress-indicator"]');
    expect(fill).not.toBeNull();
    expect(fill?.className).toContain("bg-primary");
  });
});
