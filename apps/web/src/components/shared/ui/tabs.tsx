"use client";

/**
 * Tabs — shadcn base on Radix Tabs: the ARIA tabs pattern is Radix's
 * (roving tabindex, arrow-key movement, Home/End, activation semantics —
 * matrix §30). Two list variants: `default` (segmented panel) and `line`
 * (single hairline under the row; the active tab is marked by the
 * line trigger variant: bold ink text with a thick 3px ink underline).
 * A third trigger-only variant, `line-gold`, is identical to `line`
 * except the active tab uses brand gold for label text and underline —
 * it exists for the dedicated page tab row only; the Settings row and
 * every other `line` consumer keep the ink active state.
 * Tabs are for 2–9 peer sections; they are never a pseudo-wizard (matrix §6).
 * Geometry (spec 142 F07): the list is viewport-bounded (`max-w-full`)
 * and scrolls horizontally when its tabs overflow, and triggers are
 * 44px tall.
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn("flex gap-2 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:flex-row", className)}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  "inline-flex w-fit max-w-full items-center justify-center gap-1 overflow-x-auto text-ink-sub",
  {
    variants: {
      variant: {
        default: "h-11 rounded-md bg-subtle p-1",
        line: "border-b border-line bg-transparent",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

const tabsTriggerVariants = cva(
  "inline-flex h-9 grow basis-0 shrink-0 items-center justify-center gap-1.5 rounded-sm border-transparent px-3 text-body font-medium whitespace-nowrap text-ink-sub transition-colors duration-fast outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        // Segmented / default: active tab is a raised panel.
        default:
          "border-b-2 data-[state=active]:bg-panel data-[state=active]:text-ink data-[state=active]:shadow-card",
        // Line: active tab is bold ink text with a thick 3px ink
        // underline that overlaps the list hairline (-mb-px), so the
        // row shows one clean hairline and one strong active mark.
        // No background or shadow on active, and no faint underline
        // under inactive tabs. Ink is a theme token, so this works
        // in both light and dark themes.
        line: "-mb-px border-b-3 data-[state=active]:border-ink data-[state=active]:font-bold data-[state=active]:text-ink",
        // Line-gold: line geometry with a link active mark
        // (link label text + link underline). Dedicated page tab
        // row only; inactive tabs stay muted, hover unchanged.
        "line-gold":
          "-mb-px border-b-3 data-[state=active]:border-link data-[state=active]:font-bold data-[state=active]:text-link",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

function TabsTrigger({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & VariantProps<typeof tabsTriggerVariants>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      data-variant={variant}
      className={cn(tabsTriggerVariants({ variant }), className)}
      {...props}
    />
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content data-slot="tabs-content" className={cn("flex-1 outline-none", className)} {...props} />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants, tabsTriggerVariants };
