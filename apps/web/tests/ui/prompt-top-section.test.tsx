/**
 * @file prompt-top-section.test.tsx
 * @description Behavioural tests for the Prompt Library top section,
 * STEP 1 of the step-by-step rebuild, corrected: structure only, app's
 * own copy and categories. Hero copy, search placeholder, category
 * pills in library order with "All" active first, pill switching, and
 * "Browse prompts" focusing the search box. No grid, cards, detail,
 * copy, or backend exists in this step, so none is asserted.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { PromptTopSection } from "@/components/prompts/prompt-top-section";

const PILL_IDS = [
  "prompt-top-section-pill-all",
  "prompt-top-section-pill-animals",
  "prompt-top-section-pill-comedy",
  "prompt-top-section-pill-cinematic",
];

describe("PromptTopSection (step 1, corrected)", () => {
  it("renders the app's own hero copy and search placeholder, and nothing below the search card", () => {
    render(<PromptTopSection />);
    expect(screen.getByText("Prompt Library")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Prompt Library" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Find a prompt, view the full text, and copy it into your video tool.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Browse prompts" })).toBeTruthy();
    expect(
      screen.getByPlaceholderText("Search by title or words in the prompt"),
    ).toBeTruthy();
    // Replica copy must be gone.
    expect(screen.queryByText("AI Video Prompt Gallery")).toBeNull();
    expect(screen.queryByText("Try Now")).toBeNull();
    expect(screen.queryByText("Video prompts with HD previews")).toBeNull();
  });

  it("shows the library category pills in order, with All active first", () => {
    render(<PromptTopSection />);
    const pills = PILL_IDS.map((id) => screen.getByTestId(id));
    expect(pills.map((pill) => pill.textContent)).toEqual([
      "All",
      "Animals",
      "Comedy",
      "Cinematic",
    ]);
    expect(pills[0].getAttribute("aria-pressed")).toBe("true");
    expect(pills.slice(1).every((pill) => pill.getAttribute("aria-pressed") === "false")).toBe(
      true,
    );
  });

  it("switches the active pill on tap, and Browse prompts focuses the search box", () => {
    render(<PromptTopSection />);
    const comedy = screen.getByTestId("prompt-top-section-pill-comedy");
    fireEvent.click(comedy);
    expect(comedy.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByTestId("prompt-top-section-pill-all").getAttribute("aria-pressed"),
    ).toBe("false");

    const search = screen.getByPlaceholderText(
      "Search by title or words in the prompt",
    );
    fireEvent.click(screen.getByRole("button", { name: "Browse prompts" }));
    expect(document.activeElement).toBe(search);
  });
});
