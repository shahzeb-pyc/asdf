/**
 * @file prompt-mock-cards.test.tsx
 * @description Behavioural tests for the Prompt Library mock cards
 * grid below the top section: decided B design (uniform size,
 * fixed preview height, cleaner final-card layout), MOCK data only.
 * Cards carry title, short description, tool · category · language
 * · length · format, and copied count · date added — and NOTHING
 * else: no master prompt text, no how-to steps, no Show prompt
 * toggle, no Copy button, and NO dedicated detail section. Cards
 * are non-interactive: clicking one must do nothing, so there must
 * be no button, link, or dialog in the grid at all.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { PromptMockCardGrid } from "@/components/prompts/prompt-mock-card-grid";
import { MOCK_PROMPT_CARDS } from "@/components/prompts/prompt-mock-data";

describe("PromptMockCardGrid (mock data, B design, no detail section)", () => {
  it("renders the 4 mock cards with all fields, including a 1 min+ entry", () => {
    render(<PromptMockCardGrid />);
    expect(MOCK_PROMPT_CARDS.length).toBe(4);
    const cards = screen.getAllByTestId("prompt-mock-card");
    expect(cards.length).toBe(4);
    expect(screen.getAllByTestId("prompt-mock-card-preview").length).toBe(4);
    for (const entry of MOCK_PROMPT_CARDS) {
      expect(screen.getByRole("heading", { name: entry.title })).toBeTruthy();
      expect(screen.getByText(entry.shortDescription)).toBeTruthy();
      // The meta line is split across a bold tool span and a text
      // node, so assert on the card's full text instead of one
      // getByText match for the whole line.
      const card = cards.find((candidate) =>
        candidate.textContent?.includes(entry.title),
      );
      expect(card).toBeTruthy();
      expect(card?.textContent).toContain(
        `${entry.tool} · ${entry.category} · ${entry.language} · ${entry.length} · ${entry.format}`,
      );
      expect(card?.textContent).toContain(
        `Copied ${entry.copiedCount} times · Added ${entry.dateAdded}`,
      );
    }
    // At least one mock card uses the new 1 min+ length bucket.
    expect(MOCK_PROMPT_CARDS.some((entry) => entry.length === "1 min+")).toBe(true);
    // Mock data covers every language the Language filter offers.
    expect(MOCK_PROMPT_CARDS.some((entry) => entry.language === "English")).toBe(true);
    expect(MOCK_PROMPT_CARDS.some((entry) => entry.language === "Urdu")).toBe(true);
    expect(MOCK_PROMPT_CARDS.some((entry) => entry.language === "Hindi")).toBe(true);
  });

  it("uses a 4-column grid on desktop, 2 on tablet, 1 on phone", () => {
    const { container } = render(<PromptMockCardGrid />);
    const grid = container.querySelector(
      "[data-testid='prompt-mock-card-grid'] > div",
    );
    expect(grid).toBeTruthy();
    // All 4 mock cards sit in one row at desktop width.
    expect(grid?.className).toContain("lg:grid-cols-4");
    expect(grid?.className).toContain("sm:grid-cols-2");
    expect(grid?.className).toContain("grid-cols-1");
  });

  it("shows no prompt text, no how-to, no Copy, and no detail section — and cards are not clickable", () => {
    const { container } = render(<PromptMockCardGrid />);
    // No element in the grid is a button or a link, so there is
    // nothing clickable to open a detail section with.
    expect(screen.queryAllByRole("button").length).toBe(0);
    expect(screen.queryAllByRole("link").length).toBe(0);
    // No modal/dialog/detail view of any kind in the DOM.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector("[data-testid='prompt-detail']")).toBeNull();
    // No prompt or how-to content: the mock data has no prompt
    // field at all, and no card renders one.
    expect(screen.queryByText(/master prompt/i)).toBeNull();
    expect(screen.queryByText(/how to make/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy prompt/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Show prompt/ })).toBeNull();
    // Clicking a card does nothing: no button/link/dialog appears.
    const firstCard = screen.getAllByTestId("prompt-mock-card")[0];
    fireEvent.click(firstCard);
    expect(screen.queryAllByRole("button").length).toBe(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Cards are plain articles, not buttons or links.
    for (const card of screen.getAllByTestId("prompt-mock-card")) {
      expect(card.tagName).toBe("ARTICLE");
      expect(within(card).queryAllByRole("button").length).toBe(0);
    }
  });
});
