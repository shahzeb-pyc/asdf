"use client";

/**
 * Checkbox — shadcn base on Radix Checkbox (checked + indeterminate states,
 * full keyboard behaviour: Space toggles, focus-visible ring). Adapted:
 * the visual box is 24px rather than shadcn's 16px glyph, and the global
 * `hit-area-44` utility expands its hit area to 44px without changing
 * the layout box (spec 142 F08). A single checkbox is an opt-in
 * applied on submit (matrix §14); immediate-effect settings use Switch.
 */
import * as React from "react";
import { CheckIcon, MinusIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer hit-area-44 size-6 shrink-0 rounded-xs border border-line-strong bg-canvas outline-none transition-colors duration-fast focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-brand-rose data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-on-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-on-primary",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current [&_svg]:size-4"
      >
        {props.checked === "indeterminate" ? <MinusIcon aria-hidden /> : <CheckIcon aria-hidden />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
