"use client";

/**
 * Progress — shadcn base on Radix Progress. Mechanics (Radix, correct by
 * construction): the root carries role="progressbar" with aria-valuemin /
 * aria-valuemax / aria-valuenow from value/max, and the indicator's fill
 * width is derived from value by the primitive — callers never set an
 * inline width, so no surface adds to the inline-style count (spec 129
 * inline-style ratchet). Adapted: token track (bg-line) and fill
 * (bg-primary), the named rounded-full geometry, and no entry animation
 * classes from outside the token motion scale.
 */
import * as React from "react";
import { Progress as ProgressPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-line",
        className
      )}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 rounded-full bg-primary transition-transform"
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
