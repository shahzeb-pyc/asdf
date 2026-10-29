"use client";

/**
 * Select — shadcn base on Radix Select (listbox mechanics: arrows move,
 * typeahead works, Esc closes and returns focus — matrix §30). Use for
 * 6–15 known options (matrix §13); fewer visible options are radios, more
 * searchable options are a combobox in the surface specs. Trigger follows
 * the Input field contract (compact 36px default via the control-height
 * token — spec 129 OD-4 as amended, Shahzeb 2026-10-24, superseding the
 * spec 142 F01 44px band), token hairline,
 * aria-invalid state, and F02 field text: 16px below `sm` via `text-base`,
 * 13px product body via `sm:text-body`). Panel height is bounded by the
 * Radix available-height variable and the panel carries collision padding
 * (spec 142 F09); items are 36px rows.
 *
 * Layering (spec 133 PR-133-3 fix, named there): the panel uses the
 * overlay-top step, NOT the popover step — a Select is a legitimate
 * Dialog inhabitant (folder pickers in the media dialogs were the
 * first case), and at the popover step (9000) the panel renders
 * behind a dialog's overlay (9500) and stops receiving pointer
 * events (proven by a browser hit-test in PR-133-3). Menus and
 * popovers keep the popover step; they are not Dialog inhabitants
 * in any current surface.
 *
 * Width contract: the trigger sizes to its content (`w-fit`, so
 * toolbar selects stay intrinsic on wide layouts) but is capped at
 * its container (`max-w-full` + `min-w-0`), and the value truncates
 * with an ellipsis. Without the cap, `whitespace-nowrap` inflates
 * the trigger's min-content size past narrow columns — a long
 * placeholder measured 321px inside a 320px viewport during the
 * spec 132 composer builds, which those surfaces patched locally
 * with `w-full`. The cap belongs here, not per surface; a consumer
 * may still force full width with `className="w-full"`. The value
 * is styled from the trigger via descendant selectors because
 * Radix's Select.Value swallows its own `className`.
 */
import * as React from "react";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default";
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit max-w-full min-w-0 items-center justify-between gap-2 rounded-sm border border-line bg-canvas px-3 text-base whitespace-nowrap text-ink transition-colors duration-fast outline-none focus-visible:border-link disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-signal-critical data-[placeholder]:text-ink-dim data-[size=default]:h-control data-[size=sm]:h-control-sm sm:text-body [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4 [&>[data-slot=select-value]]:min-w-0 [&>[data-slot=select-value]]:truncate",
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="opacity-50" aria-hidden />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = "popper",
  align = "center",
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          "relative z-overlay-top max-h-(--radix-select-content-available-height) max-w-(--radix-select-content-available-width) min-w-32 overflow-x-hidden overflow-y-auto rounded-md border border-line bg-panel text-ink shadow-elevated data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1",
          className
        )}
        position={position}
        align={align}
        collisionPadding={collisionPadding}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("px-2 py-1.5 text-metadata text-ink-sub", className)}
      {...props}
    />
  );
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex min-h-9 w-full cursor-default items-center gap-2 rounded-xs py-1.5 pr-8 pl-2 text-body outline-none select-none focus:bg-hover focus:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
        className
      )}
      {...props}
    >
      <span data-slot="select-item-indicator" className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon aria-hidden />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("pointer-events-none -mx-1 my-1 h-px bg-line", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn("flex cursor-default items-center justify-center py-1 [&_svg]:size-4", className)}
      {...props}
    >
      <ChevronUpIcon aria-hidden />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn("flex cursor-default items-center justify-center py-1 [&_svg]:size-4", className)}
      {...props}
    >
      <ChevronDownIcon aria-hidden />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
