"use client";

/**
 * Banner — built new (shadcn has no Banner). Per the feedback taxonomy
 * (matrix §8) and UI Rule 22, a Banner is persistent state affecting the
 * whole page or account (e.g. an expired connection) and carries its own
 * fix action. It sits at the top of a view, is never a toast, and stays
 * until the state resolves or the user dismisses it. Geometry (spec 142
 * F14/F05): the row wraps, the fix action moves to its own full-width row
 * below `sm`, and the dismiss control is a 36px target (compact default
 * density — spec 129 OD-4 as amended, Shahzeb 2026-10-24). Colour + icon + text
 * (OD-3): the variant's icon always renders alongside the message.
 */
import * as React from "react";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const BANNER_VARIANTS = {
  info: { icon: InfoIcon, role: "status" as const, classes: "border-line bg-subtle text-ink" },
  warning: { icon: TriangleAlertIcon, role: "alert" as const, classes: "border-link bg-subtle text-ink" },
  critical: { icon: CircleAlertIcon, role: "alert" as const, classes: "border-brand-rose bg-subtle text-ink" },
  success: { icon: CircleCheckIcon, role: "status" as const, classes: "border-brand-emerald bg-subtle text-ink" },
};

type BannerProps = React.ComponentProps<"div"> & {
  variant?: keyof typeof BANNER_VARIANTS;
  title: string;
  description?: string;
  /** The banner's own fix action (e.g. a Reconnect button) — exactly one. */
  action?: React.ReactNode;
  onDismiss?: () => void;
};

function Banner({ variant = "info", title, description, action, onDismiss, className, ...props }: BannerProps) {
  const { icon: Icon, role, classes } = BANNER_VARIANTS[variant];
  return (
    <div
      data-slot="banner"
      data-variant={variant}
      role={role}
      className={cn("flex w-full flex-wrap items-start gap-3 border-b px-4 py-3 text-body", classes, className)}
      {...props}
    >
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {description ? <p className="text-ink-sub">{description}</p> : null}
      </div>
      {action ? <div className="max-sm:order-last max-sm:w-full">{action}</div> : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss banner"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-sm text-ink-sub outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
        >
          <XIcon className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export { Banner };
export type { BannerProps };
