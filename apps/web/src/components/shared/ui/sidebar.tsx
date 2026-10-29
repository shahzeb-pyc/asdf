"use client";

/**
 * Sidebar — REBUILD OF THE SAME upstream shadcn sidebar component
 * (Shahzeb's directive, 2026-10-22): same component set, same variants
 * (sidebar / floating / inset), same collapsible modes (offcanvas / icon /
 * none), same provider + cookie persistence + Cmd/Ctrl+B shortcut, and the
 * same menu-button composition. It is built from the UPSTREAM shadcn
 * source — not from any legacy file — and re-based onto this design system:
 * - Widths come from the spacing scale (expanded 16rem, mobile 18rem, icon
 *   3rem — the same values the shell variables in globals.css carry),
 *   replacing upstream's CSS-variable inline styles (zero inline styles).
 * - Colours are the semantic tokens (panel / ink / hover / active / line),
 *   replacing upstream's sidebar-specific theme variables.
 * - Spec 110 single-click navigation: a menu button is ONE control — a
 *   leaf item rendered as an anchor (asChild with a link) navigates on a
 *   single click in every state, expanded or icon-collapsed; nothing
 *   requires a double click or an expand-first click on a leaf item.
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { PanelLeftIcon } from "lucide-react";
import { Dialog as DialogPrimitive, Slot } from "radix-ui";

import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Input } from "./input";
import { Skeleton } from "./skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

const SIDEBAR_COOKIE_NAME = "sidebar_state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_KEYBOARD_SHORTCUT = "b";
const MOBILE_BREAKPOINT = 768;

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);
  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return !!isMobile;
}

type SidebarContextProps = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar(): SidebarContextProps {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }
  return context;
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);
  const [_open, _setOpen] = React.useState(defaultOpen);
  const open = openProp ?? _open;
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value;
      if (setOpenProp) {
        setOpenProp(openState);
      } else {
        _setOpen(openState);
      }
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
    },
    [setOpenProp, open]
  );

  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((value) => !value) : setOpen((value) => !value);
  }, [isMobile, setOpen, setOpenMobile]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar]);

  const state = open ? "expanded" : "collapsed";
  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({ state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar }),
    [state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar]
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider delayDuration={0}>
        <div
          data-slot="sidebar-wrapper"
          className={cn("group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-panel", className)}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  );
}

function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

  if (collapsible === "none") {
    return (
      <div
        data-slot="sidebar"
        className={cn("flex h-full w-64 flex-col bg-panel text-ink", className)}
        {...props}
      >
        {children}
      </div>
    );
  }

  if (isMobile) {
    // Mobile: the upstream Sheet behaviour, built on the Dialog primitive —
    // focus trapped while open, Esc closes, focus returns to the trigger.
    // Safe-area (spec 142, F03): the sheet is flush with the viewport
    // top, bottom and its anchored side, so it carries the globals.css
    // safe-area utilities (pt-safe / pb-safe, plus pl-safe or pr-safe on
    // the anchored edge) — first/last sheet content clears the notch and
    // the home indicator. Desktop rail below intentionally gets none.
    // Contract-only for now: this shared Sidebar has no live consumer
    // yet — spec 130 adopts it in the rebuilt shell (audit H-130).
    return (
      <DialogPrimitive.Root open={openMobile} onOpenChange={setOpenMobile}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-dialog bg-neutral-black/60" />
          <DialogPrimitive.Content
            data-sidebar="sidebar"
            data-slot="sidebar"
            data-mobile="true"
            aria-label="Sidebar"
            className={cn(
              "fixed inset-y-0 z-dialog flex w-72 flex-col bg-panel pt-safe pb-safe text-ink outline-none",
              side === "left" ? "left-0 pl-safe" : "right-0 pr-safe",
              className
            )}
            {...props}
          >
            <DialogPrimitive.Title className="sr-only">Sidebar</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Displays the mobile sidebar.
            </DialogPrimitive.Description>
            <div className="flex h-full w-full flex-col">{children}</div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    );
  }

  return (
    <div
      className="group peer hidden text-ink md:block"
      data-state={state}
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* The gap element that reserves layout width for the fixed container. */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          "relative w-64 bg-transparent transition-[width] duration-base ease-standard",
          "group-data-[collapsible=offcanvas]:w-0",
          "group-data-[side=right]:rotate-180",
          variant === "floating" || variant === "inset"
            ? "group-data-[collapsible=icon]:w-16"
            : "group-data-[collapsible=icon]:w-12"
        )}
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          "fixed inset-y-0 z-sticky hidden h-svh w-64 transition-[left,right,width] duration-base ease-standard md:flex",
          side === "left"
            ? "left-0 group-data-[collapsible=offcanvas]:-left-64"
            : "right-0 group-data-[collapsible=offcanvas]:-right-64",
          variant === "floating" || variant === "inset"
            ? "p-2 group-data-[collapsible=icon]:w-16"
            : "group-data-[collapsible=icon]:w-12 group-data-[side=left]:border-r group-data-[side=left]:border-line group-data-[side=right]:border-l group-data-[side=right]:border-line",
          className
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="flex h-full w-full flex-col bg-panel group-data-[variant=floating]:rounded-md group-data-[variant=floating]:border group-data-[variant=floating]:border-line group-data-[variant=floating]:shadow-card"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();
  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      className={className}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      {...props}
    >
      <PanelLeftIcon aria-hidden />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
}

function SidebarRail({ className, ...props }: React.ComponentProps<"button">) {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      type="button"
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle Sidebar"
      className={cn(
        "absolute inset-y-0 z-sticky hidden w-4 -translate-x-1/2 transition-all duration-base ease-standard group-data-[side=left]:-right-4 group-data-[side=right]:left-0 hover:bg-hover sm:flex",
        "group-data-[collapsible=offcanvas]:translate-x-0",
        className
      )}
      {...props}
    />
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        "relative flex w-full min-w-0 flex-1 flex-col bg-canvas",
        "md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-md md:peer-data-[variant=inset]:shadow-card md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2",
        className
      )}
      {...props}
    />
  );
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="sidebar-input"
      data-sidebar="input"
      className={cn("h-8 w-full bg-canvas shadow-none", className)}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="sidebar-header" data-sidebar="header" className={cn("flex flex-col gap-2 p-2", className)} {...props} />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="sidebar-footer" data-sidebar="footer" className={cn("flex flex-col gap-2 p-2", className)} {...props} />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="separator"
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn("mx-2 h-px w-auto bg-line", className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn("flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden", className)}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="sidebar-group" data-sidebar="group" className={cn("relative flex w-full min-w-0 flex-col p-2", className)} {...props} />
  );
}

function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-sm px-2 text-xs font-medium text-ink-sub outline-none transition-[margin,opacity] duration-base ease-standard focus-visible:outline-2 focus-visible:outline-link [&_svg]:size-4 [&_svg]:shrink-0",
        "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
        className
      )}
      {...props}
    />
  );
}

function SidebarGroupAction({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="sidebar-group-action"
      data-sidebar="group-action"
      className={cn(
        "absolute top-3.5 right-3 flex size-6 items-center justify-center rounded-sm p-0 text-ink outline-none transition-transform hover:bg-hover focus-visible:outline-2 focus-visible:outline-link [&_svg]:size-4 [&_svg]:shrink-0",
        "group-data-[collapsible=icon]:hidden",
        className
      )}
      {...props}
    />
  );
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="sidebar-group-content" data-sidebar="group-content" className={cn("w-full text-body", className)} {...props} />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul data-slot="sidebar-menu" data-sidebar="menu" className={cn("flex w-full min-w-0 flex-col gap-1", className)} {...props} />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li data-slot="sidebar-menu-item" data-sidebar="menu-item" className={cn("group/menu-item relative", className)} {...props} />
  );
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-sm p-2 text-left text-body outline-none transition-[width,height,padding] duration-base hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-link active:bg-active disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-active data-[active=true]:font-medium data-[active=true]:text-ink group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-2 [&>span:last-child]:truncate [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "hover:bg-hover hover:text-ink",
        outline: "border border-line bg-panel hover:bg-hover hover:text-ink",
      },
      size: {
        default: "min-h-9 text-body",
        sm: "min-h-8 text-metadata",
        lg: "min-h-10 text-body group-data-[collapsible=icon]:p-0",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipContent>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot.Root : "button";
  const { isMobile, state } = useSidebar();
  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      aria-current={isActive ? "page" : undefined}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  );
  if (!tooltip) return button;
  const tooltipProps = typeof tooltip === "string" ? { children: tooltip } : tooltip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={state !== "collapsed" || isMobile} {...tooltipProps} />
    </Tooltip>
  );
}

function SidebarMenuAction({
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
  showOnHover?: boolean;
}) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={cn(
        "absolute top-1.5 right-1 flex size-6 items-center justify-center rounded-sm p-0 text-ink outline-none transition-transform hover:bg-hover focus-visible:outline-2 focus-visible:outline-link peer-data-[size=sm]/menu-button:top-1 peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 [&_svg]:size-4 [&_svg]:shrink-0",
        "group-data-[collapsible=icon]:hidden",
        showOnHover &&
          "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 data-[state=open]:opacity-100 md:opacity-0",
        className
      )}
      {...props}
    />
  );
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        "pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-sm px-1 text-xs font-medium text-ink tabular-nums select-none",
        "peer-data-[size=sm]/menu-button:top-1 peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5",
        "group-data-[collapsible=icon]:hidden",
        className
      )}
      {...props}
    />
  );
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<"div"> & { showIcon?: boolean }) {
  return (
    <div
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn("flex h-8 items-center gap-2 rounded-sm px-2", className)}
      {...props}
    >
      {showIcon && <Skeleton className="size-4 rounded-sm" data-sidebar="menu-skeleton-icon" />}
      <Skeleton className="h-4 w-3/4 flex-1" data-sidebar="menu-skeleton-text" />
    </div>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        "mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-line px-2.5 py-0.5",
        "group-data-[collapsible=icon]:hidden",
        className
      )}
      {...props}
    />
  );
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li data-slot="sidebar-menu-sub-item" data-sidebar="menu-sub-item" className={cn("group/menu-sub-item relative", className)} {...props} />
  );
}

function SidebarMenuSubButton({
  asChild = false,
  size = "md",
  isActive = false,
  className,
  ...props
}: React.ComponentProps<"a"> & {
  asChild?: boolean;
  size?: "sm" | "md";
  isActive?: boolean;
}) {
  const Comp = asChild ? Slot.Root : "a";
  return (
    <Comp
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "flex min-h-8 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-sm px-2 text-ink outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-link active:bg-active disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-active [&>span:last-child]:truncate [&_svg]:size-4 [&_svg]:shrink-0",
        size === "sm" && "text-xs",
        size === "md" && "text-body",
        "group-data-[collapsible=icon]:hidden",
        className
      )}
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
  sidebarMenuButtonVariants,
};
