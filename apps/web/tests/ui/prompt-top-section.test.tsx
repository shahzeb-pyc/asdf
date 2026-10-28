/**
 * @file prompt-top-section.test.tsx
 * @description Behavioural tests for the Prompt Library top section,
 * STEP 1 of the step-by-step rebuild, corrected: structure only, app's
 * own copy. Hero copy plus a smaller search input with plain-text
 * expandable filter triggers after it. Filters are UI state only in
 * this step: there is no grid, catalogue, or content below to filter,
 * so selecting a filter changes its trigger label and active state
 * only. The eyebrow pill, the "Browse prompts" button, and the
 * category pill row were removed entirely at Shahzeb's direction, so
 * their absence is asserted. No grid, cards, detail, copy, or backend
 * exists in this step, so none is asserted.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { PromptTopSection } from "@/components/prompts/prompt-top-section";

describe("PromptTopSection (step 1, filter row)", () => {
  it("renders the new heading, subtitle, smaller search, and all four filter triggers", () => {
    render(<PromptTopSection />);
    expect(screen.getByRole("heading", { name: "Master Prompts Library" })).toBeTruthy();
    expect(
      screen.getByText(
        "Find a prompt, view the full text, and copy it into your video tool.",
      ),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText("Search prompts…")).toBeTruthy();
    expect(screen.getByTestId("prompt-top-section-filter-row")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Category: All/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Tool: All/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Length: All/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sort: Newest/ })).toBeTruthy();
    // Replica copy and the removed elements must be gone.
    expect(screen.queryByText("AI Video Prompt Gallery")).toBeNull();
    expect(screen.queryByText("Try Now")).toBeNull();
    expect(screen.queryByText("Video prompts with HD previews")).toBeNull();
    expect(screen.queryByText("AI video prompts")).toBeNull();
    expect(screen.queryByRole("button", { name: "Browse prompts" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Prompt categories" })).toBeNull();
    expect(screen.queryByTestId("prompt-top-section-pill-all")).toBeNull();
  });

  it("expands a filter to show its options, and selecting one updates the label and closes it", () => {
    render(<PromptTopSection />);
    expect(
      screen.queryByTestId("prompt-top-section-filter-category-options"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Category: All/ }));
    expect(
      screen.getByTestId("prompt-top-section-filter-category-options"),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "UGC" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "UGC" }));
    expect(
      screen.queryByTestId("prompt-top-section-filter-category-options"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /Category: UGC/ })).toBeTruthy();
  });

  it("keeps only one dropdown open at a time", () => {
    render(<PromptTopSection />);
    fireEvent.click(screen.getByRole("button", { name: /Category: All/ }));
    fireEvent.click(screen.getByRole("button", { name: /Tool: All/ }));
    expect(
      screen.queryByTestId("prompt-top-section-filter-category-options"),
    ).toBeNull();
    expect(
      screen.getByTestId("prompt-top-section-filter-tool-options"),
    ).toBeTruthy();
  });

  it("shows Clear all only when something is chosen, and Clear all resets everything", () => {
    render(<PromptTopSection />);
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Tool: All/ }));
    fireEvent.click(screen.getByRole("option", { name: "Veo 3" }));
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search prompts…"), {
      target: { value: "puppy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByRole("button", { name: /Tool: All/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Category: All/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sort: Newest/ })).toBeTruthy();
    expect(
      (screen.getByPlaceholderText("Search prompts…") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
  });
});
