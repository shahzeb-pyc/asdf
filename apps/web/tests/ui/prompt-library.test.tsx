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
  previewMediaType: "video",
  previewStorageKey: "prompts/abc/preview.mp4",
  previewPosterKey: "prompts/abc/poster.jpg",
  previewUrl: "https://media.example.com/prompts/abc/preview.mp4",
  previewPosterUrl: "https://media.example.com/prompts/abc/poster.jpg",
  durationSeconds: 30,
  copiedCount: 12,
  status: "published",
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
  isFavourite: false,
};

const detail = {
  ...listItem,
  masterPrompt: "A golden puppy sits in a tiny bathtub.",
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
