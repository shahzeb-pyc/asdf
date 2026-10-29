"use client";

/**
 * Switch — shadcn base on Radix Switch. Adapted per matrix §14: a switch is
 * a single on/off that takes effect IMMEDIATELY (no Save) — never place one
 * inside a submit form. Sizes are spacing-scale values giving a 24px-tall
 * visual track at the default size; the global `hit-area-44` utility
 * expands the hit area to 44px in both dimensions (the default track is
 * already 44px wide, so it gains height only) without changing the
 * layout box (spec 142 F08).
 */
import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer hit-area-44 inline-flex shrink-0 items-center rounded-full border border-line-strong bg-subtle outline-none transition-colors duration-fast focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[size=default]:h-6 data-[size=default]:w-11 data-[size=sm]:h-5 data-[size=sm]:w-9",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-neutral-white shadow-card ring-0 transition-transform duration-fast data-[state=unchecked]:translate-x-0.5",
          size === "sm" ? "size-4 data-[state=checked]:translate-x-4" : "size-5 data-[state=checked]:translate-x-5"
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
