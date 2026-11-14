"use client";

/**
 * AlertDialog — shadcn base on Radix AlertDialog, implementing the
 * destructive pattern (UI Rule 3 / UX Rule 13 / matrix §3):
 * - role=alertdialog mechanics: Radix AlertDialog CANNOT be dismissed by
 *   outside click or Esc — only Action or Cancel closes it.
 * - Focus starts on CANCEL, not on the destructive action: AlertDialogContent
 *   intercepts the default auto-focus and moves it to the Cancel control.
 * - The confirm button names the VERB ("Delete post", never "OK"/"Yes"):
 *   that is the consumer's label on AlertDialogAction; the primitive keeps
 *   the destructive variant one prop away (`variant="destructive"`).
 * Reversible removals should NOT use this — delete-with-Undo (Toast) is the
 * default for those (UI Rule 3). Geometry (spec 142 F04): same phone
 * contract as Dialog — 16px viewport gutters on phones (`inset-x-4`,
 * centred `max-w-lg` panel from `sm` up), dynamic-viewport-bounded
 * height (`max-h-dvh`) and internal scrolling, so Action/Cancel stay
 * reachable at short heights.
 */
import * as React from "react";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { Button } from "./button";

function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

function AlertDialogOverlay({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn("fixed inset-0 z-dialog bg-neutral-black/60", className)}
      {...props}
    />
  );
}

function AlertDialogContent({
  className,
  onOpenAutoFocus,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        onEscapeKeyDown={(event) => {
          // Destructive pattern: Esc never dismisses an alert dialog
          // (Radix permits it by default; the research pattern forbids it).
          // A consumer with a genuine need may supply its own handler.
          if (onEscapeKeyDown) {
            onEscapeKeyDown(event);
            return;
          }
          event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          if (onOpenAutoFocus) {
            onOpenAutoFocus(event);
            return;
          }
          // Destructive pattern: initial focus belongs on Cancel.
          event.preventDefault();
          const root = event.currentTarget as HTMLElement;
          root.querySelector<HTMLElement>('[data-slot="alert-dialog-cancel"]')?.focus();
        }}
        className={cn(
          "fixed inset-x-4 top-1/2 z-dialog grid max-h-dvh -translate-y-1/2 gap-4 overflow-y-auto rounded-md border border-line bg-panel p-5 text-ink shadow-modal duration-base ease-enter outline-none sm:right-auto sm:left-1/2 sm:w-full sm:max-w-lg sm:-translate-x-1/2",
          className
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="alert-dialog-header" className={cn("flex flex-col gap-2 text-left", className)} {...props} />
  );
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function AlertDialogTitle({ className, ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-lg leading-heading font-semibold", className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-body text-ink-sub", className)}
      {...props}
    />
  );
}

function AlertDialogAction({
  className,
  variant = "destructive",
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Action data-slot="alert-dialog-action" className={className} {...props} />
    </Button>
  );
}

function AlertDialogCancel({
  className,
  variant = "outline",
  size = "default",
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <Button variant={variant} size={size} asChild>
      <AlertDialogPrimitive.Cancel data-slot="alert-dialog-cancel" className={className} {...props} />
    </Button>
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
