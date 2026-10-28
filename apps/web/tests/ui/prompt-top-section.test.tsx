/**
 * @file prompt-top-section.test.tsx
 * @description Behavioural tests for the Prompt Library top section,
 * STEP 1 of the step-by-step rebuild, corrected: structure only, app's
 * own copy. Hero copy and search input only. The eyebrow pill, the
 * "Browse prompts" button, and the entire category pill row were
 * removed entirely at Shahzeb's direction, so their absence is
 * asserted. No grid, cards, detail, copy, or backend exists in this
 * step, so none is asserted.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { PromptTopSection } from "@/components/prompts/prompt-top-section";

describe("PromptTopSection (step 1, corrected)", () => {
  it("renders the app's own hero copy and search input, and nothing below the search card", () => {
    render(<PromptTopSection />);
    expect(screen.getByRole("heading", { name: "Prompt Library" })).toBeTruthy();
    expect(
      screen.getByText(
        "Find a prompt, view the full text, and copy it into your video tool.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByPlaceholderText("Search by title or words in the prompt"),
    ).toBeTruthy();
    expect(screen.getByTestId("prompt-top-section-search-card")).toBeTruthy();
    // Replica copy must be gone.
    expect(screen.queryByText("AI Video Prompt Gallery")).toBeNull();
    expect(screen.queryByText("Try Now")).toBeNull();
    expect(screen.queryByText("Video prompts with HD previews")).toBeNull();
  });

  it("has no eyebrow pill, no Browse prompts button, and no category pills", () => {
    render(<PromptTopSection />);
    expect(screen.queryByText("AI video prompts")).toBeNull();
    expect(screen.queryByRole("button", { name: "Browse prompts" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Prompt categories" })).toBeNull();
    expect(screen.queryByTestId("prompt-top-section-pill-all")).toBeNull();
    expect(screen.queryByTestId("prompt-top-section-pill-animals")).toBeNull();
    expect(screen.queryByTestId("prompt-top-section-pill-comedy")).toBeNull();
    expect(screen.queryByTestId("prompt-top-section-pill-cinematic")).toBeNull();
    // No buttons at all remain in the top section.
    expect(screen.queryByRole("button")).toBeNull();
  });
});
