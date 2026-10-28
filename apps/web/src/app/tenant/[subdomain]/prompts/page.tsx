import type { Metadata } from "next";
import React from "react";

import { PromptLibraryClient } from "@/components/prompts/prompt-library-client";

/** Title resolves through the tenant layout's `<Section> · <Workspace>` template (§3.3.4). */
export const metadata: Metadata = { title: "Prompt Library" };

/**
 * Prompt Library — real backend wiring.
 *
 * Top section (heading, subtitle, search card with plain-text
 * expandable filters) plus, below it, a grid of real catalogue
 * cards using the decided B design (uniform size, fixed preview
 * height, cleaner final-card layout). Search and filters refetch
 * the list from the prompt API; clicking a card opens the
 * dedicated section for that prompt (preview on top, master
 * prompt in a scrollable field with Copy in its header, and a
 * link to the single "How to use a master prompt" guide —
 * per-prompt how-to steps are no longer rendered there —
 * fetched by slug); the favourite heart persists via the
 * API; the copy button copies the master prompt and increments
 * the real copied count via the copy RPC.
 *
 * The catalogue is admin-only: prompts are never uploaded by
 * users, and there is no "add prompt" UI here — admins add prompts
 * via the backend API (see docs/prompt-library-admin.md). Until
 * an admin adds the first prompt, the page shows "No prompts yet"
 * — no mock cards, no fake counts.
 */
export default async function TenantPromptLibraryPage({
  params,
}: {
  params: Promise<{ subdomain: string }>;
}) {
  const { subdomain } = await params;
  return <PromptLibraryClient subdomain={subdomain} />;
}
