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
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

import { PromptLibraryClient } from "@/components/prompts/prompt-library-client";
import { Toast, toast } from "@/components/shared/ui/toast";

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

const facetsBody = {
  category: [
    { value: "animals", count: 1 },
    { value: "comedy", count: 1 },
  ],
  tool: [{ value: "dola_ai", count: 2 }],
  language: [{ value: "en", count: 2 }],
  length: [{ value: "1min_plus", count: 2 }],
};

const secondItem = {
  ...listItem,
  id: "00000000-0000-4000-8000-000000000005",
  slug: "kitten-first-bath",
  title: "Kitten first bath",
  shortDescription: "A kitten's first bath.",
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
    expect(screen.getByTestId("prompt-card-copied").textContent).toBe(
      "Copied 12 times",
    );
    expect(screen.getByTestId("prompt-card-added").textContent).toBe(
      "Added 28 Oct 2026",
    );
    expect(screen.queryByText(/golden puppy sits in a tiny bathtub/)).toBeNull();
  });

  it("splits the card footer: Copied left, Added right, same footer row", async () => {
    mockFetch((url) => {
      if (url.includes("/prompts?")) {
        return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    render(<PromptLibraryClient subdomain="test" />);
    const footer = await screen.findByTestId("prompt-card-footer");
    const copied = screen.getByTestId("prompt-card-copied");
    const added = screen.getByTestId("prompt-card-added");
    // Same row, spread apart: copied is the first child (left),
    // added is the last child (right), both inside the one footer.
    expect(footer.children[0]).toBe(copied);
    expect(footer.children[footer.children.length - 1]).toBe(added);
    expect(footer.className).toContain("justify-between");
    expect(copied.textContent).toBe("Copied 12 times");
    expect(added.textContent).toBe("Added 28 Oct 2026");
    // No combined single-line footer string remains.
    expect(
      screen.queryByText("Copied 12 times · Added 28 Oct 2026"),
    ).toBeNull();
  });

  it("shows 'No prompts yet' on an empty catalogue", async () => {
    mockFetch(() =>
      okJson({ items: [], total: 0, page: 1, pageSize: 50 }),
    );
    render(<PromptLibraryClient subdomain="test" />);
    expect(await screen.findByTestId("prompt-library-empty")).toBeTruthy();
    expect(screen.getByText("No prompts yet.")).toBeTruthy();
  });

  it("centred catalogue-empty state: heading, explanation, no fake add button", async () => {
    mockFetch(() =>
      okJson({ items: [], total: 0, page: 1, pageSize: 50 }),
    );
    render(<PromptLibraryClient subdomain="test" />);
    const state = await screen.findByTestId("prompt-library-empty");
    expect(
      screen.getByRole("heading", { name: "No prompts yet." }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "New prompts are added here by the team through the backend — check back soon.",
      ),
    ).toBeTruthy();
    // No button that pretends to add a prompt: catalogue prompts
    // are added by admin via the backend only.
    expect(screen.queryByRole("button", { name: /add/i })).toBeNull();
    expect(state.className).toContain("items-center");
    expect(state.className).toContain("justify-center");
  });

  it("centred no-match state: heading, explanation, Clear filters button restores the grid", async () => {
    mockFetch((url) => {
      if (String(url).includes("search=")) {
        return okJson({ items: [], total: 0, page: 1, pageSize: 50 });
      }
      return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
    });
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-card");
    fireEvent.change(screen.getByPlaceholderText("Search prompts…"), {
      target: { value: "zzz-no-match" },
    });
    const state = await screen.findByTestId("prompt-library-empty");
    expect(
      screen.getByRole("heading", { name: "No prompts match your search." }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Try different words, or clear the filters to see every prompt.",
      ),
    ).toBeTruthy();
    expect(state.className).toContain("items-center");
    expect(state.className).toContain("justify-center");
    fireEvent.click(screen.getByTestId("prompt-library-clear-filters"));
    expect(
      await screen.findByRole("heading", { name: "Puppy first bath" }),
    ).toBeTruthy();
  });

  it("centred favorites-empty state: heading, explanation, real Show all button", async () => {
    mockFetch((url) => {
      if (String(url).includes("favorites_only=true")) {
        return okJson({ items: [], total: 0, page: 1, pageSize: 50 });
      }
      return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
    });
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-card");
    fireEvent.click(screen.getByTestId("prompt-top-section-filter-favorites"));
    const state = await screen.findByTestId("prompt-library-favorites-empty");
    expect(
      screen.getByRole("heading", { name: "No favorites yet." }),
    ).toBeTruthy();
    expect(
      screen.getByText("Tap the heart on any prompt card to save it here."),
    ).toBeTruthy();
    expect(state.className).toContain("items-center");
    expect(state.className).toContain("justify-center");
    // Show all is a real button, not a plain text link.
    expect(
      screen.getByRole("button", { name: "Show all prompts" }),
    ).toBeTruthy();
  });

  it("centred favorites sign-in state uses the same layout", async () => {
    mockFetch((url) => {
      if (String(url).includes("favorites_only=true")) {
        return { ok: false, status: 401, json: async () => ({}) } as Response;
      }
      return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
    });
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-card");
    fireEvent.click(screen.getByTestId("prompt-top-section-filter-favorites"));
    const state = await screen.findByTestId("prompt-library-favorites-signin");
    expect(
      screen.getByRole("heading", { name: "Sign in to see your favorites." }),
    ).toBeTruthy();
    expect(state.className).toContain("items-center");
    expect(state.className).toContain("justify-center");
    expect(
      screen.getByRole("button", { name: "Show all prompts" }),
    ).toBeTruthy();
  });

  it("loading state shows 4 skeleton cards matching the B grid, no real card content", async () => {
    mockFetch(() => new Promise(() => {}));
    render(<PromptLibraryClient subdomain="test" />);
    const loading = screen.getByTestId("prompt-library-loading");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(screen.getAllByTestId("prompt-card-skeleton")).toHaveLength(4);
    expect(screen.queryByTestId("prompt-card")).toBeNull();
    expect(loading.querySelector(".sm\\:grid-cols-2")).not.toBeNull();
    expect(loading.querySelector(".lg\\:grid-cols-4")).not.toBeNull();
    // Skeletons are muted blocks only: no fake title, count, or prompt text.
    expect(loading.textContent ?? "").not.toContain("Puppy first bath");
    expect(loading.textContent ?? "").not.toContain("Copied");
  });

  it("shows a loud error and retries on API failure", async () => {
    let calls = 0;
    mockFetch((url) => {
      // Facets are a separate call and must not consume the
      // list-failure count: they succeed here, the list fails once.
      if (url.includes("/prompts/facets")) {
        return okJson(facetsBody);
      }
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("down"));
      return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
    });
    render(<PromptLibraryClient subdomain="test" />);
    const errorState = await screen.findByTestId("prompt-library-error");
    expect(errorState).toBeTruthy();
    // Centred error state, same pattern as the empty states: heading,
    // plain-language explanation (no error code), and a real button.
    expect(errorState.className).toContain("items-center");
    expect(errorState.className).toContain("justify-center");
    expect(
      await screen.findByRole("heading", {
        name: "Prompts could not be loaded.",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/Something went wrong while loading/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Retry" }).getAttribute("data-testid"),
    ).toBe("prompt-library-retry");
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

  it("detail loading shows a skeleton matching the detail layout, with no real detail content", async () => {
    mockFetch((url) => {
      if (url.includes("/prompts/puppy-first-bath")) {
        return new Promise(() => {});
      }
      if (url.includes("/prompts?")) {
        return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    render(<PromptLibraryClient subdomain="test" />);
    fireEvent.click(await screen.findByTestId("prompt-card"));
    const loading = await screen.findByTestId("prompt-detail-loading");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByTestId("prompt-detail")).toBeNull();
    expect(screen.queryByText(/golden puppy sits in a tiny bathtub/)).toBeNull();
    expect(screen.queryByText("Open your video tool.")).toBeNull();
    // Same h-60 preview block as the real detail, plus master-prompt
    // and step skeleton lines — muted blocks only, no fake text.
    expect(loading.querySelector(".h-60")).not.toBeNull();
    expect(loading.textContent ?? "").not.toContain("Puppy first bath");
  });

  it("detail error is centred with Retry refetching the same slug and Back returning to the grid", async () => {
    let detailCalls = 0;
    mockFetch((url) => {
      if (url.includes("/prompts/puppy-first-bath")) {
        detailCalls += 1;
        if (detailCalls === 1) {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        return okJson(detail);
      }
      if (url.includes("/prompts?")) {
        return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    render(<PromptLibraryClient subdomain="test" />);
    fireEvent.click(await screen.findByTestId("prompt-card"));
    const errorState = await screen.findByTestId("prompt-detail-error");
    expect(errorState.className).toContain("items-center");
    expect(errorState.className).toContain("justify-center");
    expect(
      screen.getByRole("heading", { name: "This prompt could not be loaded." }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Something went wrong while loading this prompt/),
    ).toBeTruthy();
    // No error code leaks into the user-facing copy.
    expect(errorState.textContent ?? "").not.toContain("500");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to prompts" })).toBeTruthy();
    // Retry refetches the SAME slug and shows the detail on success.
    fireEvent.click(screen.getByTestId("prompt-detail-retry"));
    expect(await screen.findByTestId("prompt-detail")).toBeTruthy();
    expect(detailCalls).toBe(2);
    expect(
      screen.getByText("A golden puppy sits in a tiny bathtub."),
    ).toBeTruthy();
  });

  it("detail error Back returns to the grid", async () => {
    mockFetch((url) => {
      if (url.includes("/prompts/puppy-first-bath")) {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      if (url.includes("/prompts?")) {
        return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    render(<PromptLibraryClient subdomain="test" />);
    fireEvent.click(await screen.findByTestId("prompt-card"));
    await screen.findByTestId("prompt-detail-error");
    fireEvent.click(screen.getByTestId("prompt-detail-back"));
    expect(await screen.findByTestId("prompt-card")).toBeTruthy();
    expect(screen.queryByTestId("prompt-detail-error")).toBeNull();
  });

  it("copy failure shows a proper error note, keeps the wording, and does not change the count", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
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
    fireEvent.click(screen.getByTestId("prompt-detail-copy"));
    const note = await screen.findByTestId("prompt-detail-copy-error");
    expect(note.getAttribute("role")).toBe("alert");
    expect(note.className).toContain("border-brand-rose");
    expect(
      screen.getByText(
        "Copying failed. Please try again — the count was not changed.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Copied 12 times")).toBeTruthy();
  });

  it("favourite failure shows a visible message while still reverting the heart", async () => {
    const fetchMock = mockFetch((url) => {
      if (url.includes("/favourite")) {
        return Promise.reject(new Error("down"));
      }
      if (url.includes("/prompts?")) {
        return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    // The tenant layout mounts the shared Toaster in production;
    // mount it here so the toast is observable in this test.
    // Clear any toast queued by the earlier revert-only test (it
    // fired toast.error with no Toaster mounted, so Sonner queues
    // it) — otherwise this test sees two copies of the message.
    act(() => {
      toast.dismiss();
    });
    render(
      <>
        <Toast />
        <PromptLibraryClient subdomain="test" />
      </>,
    );
    await screen.findByTestId("prompt-card");
    const heart = screen.getByTestId("prompt-card-favourite");
    fireEvent.click(heart);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url, init]) =>
          String(url).includes("/favourite") && init?.method === "POST",
        ),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(heart.getAttribute("aria-pressed")).toBe("false");
    });
    // Visible failure message — never a silent revert again.
    expect(
      await screen.findByText("Couldn't save this change. Please try again."),
    ).toBeTruthy();
  });

  it("Load more appends page 2 and hides when no more pages remain", async () => {
    const fetchMock = mockFetch((url) => {
      if (String(url).includes("page=2")) {
        return okJson({ items: [secondItem], total: 51, page: 2, pageSize: 50 });
      }
      if (url.includes("/prompts?")) {
        // Page size is 50, so a server total of 51 is the smallest
        // total with a second page — the button must show.
        return okJson({ items: [listItem], total: 51, page: 1, pageSize: 50 });
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-card");
    const loadMore = screen.getByTestId("prompt-library-load-more");
    expect(loadMore).toBeTruthy();
    fireEvent.click(loadMore);
    // Page 1 card is still there; page 2 is appended, not swapped in.
    expect(
      await screen.findByRole("heading", { name: "Kitten first bath" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Puppy first bath" }),
    ).toBeTruthy();
    expect(screen.getAllByTestId("prompt-card")).toHaveLength(2);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("page=2")),
    ).toBe(true);
    // 2 × 50 covers the total of 51: no more pages, button hides.
    await waitFor(() => {
      expect(screen.queryByTestId("prompt-library-load-more")).toBeNull();
    });
  });

  it("Load more resets to page 1 when the search changes", async () => {
    const fetchMock = mockFetch((url) => {
      if (String(url).includes("search=puppy")) {
        return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
      }
      if (String(url).includes("page=2")) {
        return okJson({ items: [secondItem], total: 51, page: 2, pageSize: 50 });
      }
      if (url.includes("/prompts?")) {
        return okJson({ items: [listItem], total: 51, page: 1, pageSize: 50 });
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-card");
    fireEvent.click(screen.getByTestId("prompt-library-load-more"));
    await screen.findByRole("heading", { name: "Kitten first bath" });
    expect(screen.getAllByTestId("prompt-card")).toHaveLength(2);
    fetchMock.mockClear();
    fireEvent.change(screen.getByPlaceholderText("Search prompts…"), {
      target: { value: "puppy" },
    });
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url).includes("search=puppy") &&
            String(url).includes("page=1"),
        ),
      ).toBe(true);
    });
    // Fresh page 1 replaces the appended pages: only the first card.
    await waitFor(() => {
      expect(screen.getAllByTestId("prompt-card")).toHaveLength(1);
    });
    expect(
      screen.getByRole("heading", { name: "Puppy first bath" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("prompt-library-load-more")).toBeNull();
  });

  it("renders filter dropdowns from facets, not hardcoded lists, with All first and Sort unchanged", async () => {
    mockFetch((url) => {
      if (url.includes("/prompts/facets")) {
        return okJson(facetsBody);
      }
      if (url.includes("/prompts?")) {
        return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-card");
    fireEvent.click(screen.getByRole("button", { name: /Category: All/ }));
    const categoryOptions = screen.getByTestId(
      "prompt-top-section-filter-category-options",
    );
    const optionButtons = categoryOptions.querySelectorAll('[role="option"]');
    expect(optionButtons[0].textContent).toContain("All");
    expect(screen.getByRole("option", { name: "Animals" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Comedy" })).toBeTruthy();
    // Unused values disappear on their own — no hardcoded list.
    expect(screen.queryByRole("option", { name: "Unboxing" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Tutorial" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Tool: All/ }));
    expect(screen.getByRole("option", { name: "Dola AI" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Veo 3" })).toBeNull();
    // Sort is NOT dynamic: its modes stay fixed.
    fireEvent.click(screen.getByRole("button", { name: /Sort: Newest/ }));
    expect(screen.getByRole("option", { name: "Newest" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Most copied" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "A to Z" })).toBeTruthy();
  });

  it("facets failure shows a visible filter error (not hardcoded lists) and Retry recovers", async () => {
    let facetsCalls = 0;
    mockFetch((url) => {
      if (url.includes("/prompts/facets")) {
        facetsCalls += 1;
        if (facetsCalls === 1) {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        return okJson(facetsBody);
      }
      if (url.includes("/prompts?")) {
        return okJson({ items: [listItem], total: 1, page: 1, pageSize: 50 });
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    });
    render(<PromptLibraryClient subdomain="test" />);
    await screen.findByTestId("prompt-card");
    const banner = await screen.findByTestId("prompt-library-facets-error");
    expect(banner).toBeTruthy();
    expect(
      screen.getByText("Filter options could not be loaded."),
    ).toBeTruthy();
    // No silent hardcoded fallback: only "All" is offered.
    fireEvent.click(screen.getByRole("button", { name: /Category: All/ }));
    const options = screen.getByTestId(
      "prompt-top-section-filter-category-options",
    );
    expect(options.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(screen.queryByRole("option", { name: "Animals" })).toBeNull();
    // Close the dropdown first: fireEvent.click fires no mousedown,
    // so the outside-click close would not run, and the next
    // trigger click would toggle this dropdown shut instead of open.
    fireEvent.keyDown(document, { key: "Escape" });
    // Retry refetches facets: the banner clears and facets appear.
    fireEvent.click(screen.getByTestId("prompt-library-facets-retry"));
    await waitFor(() => {
      expect(screen.queryByTestId("prompt-library-facets-error")).toBeNull();
    });
    fireEvent.click(screen.getByRole("button", { name: /Category: All/ }));
    expect(screen.getByRole("option", { name: "Animals" })).toBeTruthy();
  });
});
