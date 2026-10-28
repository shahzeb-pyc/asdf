import type { Metadata } from "next";
import React from "react";

import { PromptTopSection } from "@/components/prompts/prompt-top-section";

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template (§3.3.4). */
export const metadata: Metadata = { title: "Prompt Library" };

/**
 * Prompt Library — STEP 1 ONLY (step-by-step rebuild), corrected.
 *
 * The "Coming soon" placeholder is replaced by the top section alone:
 * centred hero + search card, in the app's own design system and copy.
 * The reference image supplied the structure only, not its copy or
 * colours. Nothing below the search card exists yet — no grid, no
 * cards, no detail view, no copy action, no demo media, no backend.
 * The next steps are Shahzeb's to give, one at a time.
 * This page fetches nothing and calls no API.
 */
export default function TenantPromptLibraryPage() {
  return <PromptTopSection />;
}
