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
import type { PromptFacets } from "@fbuploadpro/contracts";

/** Facets fixture: every allowed value present, in server order
 * (count descending, then value alphabetically). Tests that need
 * options beyond "All" pass this explicitly — the component has
 * no hardcoded option lists to fall back on. */
const TEST_FACETS: PromptFacets = {
  category: [
    { value: "animals", count: 2 },
    { value: "cinematic", count: 1 },
    { value: "comedy", count: 1 },
    { value: "tutorial", count: 1 },
    { value: "ugc", count: 1 },
    { value: "unboxing", count: 1 },
  ],
  tool: [
    { value: "dola_ai", count: 2 },
    { value: "google_flow", count: 1 },
    { value: "veo3", count: 1 },
  ],
  language: [
    { value: "en", count: 2 },
    { value: "hi", count: 1 },
    { value: "ur", count: 1 },
  ],
  length: [
    { value: "under_15s", count: 2 },
    { value: "15_30s", count: 1 },
    { value: "1min_plus", count: 1 },
    { value: "30s_plus", count: 1 },
  ],
};

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
    render(<PromptTopSection facets={TEST_FACETS} />);
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

  it("does not clip filter dropdowns: the section has no overflow-hidden and all Category options render", () => {
    render(<PromptTopSection facets={TEST_FACETS} />);
    // Regression: the hero section used to carry overflow-hidden,
    // which clipped the absolutely-positioned dropdowns at the
    // section edge so only ~2 options showed. jsdom cannot measure
    // clipping, so the test asserts the cause is gone and the full
    // longest list (Category, 7 options) is in the DOM when open.
    const section = screen.getByTestId("prompt-top-section");
    expect(section.className).not.toContain("overflow-hidden");
    fireEvent.click(screen.getByRole("button", { name: /Category: All/ }));
    for (const option of [
      "All",
      "Animals",
      "Comedy",
      "Cinematic",
      "UGC",
      "Tutorial",
      "Unboxing",
    ]) {
      expect(screen.getByRole("option", { name: option })).toBeTruthy();
    }
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
    render(<PromptTopSection facets={TEST_FACETS} />);
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

  it("keeps the hero full-width but centres an expanding search card (fit-content, no fixed max-w cap)", () => {
    render(<PromptTopSection />);
    const section = screen.getByTestId("prompt-top-section");
    const hero = section.firstElementChild as HTMLElement;
    expect(hero.className).not.toContain("max-w-3xl");
    expect(hero.className).toContain("w-full");
    const card = screen.getByTestId("prompt-top-section-search-card");
    // Full-width below sm, fit-content on sm+ so the card grows
    // with its filters instead of wrapping them, capped only by
    // the page width (max-w-full). No fixed max-w-3xl/max-w-4xl
    // cap remains for the filters to outgrow.
    expect(card.className).toContain("w-full");
    expect(card.className).toContain("mx-auto");
    expect(card.className).toContain("sm:w-fit");
    expect(card.className).toContain("sm:max-w-full");
    expect(card.className).not.toContain("max-w-3xl");
    expect(card.className).not.toContain("max-w-4xl");
  });

  it("lays out variant A: search on its own row, then a divider, then all six filter controls in order Sort, My favorites, Clear all last", () => {
    render(<PromptTopSection />);
    const card = screen.getByTestId("prompt-top-section-search-card");
    expect(card.className).toContain("sm:w-fit");
    expect(card.className).not.toContain("max-w-4xl");
    // Card children, in order: search row, divider, filter row.
    expect(card.children.length).toBe(3);
    const searchRow = screen.getByTestId("prompt-top-section-search-row");
    expect(card.children[0]).toBe(searchRow);
    expect(searchRow.contains(screen.getByPlaceholderText("Search prompts…"))).toBe(true);
    expect(searchRow.querySelector("button")).toBeNull();
    const divider = card.children[1] as HTMLElement;
    expect(divider.className).toContain("border-t");
    const filterRow = screen.getByTestId("prompt-top-section-filter-row");
    expect(card.children[2]).toBe(filterRow);
    // All six controls live in the filter row, not the search row.
    for (const name of [
      /Category: All/,
      /Tool: All/,
      /Language: All/,
      /Length: All/,
      /Sort: Newest/,
    ]) {
      expect(filterRow.contains(screen.getByRole("button", { name }))).toBe(true);
    }
    expect(
      filterRow.contains(screen.getByTestId("prompt-top-section-filter-favorites")),
    ).toBe(true);
    // Sort is NOT pushed right: its wrapper carries no ml-auto, and
    // it sits after Length, with My favorites after it.
    const sortButton = screen.getByRole("button", { name: /Sort: Newest/ });
    expect((sortButton.parentElement as HTMLElement).className).not.toContain("ml-auto");
    // Expanding, never wrapping: the filter row is no-wrap and
    // every control is nowrap + shrink-0, so Clear all can no
    // longer drop onto a new line when filters get long. Below sm
    // the row scrolls horizontally (last resort); on sm+ it is
    // overflow-visible so dropdowns open freely below the card.
    expect(filterRow.className).toContain("flex-nowrap");
    expect(filterRow.className).not.toContain("flex-wrap");
    expect(filterRow.className).toContain("overflow-x-auto");
    expect(filterRow.className).toContain("sm:overflow-visible");
    for (const button of Array.from(filterRow.querySelectorAll("button"))) {
      expect(button.className).toContain("whitespace-nowrap");
    }
    expect((sortButton.parentElement as HTMLElement).className).toContain("shrink-0");
    // Order inside the filter row: Category, Tool, Language, Length,
    // Sort, My favorites.
    const buttons = Array.from(filterRow.querySelectorAll("button")).map(
      (button) => button.textContent ?? "",
    );
    let lastIndex = -1;
    for (const label of [
      "Category",
      "Tool",
      "Language",
      "Length",
      "Sort",
      "My favorites",
    ]) {
      const index = buttons.findIndex(
        (text, i) => i > lastIndex && text.includes(label),
      );
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it("keeps Clear all on the same filter row, last, in the reported case: Sort Most copied + My favorites active", () => {
    render(<PromptTopSection />);
    // Reproduce the reported case exactly: the longest Sort value,
    // favorites on, other filters at "All" — the case where Clear all
    // used to drop alone onto a new line.
    fireEvent.click(screen.getByRole("button", { name: /Sort: Newest/ }));
    fireEvent.click(screen.getByRole("option", { name: "Most copied" }));
    expect(screen.getByRole("button", { name: /Sort: Most copied/ })).toBeTruthy();
    fireEvent.click(screen.getByTestId("prompt-top-section-filter-favorites"));
    const filterRow = screen.getByTestId("prompt-top-section-filter-row");
    const clearAll = screen.getByRole("button", { name: "Clear all" });
    // Clear all is inside the filter row (not a separate row) and is
    // the last control in it, after Sort and My favorites.
    expect(filterRow.contains(clearAll)).toBe(true);
    const buttons = Array.from(filterRow.querySelectorAll("button"));
    expect(buttons[buttons.length - 1]).toBe(clearAll);
    const texts = buttons.map((button) => button.textContent ?? "");
    const sortIndex = texts.findIndex((text) => text.includes("Sort: Most copied"));
    const favoritesIndex = texts.findIndex((text) => text.includes("My favorites"));
    const clearIndex = texts.findIndex((text) => text.includes("Clear all"));
    expect(sortIndex).toBeGreaterThan(-1);
    expect(favoritesIndex).toBeGreaterThan(sortIndex);
    expect(clearIndex).toBeGreaterThan(favoritesIndex);
    // Clear all itself is also nowrap + shrink-0, so it cannot
    // wrap onto a new line on its own.
    expect(clearAll.className).toContain("whitespace-nowrap");
    expect(clearAll.className).toContain("shrink-0");
    // NOTE (honest jsdom limit): jsdom cannot measure pixel widths,
    // so this test asserts order, same-row membership, and the
    // no-wrap/expanding classes in code terms, not that the row
    // fits on one line in a browser. The expanding behaviour (card
    // w-fit capped only by max-w-full, filter row no-wrap) is in
    // prompt-top-section.tsx and must be confirmed by the live
    // preview eyeball with all filters selected, as in Shahzeb's
    // screenshot.
  });

  it("keeps Clear all on the same row when ALL filters carry long values", () => {
    render(<PromptTopSection facets={TEST_FACETS} />);
    // Reproduce Shahzeb's latest screenshot exactly: every filter
    // selected with a long value, favorites on — the case that
    // broke max-w-4xl and dropped Clear all onto a new line.
    const select = (trigger: RegExp, option: string) => {
      fireEvent.click(screen.getByRole("button", { name: trigger }));
      fireEvent.click(screen.getByRole("option", { name: option }));
    };
    select(/Category: All/, "Comedy");
    select(/Tool: All/, "Google Flow");
    select(/Language: All/, "English");
    select(/Length: All/, "Under 15s");
    select(/Sort: Newest/, "Most copied");
    fireEvent.click(screen.getByTestId("prompt-top-section-filter-favorites"));
    const filterRow = screen.getByTestId("prompt-top-section-filter-row");
    const clearAll = screen.getByRole("button", { name: "Clear all" });
    expect(filterRow.contains(clearAll)).toBe(true);
    const buttons = Array.from(filterRow.querySelectorAll("button"));
    expect(buttons[buttons.length - 1]).toBe(clearAll);
    // The expanding card + no-wrap row are what keep this case on
    // one row: assert both in code terms (jsdom cannot measure).
    const card = screen.getByTestId("prompt-top-section-search-card");
    expect(card.className).toContain("sm:w-fit");
    expect(card.className).toContain("sm:max-w-full");
    expect(filterRow.className).toContain("flex-nowrap");
    expect(filterRow.className).not.toContain("flex-wrap");
  });

  it("renders dynamic facets instead of hardcoded lists, with All first", () => {
    const facets: PromptFacets = {
      category: [
        { value: "comedy", count: 1 },
        { value: "animals", count: 1 },
      ],
      tool: [{ value: "dola_ai", count: 2 }],
      language: [{ value: "en", count: 2 }],
      length: [{ value: "1min_plus", count: 2 }],
    };
    render(<PromptTopSection facets={facets} />);
    fireEvent.click(screen.getByRole("button", { name: /Category: All/ }));
    const options = screen.getByTestId(
      "prompt-top-section-filter-category-options",
    );
    const optionButtons = options.querySelectorAll('[role="option"]');
    // "All" first, then the facet values in facets order, with
    // contracts labels — and nothing else: no unused value leaks in.
    expect(optionButtons).toHaveLength(3);
    expect(optionButtons[0].textContent).toContain("All");
    expect(screen.getByRole("option", { name: "Comedy" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Animals" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Unboxing" })).toBeNull();
    expect(screen.queryByRole("option", { name: "UGC" })).toBeNull();
    // Tool likewise: only the facet value, labelled via contracts.
    fireEvent.click(screen.getByRole("button", { name: /Tool: All/ }));
    expect(screen.getByRole("option", { name: "Dola AI" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Veo 3" })).toBeNull();
    // Sort is NOT dynamic: its modes stay fixed.
    fireEvent.click(screen.getByRole("button", { name: /Sort: Newest/ }));
    expect(screen.getByRole("option", { name: "Newest" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Most copied" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "A to Z" })).toBeTruthy();
  });

  it("without facets, a dynamic filter offers only All — never a hardcoded list", () => {
    render(<PromptTopSection />);
    fireEvent.click(screen.getByRole("button", { name: /Category: All/ }));
    const options = screen.getByTestId(
      "prompt-top-section-filter-category-options",
    );
    expect(options.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(screen.getByRole("option", { name: "All" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "UGC" })).toBeNull();
  });

  it("shows Clear all only when something is chosen, and Clear all resets everything", () => {
    render(<PromptTopSection facets={TEST_FACETS} />);
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
