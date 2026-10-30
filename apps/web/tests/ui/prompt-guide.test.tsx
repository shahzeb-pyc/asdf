/**
 * @file prompt-guide.test.tsx
 * @description The single "How to use a master prompt" guide,
 * opened as a popup dialog — NOT a page. The guide card opens
 * the dialog (no navigation, no href to /prompts/guide); the
 * dialog renders the guide headings and the reference step,
 * carries no CM Tool Hub branding, and contains no per-prompt
 * how-to content. The separate guide page route was removed.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { PromptGuideDialog } from "@/components/prompts/prompt-guide-dialog";

describe("Prompt guide popup", () => {
  it("opens the guide in a dialog on card click, not as a page", async () => {
    render(<PromptGuideDialog />);
    const trigger = screen.getByTestId("prompt-detail-guide-link");
    expect(trigger.textContent).toContain("How to use a master prompt");
    // A popup trigger, not a navigation link: no href anywhere.
    expect(trigger.getAttribute("href")).toBeNull();
    expect(screen.queryByTestId("prompt-guide-dialog")).toBeNull();
    fireEvent.click(trigger);
    expect(
      await screen.findByTestId("prompt-guide-dialog"),
    ).toBeTruthy();
    expect(await screen.findByTestId("prompt-guide")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "How to use a master prompt" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: /Step 5: Choose a reference image/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/The reference is the prompt's own preview media/),
    ).toBeTruthy();
    expect(screen.getAllByText(/USE YOUR DESIGN/).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText(/CM Tool Hub/)).toBeNull();
  });
});
