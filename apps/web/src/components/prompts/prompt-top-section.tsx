"use client";

import * as React from "react";
import { SearchIcon } from "lucide-react";

import { Button } from "@/components/shared/ui/button";
import { Input } from "@/components/shared/ui/input";

/**
 * Prompt Library top section — STEP 1 ONLY.
 *
 * This is the whole page for this step: centred hero + search card, and
 * nothing below it. No grid, no cards, no detail view, no copy action,
 * no demo media, no backend — those are later steps, decided by Shahzeb.
 *
 * Look deviation, stated plainly (per the step brief, which makes the
 * reference image the authority for this section): the reference is a
 * light cream page with a peach glow and solid red/orange accents. The
 * app's token system has no cream or red for this — Button's default is
 * Binance gold-on-black and the page tokens are dark/light canvas — so
 * the cream background, peach glow, red "Try Now" button and red active
 * pill are scoped to this component with explicit colours below. The
 * Button and Input primitives themselves are still used (focus, sizing,
 * accessible pressed state), with their colours overridden for this
 * section only. Nothing else in the app is touched by these colours.
 */
export const PROMPT_TOP_CATEGORIES = [
  "All",
  "UGC",
  "Money Shot",
  "Try-On",
  "TVC",
  "Product Launch",
  "Tutorial",
  "Problem/Solution",
  "Unboxing",
] as const;

function pillTestId(category: string) {
  return `prompt-top-section-pill-${category.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
}

export function PromptTopSection() {
  const [activeCategory, setActiveCategory] = React.useState<string>("All");
  const searchWrapRef = React.useRef<HTMLLabelElement>(null);

  // "Try Now" is a visual top-section action for this step only: it
  // scrolls to and focuses the search box below. It opens no new page,
  // signup, or generator flow — those do not exist yet.
  const focusSearch = () => {
    const input = searchWrapRef.current?.querySelector("input");
    input?.scrollIntoView?.({ block: "center" });
    input?.focus();
  };

  return (
    <section
      data-testid="prompt-top-section"
      className="relative overflow-hidden bg-[#fdf9f2] px-4 py-12 sm:px-6 sm:py-16"
    >
      {/* Soft peach glow behind the heading, as in the reference image. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-16 size-[420px] -translate-x-1/2 rounded-full bg-[#ffe7d8] opacity-80 blur-3xl sm:size-[560px]"
      />

      <div className="relative mx-auto flex max-w-3xl flex-col items-center text-center">
        <span className="rounded-full border border-[#f0d9c8] bg-white px-3 py-1 text-xs font-medium text-[#d64526]">
          Video prompts with HD previews
        </span>
        <h1 className="mt-5 text-5xl font-bold leading-[1.05] tracking-tight text-[#1c130c] sm:text-6xl">
          AI Video Prompt Gallery
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-[#6f6257] sm:text-lg">
          See the result first, then copy the prompt and adapt it for your own video. Browse
          real ad formats including UGC, product shots, tutorials, unboxing, and more.
        </p>
        <Button
          data-testid="prompt-top-section-try-now"
          size="lg"
          onClick={focusSearch}
          className="mt-7 h-11 rounded-lg bg-[#e14b2a] px-7 text-base font-medium text-white shadow-md hover:bg-[#c93f22]"
        >
          Try Now
        </Button>
      </div>

      <div
        data-testid="prompt-top-section-search-card"
        className="relative mx-auto mt-10 w-full max-w-5xl rounded-2xl border border-[#eadfca] bg-[#fdf6e9] p-3 shadow-[0_10px_30px_rgba(0,0,0,0.08)] sm:p-4"
      >
        <label
          ref={searchWrapRef}
          className="flex items-center gap-2 rounded-xl border border-[#e5ddd0] bg-white px-3 py-1"
        >
          <SearchIcon aria-hidden className="size-5 shrink-0 text-[#8a7d72]" />
          <Input
            data-testid="prompt-top-section-search"
            type="search"
            placeholder="Search prompts, products, or categories..."
            aria-label="Search prompts, products, or categories"
            className="border-0 bg-transparent shadow-none focus-visible:border-transparent"
          />
        </label>

        <div
          role="group"
          aria-label="Prompt categories"
          className="mt-3 flex flex-wrap gap-2"
        >
          {PROMPT_TOP_CATEGORIES.map((category) => {
            const active = category === activeCategory;
            return (
              <Button
                key={category}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                aria-pressed={active}
                data-testid={pillTestId(category)}
                onClick={() => setActiveCategory(category)}
                className={
                  active
                    ? "rounded-full bg-[#e14b2a] px-4 text-white hover:bg-[#c93f22]"
                    : "rounded-full border-[#e5ddd0] bg-white px-4 text-[#1c130c] hover:bg-white"
                }
              >
                {category}
              </Button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
