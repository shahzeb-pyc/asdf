/** @vitest-environment jsdom */
import * as React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Alert, AlertTitle, AlertDescription } from "./alert";

describe("Alert", () => {
  it("renders with role=alert, title and description", () => {
    render(
      <Alert>
        <AlertTitle>Heads up</AlertTitle>
        <AlertDescription>Something changed.</AlertDescription>
      </Alert>
    );
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-variant")).toBe("default");
    expect(alert.textContent).toContain("Heads up");
    expect(alert.textContent).toContain("Something changed.");
  });

  it("destructive variant uses the rose token", () => {
    render(
      <Alert variant="destructive">
        <AlertTitle>Failed</AlertTitle>
      </Alert>
    );
    expect(screen.getByRole("alert").className).toContain("border-signal-critical");
  });
});
