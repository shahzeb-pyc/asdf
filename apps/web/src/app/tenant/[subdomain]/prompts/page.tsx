import type { Metadata } from "next";
import React from "react";

import { PromptMockCardGrid } from "@/components/prompts/prompt-mock-card-grid";
import { PromptTopSection } from "@/components/prompts/prompt-top-section";

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template (§3.3.4). */
export const metadata: Metadata = { title: "Prompt Library" };

/**
 * Prompt Library — step-by-step rebuild.
 *
 * Top section (heading, subtitle, search card with plain-text
 * expandable filters) plus, below it, a grid of MOCK cards using
 * the decided B design (uniform size, fixed preview height,
 * cleaner final-card layout). Clicking a card opens the dedicated
 * section for that prompt (mock master prompt + how-to steps);
 * cards carry no prompt or how-to text on the card itself.
 * Filters and search are still UI state only and do not filter
 * the mock cards yet. This page fetches nothing and calls no API.
 */
export default function TenantPromptLibraryPage() {
  return (
    <>
      <PromptTopSection />
      <PromptMockCardGrid />
    </>
  );
}
