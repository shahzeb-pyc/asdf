"use client";

/**
 * Menu — shadcn DropdownMenu base on Radix DropdownMenu, exported under the
 * research name (Popover/Menu primitive). Overflow menus hold SECONDARY
 * actions only — the primary action never lives only inside a menu
 * (matrix §12 / UI Rule 19). Mechanics (Radix): arrows move, typeahead
 * works, Esc closes AND returns focus, Tab moves on without a trap
 * (matrix §30). Geometry (spec 142 F09): item rows are 36px (compact
 * default density — spec 129 OD-4 as amended, Shahzeb 2026-10-24,
 * superseding the F01 44px band), the panel is
 * bounded by the Radix available-height variable instead of a fixed
 * height, and the panel carries collision padding by default.
 */
import * as React from "react";
import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Menu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="menu" {...props} />;
}

function MenuPortal({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="menu-portal" {...props} />;
}

function MenuTrigger({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="menu-trigger" {...props} />;
}

function MenuContent({
  className,
  layer,
  sideOffset = 4,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  /**
   * Stacking layer for the portalled panel. Default (undefined) keeps the
   * current z-popover behaviour. Pass "overlayTop" when the menu lives
   * inside a dialog (z-dialog 9500 > z-popover 9000), otherwise the panel
   * renders underneath the dialog and is invisible/unclickable — the same
   * convention as the shared Popover's overlayTop variant. The layer is a
   * mutually exclusive ternary, never two z classes at once: cn() only
   * merges the font-size group, so appending a second z class via
   * className would leave both on the element and let stylesheet order
   * decide the computed z-index instead of intent.
   */
  layer?: "popover" | "overlayTop" | undefined;
}) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="menu-content"
        data-layer={layer}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          layer === "overlayTop" ? "z-overlay-top" : "z-popover",
          "max-h-(--radix-dropdown-menu-content-available-height) min-w-32 overflow-x-hidden overflow-y-auto rounded-md border border-line bg-panel p-1 text-ink shadow-elevated outline-none",
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function MenuGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "relative flex min-h-9 cursor-default items-center gap-2 rounded-xs px-2 py-1.5 text-body outline-none select-none focus:bg-hover focus:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 data-[variant=destructive]:text-signal-critical data-[variant=destructive]:focus:bg-subtle data-[variant=destructive]:focus:text-signal-critical-on-tint [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
        className
      )}
      {...props}
    />
  );
}

function MenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="menu-checkbox-item"
      className={cn(
        "relative flex min-h-9 cursor-default items-center gap-2 rounded-xs py-1.5 pr-2 pl-8 text-body outline-none select-none focus:bg-hover focus:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
        className
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon aria-hidden />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function MenuRadioGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="menu-radio-item"
      className={cn(
        "relative flex min-h-9 cursor-default items-center gap-2 rounded-xs py-1.5 pr-2 pl-8 text-body outline-none select-none focus:bg-hover focus:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-3",
        className
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="fill-current" aria-hidden />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function MenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="menu-label"
      data-inset={inset}
      className={cn("px-2 py-1.5 text-metadata font-medium text-ink-sub data-[inset]:pl-8", className)}
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="menu-separator"
      className={cn("-mx-1 my-1 h-px bg-line", className)}
      {...props}
    />
  );
}

function MenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="menu-shortcut"
      className={cn("ml-auto text-metadata tracking-caption text-ink-dim", className)}
      {...props}
    />
  );
}

function MenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="menu-sub" {...props} />;
}

function MenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex min-h-9 cursor-default items-center gap-2 rounded-xs px-2 py-1.5 text-body outline-none select-none focus:bg-hover focus:text-ink data-[inset]:pl-8 data-[state=open]:bg-hover [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" aria-hidden />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function MenuSubContent({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="menu-sub-content"
      className={cn(
        "z-popover min-w-32 overflow-hidden rounded-md border border-line bg-panel p-1 text-ink shadow-elevated outline-none",
        className
      )}
      {...props}
    />
  );
}

/** shadcn-name aliases (DropdownMenu*) for consumers following upstream docs. */
const DropdownMenu = Menu;
const DropdownMenuTrigger = MenuTrigger;
const DropdownMenuContent = MenuContent;
const DropdownMenuItem = MenuItem;
const DropdownMenuGroup = MenuGroup;
const DropdownMenuPortal = MenuPortal;
const DropdownMenuSeparator = MenuSeparator;
const DropdownMenuLabel = MenuLabel;
const DropdownMenuCheckboxItem = MenuCheckboxItem;
const DropdownMenuRadioGroup = MenuRadioGroup;
const DropdownMenuRadioItem = MenuRadioItem;
const DropdownMenuShortcut = MenuShortcut;
const DropdownMenuSub = MenuSub;
const DropdownMenuSubTrigger = MenuSubTrigger;
const DropdownMenuSubContent = MenuSubContent;

export {
  Menu,
  MenuPortal,
  MenuTrigger,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuLabel,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubTrigger,
  MenuSubContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
