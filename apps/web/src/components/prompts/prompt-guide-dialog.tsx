"use client";

import React from "react";

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/shared/ui/dialog";

import { PromptGuideContent } from "@/components/prompts/prompt-guide-content";

/**
 * The single "How to use a master prompt" guide, opened as a
 * popup — NOT a page. The separate /prompts/guide page was
 * removed on Shahzeb's order ("open the guide in a popup not
 * a page"): this trigger card replaces the old guide link, and
 * the guide content renders inside the shared Radix Dialog
 * (focus trapped, Esc closes, backdrop click closes, focus
 * returns to the trigger on close — Radix mechanics, correct
 * by construction). The dialog scrolls internally (the shared
 * DialogContent is max-h-dvh overflow-y-auto), widened to
 * sm:max-w-2xl so the long guide reads comfortably.
 * Guide content itself is unchanged (PromptGuideContent).
 */
export function PromptGuideDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          data-testid="prompt-detail-guide-link"
          className="mt-6 flex w-full items-center justify-between gap-3 rounded-2xl border border-line bg-panel px-4 py-3 text-left"
        >
          <span className="text-sm text-ink">
            New here?{" "}
            <span className="font-semibold">
              How to use a master prompt
            </span>
          </span>
          <span aria-hidden className="font-semibold text-brand-gold">
            →
          </span>
        </button>
      </DialogTrigger>
      <DialogContent
        data-testid="prompt-guide-dialog"
        className="sm:max-w-2xl"
        aria-label="How to use a master prompt"
      >
        <DialogTitle>How to use a master prompt</DialogTitle>
        <PromptGuideContent />
      </DialogContent>
    </Dialog>
  );
}
