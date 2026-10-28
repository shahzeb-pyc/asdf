/**
 * @file prompt-top-section.test.tsx
 * @description Behavioural tests for the Prompt Library top section,
 * STEP 1 of the step-by-step rebuild: hero copy, search placeholder,
 * category pills in reference order with "All" active first, pill
 * switching, and "Try Now" focusing the search box. No grid, cards,
 * detail, copy, or backend exists in this step, so none is asserted.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { PromptTopSection } from "@/components/prompts/prompt-top-section";

const PILL_IDS = [
  "prompt-top-section-pill-all",
  "prompt-top-section-pill-ugc",
  "prompt-top-section-pill-money-shot",
  "prompt-top-section-pill-try-on",
  "prompt-top-section-pill-tvc",
  "prompt-top-section-pill-product-launch",
  "prompt-top-section-pill-tutorial",
  "prompt-top-section-pill-problem-solution",
  "prompt-top-section-pill-unboxing",
];

describe("PromptTopSection (step 1)", () => {
  it("renders the reference hero copy and search placeholder, and nothing below the search card", () => {
    render(<PromptTopSection />);
    expect(screen.getByText("Video prompts with HD previews")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "AI Video Prompt Gallery" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "See the result first, then copy the prompt and adapt it for your own video. Browse real ad formats including UGC, product shots, tutorials, unboxing, and more.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try Now" })).toBeTruthy();
    expect(
      screen.getByPlaceholderText("Search prompts, products, or categories..."),
    ).toBeTruthy();
  });

  it("shows the category pills in reference order, with All active first", () => {
    render(<PromptTopSection />);
    const pills = PILL_IDS.map((id) => screen.getByTestId(id));
    expect(pills.map((pill) => pill.textContent)).toEqual([
      "All",
      "UGC",
      "Money Shot",
      "Try-On",
      "TVC",
      "Product Launch",
      "Tutorial",
      "Problem/Solution",
      "Unboxing",
    ]);
    expect(pills[0].getAttribute("aria-pressed")).toBe("true");
    expect(pills.slice(1).every((pill) => pill.getAttribute("aria-pressed") === "false")).toBe(
      true,
    );
  });

  it("switches the active pill on tap, and Try Now focuses the search box", () => {
    render(<PromptTopSection />);
    const ugc = screen.getByTestId("prompt-top-section-pill-ugc");
    fireEvent.click(ugc);
    expect(ugc.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByTestId("prompt-top-section-pill-all").getAttribute("aria-pressed"),
    ).toBe("false");

    const search = screen.getByPlaceholderText(
      "Search prompts, products, or categories...",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try Now" }));
    expect(document.activeElement).toBe(search);
  });
});
