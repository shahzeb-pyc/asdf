/**
 * @file prompt-top-section.test.tsx
 * @description Behavioural tests for the Prompt Library top section,
 * STEP 1 of the step-by-step rebuild, corrected: structure only, app's
 * own copy. Hero copy plus a wide search card containing a smaller
 * search input with plain-text expandable filter triggers after it,
 * inside that same card. Filters are UI state only in
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
  it("renders the new heading, subtitle, smaller search, and all five filter triggers", () => {
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
    expect(screen.getByRole("button", { name: /Language: All/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Length: All/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sort: Newest/ })).toBeTruthy();
    // The search input and all five filter triggers live INSIDE the
    // styled search card, not as a bare row on the page.
    const card = screen.getByTestId("prompt-top-section-search-card");
    expect(card.contains(screen.getByPlaceholderText("Search prompts…"))).toBe(true);
    expect(card.contains(screen.getByRole("button", { name: /Category: All/ }))).toBe(true);
    expect(card.contains(screen.getByRole("button", { name: /Tool: All/ }))).toBe(true);
    expect(card.contains(screen.getByRole("button", { name: /Language: All/ }))).toBe(true);
    expect(card.contains(screen.getByRole("button", { name: /Length: All/ }))).toBe(true);
    expect(card.contains(screen.getByRole("button", { name: /Sort: Newest/ }))).toBe(true);
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

  it("contains exactly three things and nothing hidden below the search card", () => {
    const { container } = render(<PromptTopSection />);
    // One section only, with exactly two children: the hero block and
    // the search card. Nothing — visible or hidden — follows the card.
    const sections = container.querySelectorAll("section");
    expect(sections.length).toBe(1);
    const section = screen.getByTestId("prompt-top-section");
    expect(section.children.length).toBe(2);
    const hero = section.children[0];
    expect(hero.children.length).toBe(2);
    expect(hero.children[0].tagName).toBe("H1");
    expect(hero.children[1].tagName).toBe("P");
    const card = screen.getByTestId("prompt-top-section-search-card");
    expect(section.children[1]).toBe(card);
    // No hidden content waiting below: dropdowns render only when open,
    // Clear all renders only when active, and no other section, footer,
    // strip, or "Coming soon" text exists anywhere in the page content.
    expect(
      screen.queryByTestId("prompt-top-section-filter-category-options"),
    ).toBeNull();
    expect(
      screen.queryByTestId("prompt-top-section-filter-tool-options"),
    ).toBeNull();
    expect(
      screen.queryByTestId("prompt-top-section-filter-language-options"),
    ).toBeNull();
    expect(
      screen.queryByTestId("prompt-top-section-filter-length-options"),
    ).toBeNull();
    expect(
      screen.queryByTestId("prompt-top-section-filter-sort-options"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
    expect(container.querySelector("footer")).toBeNull();
    expect(screen.queryByText("Coming soon")).toBeNull();
    expect(screen.queryAllByRole("heading").length).toBe(1);
  });

  it("closes an open dropdown when clicking outside it, including on the search input", () => {
    render(<PromptTopSection />);
    fireEvent.click(screen.getByRole("button", { name: /Category: All/ }));
    expect(
      screen.getByTestId("prompt-top-section-filter-category-options"),
    ).toBeTruthy();
    // Clicking the heading — outside the open filter's trigger + dropdown.
    fireEvent.mouseDown(screen.getByRole("heading", { name: "Master Prompts Library" }));
    expect(
      screen.queryByTestId("prompt-top-section-filter-category-options"),
    ).toBeNull();
    // Same for the search input, which is also outside the filter.
    fireEvent.click(screen.getByRole("button", { name: /Tool: All/ }));
    expect(
      screen.getByTestId("prompt-top-section-filter-tool-options"),
    ).toBeTruthy();
    fireEvent.mouseDown(screen.getByPlaceholderText("Search prompts…"));
    expect(
      screen.queryByTestId("prompt-top-section-filter-tool-options"),
    ).toBeNull();
  });

  it("closes an open dropdown on Escape, and switching filters still works", () => {
    render(<PromptTopSection />);
    fireEvent.click(screen.getByRole("button", { name: /Category: All/ }));
    expect(
      screen.getByTestId("prompt-top-section-filter-category-options"),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByTestId("prompt-top-section-filter-category-options"),
    ).toBeNull();
    // Switching to another filter still opens it after an outside close.
    fireEvent.click(screen.getByRole("button", { name: /Category: All/ }));
    fireEvent.click(screen.getByRole("button", { name: /Tool: All/ }));
    expect(
      screen.getByTestId("prompt-top-section-filter-tool-options"),
    ).toBeTruthy();
  });

  it("offers a Language filter and a 1 min+ length option", () => {
    render(<PromptTopSection />);
    fireEvent.click(screen.getByRole("button", { name: /Language: All/ }));
    expect(screen.getByRole("option", { name: "English" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Urdu" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Hindi" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Urdu" }));
    expect(screen.getByRole("button", { name: /Language: Urdu/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Length: All/ }));
    expect(screen.getByRole("option", { name: "1 min+" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "1 min+" }));
    expect(screen.getByRole("button", { name: /Length: 1 min\+/ })).toBeTruthy();
  });

  it("keeps the hero full-width but centres a compact search card", () => {
    render(<PromptTopSection />);
    const section = screen.getByTestId("prompt-top-section");
    const hero = section.firstElementChild as HTMLElement;
    expect(hero.className).not.toContain("max-w-3xl");
    expect(hero.className).toContain("w-full");
    const card = screen.getByTestId("prompt-top-section-search-card");
    expect(card.className).toContain("w-full");
    expect(card.className).toContain("mx-auto");
    expect(card.className).toContain("max-w-3xl");
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
    expect(screen.getByRole("button", { name: /Language: All/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sort: Newest/ })).toBeTruthy();
    expect(
      (screen.getByPlaceholderText("Search prompts…") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
  });
});
