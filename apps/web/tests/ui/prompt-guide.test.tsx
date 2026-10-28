/**
 * @file prompt-guide.test.tsx
 * @description The single "How to use a master prompt" guide page:
 * it renders the guide headings and the reference step, carries
 * no CM Tool Hub branding, and contains no per-prompt how-to
 * content. Static page: no fetch, no database.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import PromptGuidePage from "@/app/tenant/[subdomain]/prompts/guide/page";

describe("Prompt guide page", () => {
  it("renders the guide headings and the reference step", async () => {
    render(
      await PromptGuidePage({
        params: Promise.resolve({ subdomain: "test" }),
      }),
    );
    expect(await screen.findByTestId("prompt-guide")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "How to use a master prompt" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: /Step 5: Choose a reference image/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/The reference is the prompt's own preview media/),
    ).toBeTruthy();
    expect(screen.getAllByText(/USE YOUR DESIGN/).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText(/CM Tool Hub/)).toBeNull();
    expect(
      screen.getByRole("link", { name: /Back to prompts/ }),
    ).toBeTruthy();
  });
});
