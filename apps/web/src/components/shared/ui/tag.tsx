"use client";

/**
 * Tag — shadcn Badge adapted to our semantics (matrix §26): a Tag is a
 * STATIC category label; a status is never a Tag (use StatusDot, which
 * carries icon + text). When the label must be removable, pass `onRemove`
 * and the Tag becomes the interactive chip form — a real button with an
 * accessible "Remove <label>" name, never a clickable-looking span.
 * The remove button's glyph stays 16px; its hit area is expanded to
 * 44px by the global `hit-area-44` utility (spec 142 F05), which paints
 * nothing and does not change the chip's layout box.
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { XIcon } from "lucide-react";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const tagVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-on-primary",
        secondary: "bg-subtle text-ink",
        outline: "border-line bg-transparent text-ink",
        ghost: "bg-transparent text-ink-sub",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

type TagProps = React.ComponentProps<"span"> &
  VariantProps<typeof tagVariants> & {
    asChild?: boolean;
    onRemove?: () => void;
    removeLabel?: string;
  };

function Tag({ className, variant = "default", asChild = false, onRemove, removeLabel, children, ...props }: TagProps) {
  const Comp = asChild ? Slot.Root : "span";
  return (
    <Comp
      data-slot="tag"
      data-variant={variant}
      className={cn(tagVariants({ variant }), className)}
      {...props}
    >
      {children}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? "Remove tag"}
          className="inline-flex hit-area-44 size-4 shrink-0 items-center justify-center rounded-full outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-link"
        >
          <XIcon aria-hidden />
        </button>
      ) : null}
    </Comp>
  );
}

export { Tag, tagVariants };
export type { TagProps };
