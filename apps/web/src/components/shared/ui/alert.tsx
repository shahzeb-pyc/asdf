/**
 * Alert — shadcn base (cva + role="alert"), adapted to the feedback taxonomy
 * (UI decision matrix §8): an Alert is an in-flow, section-scoped message.
 * Page/account-level persistent state belongs to Banner; transient results
 * belong to Toast. Variants carry colour + icon + text (OD-3) — consumers
 * pass an icon element as a child; the layout reserves its column.
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative flex w-full items-start gap-3 rounded-md border border-line bg-panel px-4 py-3 text-body text-ink",
  {
    variants: {
      variant: {
        default: "border-line",
        destructive: "border-signal-critical text-signal-critical",
        success: "border-brand-emerald text-brand-emerald",
        warning: "border-link text-ink",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      data-variant={variant ?? "default"}
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("font-medium text-ink", className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("text-ink-sub", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, alertVariants };
