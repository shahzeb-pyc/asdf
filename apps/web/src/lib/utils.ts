/**
 * @file utils.ts
 * @description shadcn-convention class-name utility for the shared/ui
 * primitives layer (spec 129 PR-F3). This file did not exist before PR-F3;
 * it is created here because every shadcn-based primitive imports `cn`.
 * clsx composes conditional classes; tailwind-merge resolves conflicting
 * Tailwind utilities so a consumer's className override wins predictably.
 *
 * Custom token font sizes MUST be registered below. tailwind-merge's
 * default config only knows Tailwind's built-in font-size names, so it
 * treats a custom size such as `text-metadata` as a text-colour class:
 * `cn("text-metadata text-ink-sub")` collapsed to just `text-ink-sub`,
 * and every shared primitive that pairs a custom size with a custom
 * colour (FormLabel, FormDescription, FormMessage, Alert) silently
 * rendered at the inherited 16px instead of its token size. That was
 * the root cause of the auth hints/errors/labels reading as body
 * copy. Registering the token sizes in the font-size group restores
 * them, while consumer overrides still win (verified: an override
 * of `text-xs text-ink-dim` still replaces `text-metadata
 * text-ink-sub`).
 */
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // Token font sizes from apps/web/tokens/ (see
      // styles/tokens.generated.css: --font-size-*). Standard names
      // (xs, base, lg, xl, ...) are already known to tailwind-merge;
      // only the custom token names need registering here.
      "font-size": [{ text: ["body", "metadata", "xxl", "xxxl"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
