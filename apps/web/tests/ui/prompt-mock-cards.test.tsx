/**
 * @file prompt-mock-cards.test.tsx
 * @description Behavioural tests for the Prompt Library mock cards
 * grid below the top section: decided B design (uniform size,
 * fixed preview height, cleaner final-card layout), MOCK data only,
 * with the seven approved card upgrades: real (mock) preview media,
 * hover/tap play, hover lift, play icon + length chip, centred
 * cover framing, click → dedicated section, and a local favourite
 * heart. Cards carry title, short description, tool · category ·
 * language · length · format, and copied count · date added — and
 * NO master prompt text or how-to steps on the card itself.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { PromptMockCardGrid } from "@/components/prompts/prompt-mock-card-grid";
import { MOCK_PROMPT_CARDS } from "@/components/prompts/prompt-mock-data";

describe("PromptMockCardGrid (mock data, B design, dedicated section)", () => {
  it("renders the 4 mock cards with all fields, including a 1 min+ entry", () => {
    render(<PromptMockCardGrid />);
    expect(MOCK_PROMPT_CARDS.length).toBe(4);
    const cards = screen.getAllByTestId("prompt-mock-card");
    expect(cards.length).toBe(4);
    expect(screen.getAllByTestId("prompt-mock-card-preview").length).toBe(4);
    for (const entry of MOCK_PROMPT_CARDS) {
      expect(screen.getByRole("heading", { name: entry.title })).toBeTruthy();
      expect(screen.getByText(entry.shortDescription)).toBeTruthy();
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
    expect(MOCK_PROMPT_CARDS.some((entry) => entry.length === "1 min+")).toBe(true);
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
    expect(grid?.className).toContain("lg:grid-cols-4");
    expect(grid?.className).toContain("sm:grid-cols-2");
    expect(grid?.className).toContain("grid-cols-1");
  });

  it("shows real preview media (video + poster), a play control, a length chip, and a heart — and no prompt or how-to on the card", () => {
    render(<PromptMockCardGrid />);
    const videos = screen.getAllByTestId("prompt-mock-card-video");
    expect(videos.length).toBe(4);
    for (const entry of MOCK_PROMPT_CARDS) {
      const video = videos.find(
        (candidate) =>
          (candidate as HTMLVideoElement).getAttribute("src") ===
          entry.previewVideo,
      );
      expect(video).toBeTruthy();
      expect(
        (video as HTMLVideoElement).getAttribute("poster"),
      ).toBe(entry.previewPoster);
      expect(
        (video as HTMLVideoElement).className,
      ).toContain("object-cover");
    }
    expect(screen.getAllByTestId("prompt-mock-card-play").length).toBe(4);
    expect(screen.getAllByTestId("prompt-mock-card-favourite").length).toBe(4);
    // No master prompt or how-to text is on any card before clicking.
    expect(screen.queryByTestId("prompt-detail")).toBeNull();
    for (const entry of MOCK_PROMPT_CARDS) {
      expect(screen.queryByText(entry.masterPrompt)).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /Copy prompt/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Show prompt/ })).toBeNull();
    // Hover lift: cards carry the lift + gold-border hover classes.
    const firstCard = screen.getAllByTestId("prompt-mock-card")[0];
    expect(firstCard.className).toContain("hover:-translate-y-1");
    expect(firstCard.className).toContain("hover:border-brand-gold");
  });

  it("opens the dedicated section on card click with that card's master prompt + how-to, and Back returns to the grid", () => {
    render(<PromptMockCardGrid />);
    const entry = MOCK_PROMPT_CARDS[0];
    fireEvent.click(screen.getAllByTestId("prompt-mock-card")[0]);
    const detail = screen.getByTestId("prompt-detail");
    expect(detail).toBeTruthy();
    expect(screen.getByText(entry.masterPrompt)).toBeTruthy();
    for (const step of entry.howToSteps) {
      expect(screen.getByText(step)).toBeTruthy();
    }
    // No other card's master prompt is shown.
    expect(screen.queryByText(MOCK_PROMPT_CARDS[1].masterPrompt)).toBeNull();
    fireEvent.click(screen.getByTestId("prompt-detail-back"));
    expect(screen.queryByTestId("prompt-detail")).toBeNull();
    expect(screen.getAllByTestId("prompt-mock-card").length).toBe(4);
  });

  it("hovering the preview toggles play state, and leaving stops it (playback itself is jsdom-unverifiable)", () => {
    render(<PromptMockCardGrid />);
    const firstCard = screen.getAllByTestId("prompt-mock-card")[0];
    const preview = within(firstCard).getByTestId("prompt-mock-card-preview");
    // jsdom does not implement HTMLMediaElement.play(), so this
    // covers the hover handler's state change, not real playback —
    // real hover playback needs a live preview check.
    fireEvent.mouseEnter(preview);
    expect(
      within(firstCard).getByRole("button", {
        name: /Pause preview for Puppy first bath/,
      }),
    ).toBeTruthy();
    fireEvent.mouseLeave(preview);
    expect(
      within(firstCard).getByRole("button", {
        name: /Play preview for Puppy first bath/,
      }),
    ).toBeTruthy();
  });

  it("uses the full content width for the grid, not a narrow centred container", () => {
    const { container } = render(<PromptMockCardGrid />);
    const grid = container.querySelector(
      "[data-testid='prompt-mock-card-grid'] > div",
    );
    expect(grid).toBeTruthy();
    expect(grid?.className).not.toContain("max-w-5xl");
    expect(grid?.className).toContain("w-full");
    expect(grid?.className).toContain("lg:grid-cols-4");
  });

  it("play control and heart clicks do NOT open the dedicated section, and the heart toggles", () => {
    render(<PromptMockCardGrid />);
    const firstCard = screen.getAllByTestId("prompt-mock-card")[0];
    const play = within(firstCard).getByTestId("prompt-mock-card-play");
    fireEvent.click(play);
    expect(screen.queryByTestId("prompt-detail")).toBeNull();
    const heart = within(firstCard).getByTestId("prompt-mock-card-favourite");
    expect(heart.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(heart);
    expect(screen.queryByTestId("prompt-detail")).toBeNull();
    expect(heart.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(heart);
    expect(heart.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByTestId("prompt-detail")).toBeNull();
  });
});
