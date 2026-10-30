/**
 * @file prompt-card-grid.test.tsx
 * @description Behavioural tests for PromptCardGrid directly:
 * hover/tap play behaviour for video previews, video vs image
 * media rendering, favourite heart toggle states, length/format
 * chips, copied count display, date display, and the empty grid
 * state. The grid owns no fetching — props in, callbacks out.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { PromptCardGrid } from "@/components/prompts/prompt-card-grid";
import type { PromptListItem } from "@fbuploadpro/contracts";

function item(overrides: Partial<PromptListItem> = {}): PromptListItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "puppy-first-bath",
    title: "Puppy first bath",
    shortDescription: "A golden puppy's first bath.",
    tool: "dola_ai",
    category: "animals",
    language: "en",
    length: "1min_plus",
    exactDurationSeconds: null,
    format: "vertical_reel",
    aspectRatio: "9:16",
    previewMediaType: "video",
    previewUrl: "https://media.example.com/prompts/abc/preview.mp4",
    previewPosterUrl: "https://media.example.com/prompts/abc/poster.jpg",
    copiedCount: 12,
    status: "published",
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
    isFavourite: false,
    ...overrides,
  };
}

describe("PromptCardGrid", () => {
  let playMock: ReturnType<typeof vi.fn>;
  let pauseMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // jsdom has no real media playback: stub play/pause so hover
    // and tap behaviour is observable without renderer noise.
    playMock = vi.fn().mockResolvedValue(undefined);
    pauseMock = vi.fn();
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockImplementation(
      playMock as never,
    );
    vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(
      pauseMock as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderGrid(
    items: PromptListItem[],
    handlers: {
      onSelect?: (slug: string) => void;
      onToggleFavourite?: (slug: string, current: boolean) => void;
    } = {},
  ) {
    const onSelect = vi.fn(handlers.onSelect);
    const onToggleFavourite = vi.fn(handlers.onToggleFavourite);
    render(
      <PromptCardGrid
        items={items}
        onSelect={onSelect}
        onToggleFavourite={onToggleFavourite}
      />,
    );
    return { onSelect, onToggleFavourite };
  }

  it("renders a video card with a video preview, poster, and play control", () => {
    renderGrid([item()]);
    const video = screen.getByTestId("prompt-card-video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe(
      "https://media.example.com/prompts/abc/preview.mp4",
    );
    expect(video.getAttribute("poster")).toBe(
      "https://media.example.com/prompts/abc/poster.jpg",
    );
    expect(video.muted).toBe(true);
    expect(
      screen.getByRole("button", { name: "Play preview for Puppy first bath" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("prompt-card-image")).toBeNull();
  });

  it("renders an image card with an image preview and no play control", () => {
    renderGrid([
      item({
        previewMediaType: "image",
        previewUrl: "https://media.example.com/prompts/abc/shot.jpg",
        previewPosterUrl: null,
      }),
    ]);
    const image = screen.getByTestId("prompt-card-image");
    expect(image.getAttribute("src")).toContain("shot.jpg");
    expect(screen.queryByTestId("prompt-card-video")).toBeNull();
    expect(screen.queryByTestId("prompt-card-play")).toBeNull();
  });

  it("hovering a video preview plays it, leaving pauses and rewinds it", () => {
    renderGrid([item()]);
    const preview = screen.getByTestId("prompt-card-preview");
    fireEvent.mouseEnter(preview);
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Pause preview for Puppy first bath" }),
    ).toBeTruthy();
    fireEvent.mouseLeave(preview);
    expect(pauseMock).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Play preview for Puppy first bath" }),
    ).toBeTruthy();
  });

  it("hovering an image preview plays nothing", () => {
    renderGrid([
      item({ previewMediaType: "image", previewPosterUrl: null }),
    ]);
    fireEvent.mouseEnter(screen.getByTestId("prompt-card-preview"));
    expect(playMock).not.toHaveBeenCalled();
  });

  it("tapping the play control plays and pauses without opening the detail", () => {
    const { onSelect } = renderGrid([item()]);
    const play = screen.getByTestId("prompt-card-play");
    fireEvent.click(play);
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("prompt-card-play"));
    expect(pauseMock).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("clicking a card opens it, but the heart and play controls do not", () => {
    const { onSelect, onToggleFavourite } = renderGrid([item()]);
    fireEvent.click(screen.getByTestId("prompt-card"));
    expect(onSelect).toHaveBeenCalledWith("puppy-first-bath");
    onSelect.mockClear();
    fireEvent.click(screen.getByTestId("prompt-card-favourite"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onToggleFavourite).toHaveBeenCalledWith("puppy-first-bath", false);
  });

  it("favourite heart shows saved state and reports the current value on toggle", () => {
    const { onToggleFavourite } = renderGrid([
      item({ isFavourite: true }),
    ]);
    const heart = screen.getByTestId("prompt-card-favourite");
    expect(heart.getAttribute("aria-pressed")).toBe("true");
    expect(heart.getAttribute("aria-label")).toBe("Saved Puppy first bath");
    fireEvent.click(heart);
    expect(onToggleFavourite).toHaveBeenCalledWith("puppy-first-bath", true);
  });

  it("unfavourited heart shows the save state", () => {
    renderGrid([item({ isFavourite: false })]);
    const heart = screen.getByTestId("prompt-card-favourite");
    expect(heart.getAttribute("aria-pressed")).toBe("false");
    expect(heart.getAttribute("aria-label")).toBe("Save Puppy first bath");
  });

  it("shows length and format in the chip and the meta line", () => {
    renderGrid([item()]);
    // Bucket label when no exact duration: the chip is an exact
    // "1 min+" span; the meta line is a tool span plus one text
    // node carrying category, language, length and format.
    expect(screen.queryAllByText("1 min+").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Dola AI")).toBeTruthy();
    expect(
      screen.getByText(/Animals · English · 1 min\+ · Vertical reel/),
    ).toBeTruthy();
  });

  it("shows exact durations 0s, 60s and 75s, never the bucket label", () => {
    const cases: [number, string][] = [
      [0, "0s"],
      [60, "1 min"],
      [75, "1 min 15s"],
    ];
    for (const [seconds, label] of cases) {
      const { unmount } = render(
        <PromptCardGrid
          items={[
            item({ exactDurationSeconds: seconds, length: "15_30s" }),
          ]}
          onSelect={vi.fn()}
          onToggleFavourite={vi.fn()}
        />,
      );
      expect(screen.queryAllByText(label).length).toBeGreaterThan(0);
      expect(screen.queryByText("15-30s")).toBeNull();
      unmount();
    }
  });

  it("shows the copied count and the added date in the footer", () => {
    renderGrid([item({ copiedCount: 0 })]);
    expect(screen.getByTestId("prompt-card-copied").textContent).toBe(
      "Copied 0 times",
    );
    expect(screen.getByTestId("prompt-card-date").textContent).toBe(
      "28 Oct 2026",
    );
    const footer = screen.getByTestId("prompt-card-footer");
    expect(footer.children[0]).toBe(screen.getByTestId("prompt-card-copied"));
    expect(footer.children[footer.children.length - 1]).toBe(
      screen.getByTestId("prompt-card-date"),
    );
  });

  it("shows an unparseable date as-is instead of crashing", () => {
    renderGrid([item({ createdAt: "not-a-date" })]);
    expect(screen.getByTestId("prompt-card-date").textContent).toBe(
      "not-a-date",
    );
  });

  it("renders an empty grid section with no cards", () => {
    renderGrid([]);
    expect(screen.getByTestId("prompt-card-grid")).toBeTruthy();
    expect(screen.queryByTestId("prompt-card")).toBeNull();
  });

  it("renders multiple cards keyed by slug", () => {
    renderGrid([
      item(),
      item({
        id: "00000000-0000-4000-8000-000000000002",
        slug: "rainy-neon-street",
        title: "Rainy neon street",
        copiedCount: 3,
      }),
    ]);
    expect(screen.getAllByTestId("prompt-card")).toHaveLength(2);
    expect(
      screen.getByRole("heading", { name: "Rainy neon street" }),
    ).toBeTruthy();
    expect(screen.getByText("Copied 3 times")).toBeTruthy();
  });
});
