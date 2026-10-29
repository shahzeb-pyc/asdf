/**
 * Input — shadcn base, adapted: compact 36px height (the control-height
 * token; single default density at every viewport — spec 129 OD-4 as
 * amended, Shahzeb 2026-10-24, superseding the spec 142 F01 44px band)
 * and a 16px font below `sm` so iOS Safari does not
 * focus-zoom the page (spec 142 F02: `text-base` resolves to 1rem/16px;
 * at `sm` and up the field returns to the 13px product body size,
 * `text-body`). Token hairline border that strengthens on the light theme
 * via the semantic line tokens, aria-invalid carries the error state (colour + the inline
 * message the Field wrapper renders — never colour alone). Paste and
 * password managers are never blocked (UX Rule 28): no onPaste handlers, no
 * autocomplete suppression beyond what the consumer sets.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-control w-full min-w-0 rounded-sm border border-line bg-canvas px-3 py-2 text-base text-ink transition-colors duration-fast outline-none selection:bg-primary selection:text-on-primary placeholder:text-ink-dim focus-visible:border-link disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-brand-rose sm:text-body",
        className
      )}
      {...props}
    />
  );
}

export { Input };
