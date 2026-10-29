"use client";

/**
 * Button — shadcn base (cva variants + Radix Slot for asChild), adapted:
 * - Styling: token-backed utilities only. Primary is the Binance gold-on-black
 *   pairing (bg-primary / text-on-primary); shadcn's default theme is gone.
 * - Sizes: the compact control-height family (component tokens —
 *   default 36px, lg 40px, sm/icon-sm 32px), the single default density
 *   at every viewport (spec 129 OD-4 as amended, Shahzeb 2026-10-24:
 *   compact mode is the default, mobile included — this supersedes the
 *   spec 142 F01 44px primary touch band).
 * - Five states: `loading` renders a spinner at the button's final geometry
 *   with aria-busy and blocks activation; `disabledReason` implements
 *   disabled-with-a-reason (UI Rule 16 / UX Rule 19) — the reason is exposed
 *   as the accessible description and a data attribute, never a bare grey
 *   button with no explanation.
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2Icon } from "lucide-react";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-sm text-body font-medium whitespace-nowrap transition-colors duration-base ease-standard outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-signal-critical [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-on-primary hover:bg-brand-peru",
        destructive: "bg-brand-rose text-neutral-white hover:bg-brand-rose focus-visible:outline-signal-critical",
        outline: "border border-line bg-panel text-ink shadow-card hover:bg-hover",
        secondary: "bg-subtle text-ink hover:bg-hover",
        ghost: "text-ink hover:bg-hover",
        link: "text-link underline-offset-4 hover:underline",
      },
      size: {
        default: "h-control px-3 py-2",
        sm: "h-control-sm gap-1.5 px-3 text-metadata",
        lg: "h-control-lg px-5 text-lg",
        icon: "size-control",
        "icon-sm": "size-control-sm",
        "icon-lg": "size-control-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Loading state: spinner at final geometry, aria-busy, non-activatable. */
    loading?: boolean;
    /**
     * Disabled-with-a-reason: when set, the button is disabled and this text
     * becomes its accessible description (render it visibly nearby in forms).
     */
    disabledReason?: string;
  };

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  disabledReason,
  disabled,
  children,
  type,
  ...props
}: ButtonProps) {
  const isDisabled = Boolean(disabled || disabledReason || loading);
  const reasonId = React.useId();
  if (asChild) {
    return (
      <Slot.Root
        data-slot="button"
        data-variant={variant}
        data-size={size}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      >
        {children}
      </Slot.Root>
    );
  }
  return (
    <>
      <button
        type={type ?? "button"}
        data-slot="button"
        data-variant={variant}
        data-size={size}
        data-loading={loading || undefined}
        data-disabled-reason={disabledReason}
        aria-busy={loading || undefined}
        aria-describedby={disabledReason ? reasonId : props["aria-describedby"]}
        disabled={isDisabled}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      >
        {loading ? <Loader2Icon className="animate-spin" aria-hidden /> : null}
        {children}
      </button>
      {disabledReason ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
    </>
  );
}

export { Button, buttonVariants };
export type { ButtonProps };
