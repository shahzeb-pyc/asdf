/** @vitest-environment jsdom */
import * as React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusMark } from "./status-mark";

describe("StatusMark (icon + text, never a dot)", () => {
  it("maps each kind to its icon and signal colour", () => {
    const { rerender } = render(
      <StatusMark kind="operational" label="Active" testId="mark" />
    );
    let el = screen.getByTestId("mark");
    expect(el.getAttribute("data-status")).toBe("operational");
    expect(el.querySelector('[data-icon="check"]')).not.toBeNull();
    expect(el.className).toContain("text-signal-operational");

    rerender(<StatusMark kind="queued" label="Paused" testId="mark" />);
    el = screen.getByTestId("mark");
    expect(el.querySelector('[data-icon="clock"]')).not.toBeNull();
    expect(el.className).toContain("text-signal-queued");

    rerender(<StatusMark kind="critical" label="Expired" testId="mark" />);
    el = screen.getByTestId("mark");
    expect(el.querySelector('[data-icon="cross"]')).not.toBeNull();
    expect(el.className).toContain("text-signal-critical");

    rerender(<StatusMark kind="idle" label="Idle" testId="mark" />);
    el = screen.getByTestId("mark");
    expect(el.querySelector('[data-icon="circle"]')).not.toBeNull();
    expect(el.className).toContain("text-signal-idle");
  });

  it("renders exactly one icon and the label text, with no dot element", () => {
    render(<StatusMark kind="operational" label="Active" testId="mark" />);
    const el = screen.getByRole("status", { name: "Active" });
    expect(el.querySelectorAll("svg")).toHaveLength(1);
    expect(el.textContent).toContain("Active");
  });

  it("keeps the caller's testid and type tweaks", () => {
    render(
      <StatusMark
        kind="critical"
        label="Expired"
        testId="account-health-mark"
        className="font-medium"
        labelClassName="truncate"
      />
    );
    const el = screen.getByTestId("account-health-mark");
    expect(el.className).toContain("font-medium");
    expect(el.querySelector("span.truncate")).not.toBeNull();
  });
});
