/**
 * Textarea — shadcn base, adapted to the same field contract as Input
 * (token hairline, aria-invalid error state, focus-visible ring baseline,
 * and the spec 142 F02 field text size: 16px below `sm` via `text-base`
 * so iOS does not focus-zoom, 13px product body via `sm:text-body`).
 */
import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-16 w-full rounded-sm border border-line bg-canvas px-3 py-2 text-base text-ink transition-colors duration-fast outline-none placeholder:text-ink-dim focus-visible:border-link disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-brand-rose sm:text-body",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
