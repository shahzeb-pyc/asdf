/**
 * @file prompt-library.test.tsx
 * @description Behavioural tests for the Prompt Library wired to the
 * real API (no mock cards, no mock data): list from the API, search
 * + filter query params, empty state, loud error + retry, click →
 * dedicated section with master prompt + steps, copy prompt (clipboard
 * then copy endpoint, count updated), and favourite toggle that
 * persists via the API and reverts on failure.
 *
 * fetch is mocked at the test boundary; the API routes themselves
 * are not exercised here (no live database in unit tests) — the
 * contracts tests cover validation, and the server layer owns the
 * admin-403 and R2-prefix rules, covered there.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { PromptLibraryClient } from "@/components/prompts/prompt-library-client";

const listItem = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "puppy-first-bath",
  title: "Puppy first bath",
  shortDescription: "A golden puppy's first bath.",
  tool: "dola_ai",
  category: "animals",
  language: "en",
  length: "1min_plus",
  format: "vertical_reel",
  aspectRatio: "9:16",
  // List items carry ONLY the main media: its type + URLs.
  previewMediaType: "video",
  previewUrl: "https://media.example.com/prompts/abc/preview.mp4",
  previewPosterUrl: "https://media.example.com/prompts/abc/poster.jpg",
  copiedCount: 12,
  status: "published",
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
  isFavourite: false,
};

const detail = {
  ...listItem,
  masterPrompt: "A golden puppy sits in a tiny bathtub.",
  media: [
    {
      id: "00000000-0000-4000-8000-000000000003",
      position: 1,
      mediaType: "video",
      storageKey: "prompts/abc/preview.mp4",
      posterKey: "prompts/abc/poster.jpg",
      url: "https://media.example.com/prompts/abc/preview.mp4",
      posterUrl: "https://media.example.com/prompts/abc/poster.jpg",
      durationSeconds: 30,
      isMain: true,
    },
    {
      id: "00000000-0000-4000-8000-000000000004",
      position: 2,
      mediaType: "image",
      storageKey: "prompts/abc/shot-2.jpg",
      posterKey: null,
      url: "https://media.example.com/prompts/abc/shot-2.jpg",
      posterUrl: null,
      durationSeconds: null,
      isMain: false,
    },
  ],
  steps: [
    {
      id: "00000000-0000-4000-8000-000000000002",
      position: 1,
      title: null,
      body: "Open your video tool.",
    },
  ],
};

function mockFetch(
  implementation: (url: string, init?: RequestInit) => unknown,
) {
  const fn = vi.fn(
    async (url: string, init?: RequestInit) =>
      implementation(url, init) as Response,
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response;
}

describe("PromptLibraryClient (real API wiring)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders cards from the API with real counts, and no prompt text on the card", async () => {
    mockFetch((url) => {
      if (url.includes("/prompts?")) {
        return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    render(<PromptLibraryClient subdomain="test" />);
    expect(
      await screen.findByRole("heading", { name: "Puppy first bath" }),
    ).toBeTruthy();
    expect(screen.getByText("Copied 12 times · Added 28 Oct 2026")).toBeTruthy();
    expect(screen.queryByText(/golden puppy sits in a tiny bathtub/)).toBeNull();
  });

  it("shows 'No prompts yet' on an empty catalogue", async () => {
    mockFetch(() =>
      okJson({ items: [], total: 0, page: 1, pageSize: 50 }),
    );
    render(<PromptLibraryClient subdomain="test" />);
    expect(await screen.findByTestId("prompt-library-empty")).toBeTruthy();
    expect(screen.getByText("No prompts yet.")).toBeTruthy();
  });

  it("shows a loud error and retries on API failure", async () => {
    let calls = 0;
    mockFetch(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("down"));
      return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
    });
    render(<PromptLibraryClient subdomain="test" />);
    expect(await screen.findByTestId("prompt-library-error")).toBeTruthy();
    fireEvent.click(screen.getByTestId("prompt-library-retry"));
    expect(
      await screen.findByRole("heading", { name: "Puppy first bath" }),
    ).toBeTruthy();
  });

  it("passes the search term to the list API", async () => {
    const fetchMock = mockFetch(() =>
      okJson({ items: [], total: 0, page: 1, pageSize: 50 }),
    );
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-library-empty");
    fetchMock.mockClear();
    fireEvent.change(screen.getByPlaceholderText("Search prompts…"), {
      target: { value: "puppy" },
    });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("search=puppy"),
        ),
      ).toBe(true);
    });
  });

  it("opens the dedicated section, copies the master prompt, and updates the count", async () => {
    mockFetch((url, init) => {
      if (url.includes("/copy")) {
        return okJson({ slug: "puppy-first-bath", copiedCount: 13 });
      }
      if (url.includes("/prompts/puppy-first-bath")) {
        return okJson(detail);
      }
      if (url.includes("/prompts?")) {
        return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    render(<PromptLibraryClient subdomain="test" />);
    fireEvent.click(await screen.findByTestId("prompt-card"));
    expect(await screen.findByTestId("prompt-detail")).toBeTruthy();
    expect(
      screen.getByText("A golden puppy sits in a tiny bathtub."),
    ).toBeTruthy();
    expect(screen.getByText("Open your video tool.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("prompt-detail-copy"));
    expect(await screen.findByText("Copied ✓")).toBeTruthy();
    expect(screen.getByText("Copied 13 times")).toBeTruthy();
  });

  it("detail gallery shows the main media large and swaps on thumbnail tap", async () => {
    mockFetch((url) => {
      if (url.includes("/prompts/puppy-first-bath")) {
        return okJson(detail);
      }
      if (url.includes("/prompts?")) {
        return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    render(<PromptLibraryClient subdomain="test" />);
    fireEvent.click(await screen.findByTestId("prompt-card"));
    expect(await screen.findByTestId("prompt-detail")).toBeTruthy();
    const gallery = screen.getByTestId("prompt-detail-gallery");
    expect(gallery.querySelectorAll('[data-testid="prompt-detail-gallery-item"]').length).toBe(2);
    const preview = screen.getByTestId("prompt-detail-preview");
    expect(preview.getAttribute("src")).toBe(
      "https://media.example.com/prompts/abc/preview.mp4",
    );
    const thumbnails = screen.getAllByTestId("prompt-detail-gallery-item");
    fireEvent.click(thumbnails[1]);
    expect(screen.getByTestId("prompt-detail-preview").getAttribute("src")).toBe(
      "https://media.example.com/prompts/abc/shot-2.jpg",
    );
  });

  it("favorites toggle passes favorites_only to the API, and toggling off removes it", async () => {
    const fetchMock = mockFetch((url) =>
      okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 }),
    );
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-card");
    const toggle = screen.getByTestId("prompt-top-section-filter-favorites");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("favorites_only=true"),
        ),
      ).toBe(true);
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fetchMock.mockClear();
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    });
    expect(
      fetchMock.mock.calls.every(
        ([url]) => !String(url).includes("favorites_only"),
      ),
    ).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("Clear all clears the favorites toggle too", async () => {
    const fetchMock = mockFetch((url) =>
      okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 }),
    );
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-card");
    fireEvent.click(screen.getByTestId("prompt-top-section-filter-favorites"));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("favorites_only=true"),
        ),
      ).toBe(true);
    });
    fetchMock.mockClear();
    fireEvent.click(screen.getByTestId("prompt-top-section-clear-all"));
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    });
    expect(
      fetchMock.mock.calls.every(
        ([url]) => !String(url).includes("favorites_only"),
      ),
    ).toBe(true);
  });

  it("empty favorites state offers Show all prompts, which restores the full grid", async () => {
    mockFetch((url) => {
      if (String(url).includes("favorites_only=true")) {
        return okJson({ items: [], total: 0, page: 1, pageSize: 50 });
      }
      return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
    });
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-card");
    fireEvent.click(screen.getByTestId("prompt-top-section-filter-favorites"));
    expect(
      await screen.findByTestId("prompt-library-favorites-empty"),
    ).toBeTruthy();
    expect(screen.getByText("No favorites yet.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("prompt-library-show-all"));
    expect(
      await screen.findByRole("heading", { name: "Puppy first bath" }),
    ).toBeTruthy();
  });

  it("signed-out favorites shows a sign-in note, never a fake favorites list", async () => {
    mockFetch((url) => {
      if (String(url).includes("favorites_only=true")) {
        return { ok: false, status: 401, json: async () => ({}) } as Response;
      }
      return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
    });
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-card");
    fireEvent.click(screen.getByTestId("prompt-top-section-filter-favorites"));
    expect(
      await screen.findByTestId("prompt-library-favorites-signin"),
    ).toBeTruthy();
    expect(screen.getByText("Sign in to see your favorites.")).toBeTruthy();
    expect(screen.queryByTestId("prompt-card")).toBeNull();
  });

  it("unfavouriting the last favorite while the filter is on shows the empty favorites state", async () => {
    const favourited = { ...listItem, isFavourite: true };
    mockFetch((url, init) => {
      if (url.includes("/favourite")) {
        return okJson({ slug: "puppy-first-bath", isFavourite: false });
      }
      if (String(url).includes("favorites_only=true")) {
        return okJson({ items: [favourited], total: 1, page: 1, pageSize: 50 });
      }
      return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
    });
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-card");
    fireEvent.click(screen.getByTestId("prompt-top-section-filter-favorites"));
    // Wait for the toggle refetch to land (favourited item, heart
    // pressed) before clicking the heart — otherwise the pending
    // refetch would restore the card after the local removal.
    await waitFor(() => {
      expect(
        screen.getByTestId("prompt-card-favourite").getAttribute("aria-pressed"),
      ).toBe("true");
    });
    fireEvent.click(screen.getByTestId("prompt-card-favourite"));
    expect(
      await screen.findByTestId("prompt-library-favorites-empty"),
    ).toBeTruthy();
  });

  it("favourite toggle persists via the API and reverts on failure", async () => {
    const fetchMock = mockFetch((url, init) => {
      if (url.includes("/favourite")) {
        return Promise.reject(new Error("down"));
      }
      if (url.includes("/prompts?")) {
        return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-card");
    const heart = screen.getByTestId("prompt-card-favourite");
    expect(heart.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(heart);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url, init]) =>
          String(url).includes("/favourite") && init?.method === "POST",
        ),
      ).toBe(true);
    });
    // Reverted after the failed request.
    await waitFor(() => {
      expect(heart.getAttribute("aria-pressed")).toBe("false");
    });
  });
});
