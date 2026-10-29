"use client";

/**
 * Table — shadcn base, adapted to UI Rule 10 (the table pattern): a toolbar
 * for global actions, a BATCH BAR that appears on selection and states the
 * count, applied filters visible as removable chips (the surface renders
 * them in the toolbar), pagination past ~50 rows (the Pagination primitive),
 * numerics right-aligned in tabular figures, the first column is the human
 * identifier, and the header is sticky. Rows are 40px (default density,
 * OD-4 — no density setting) with tabular numbers available via the
 * `tabular-nums` utility on numeric cells.
 *
 * Built new on top of the shadcn table: TableToolbar and TableBatchBar —
 * shadcn has no batch-bar pattern. The batch bar keeps the selection count
 * in text (never colour alone) and never silently includes filtered-out
 * items: the count is exactly the `selectedCount` the surface computed.
 */
import * as React from "react";
import { XIcon } from "lucide-react";

import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full caption-bottom text-body", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("bg-panel [&_tr]:border-b [&_tr]:border-line", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t border-line bg-subtle font-medium [&>tr]:last:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-line transition-colors duration-fast hover:bg-hover data-[state=selected]:bg-active",
        className
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "sticky top-0 h-9 bg-panel px-3 text-left align-middle font-medium whitespace-nowrap text-ink-sub",
        className
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td data-slot="table-cell" className={cn("h-9 px-3 align-middle whitespace-nowrap", className)} {...props} />;
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption data-slot="table-caption" className={cn("mt-4 text-body text-ink-sub", className)} {...props} />
  );
}

/** Global-actions row above a table (search, filters, primary table action). */
function TableToolbar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="table-toolbar"
      className={cn("flex flex-wrap items-center gap-2 py-2", className)}
      {...props}
    />
  );
}

type TableBatchBarProps = React.ComponentProps<"div"> & {
  /** Exact number of selected records — always stated in text. */
  selectedCount: number;
  /** Bulk actions for the selection (Schedule, Duplicate, Delete, …). */
  children: React.ReactNode;
  onClearSelection?: () => void;
};

/**
 * The selection batch bar (UI Rule 10): appears when selectedCount > 0,
 * sticks to the top of the table region, and states the count. Bulk
 * destructive actions rendered here still confirm with the count
 * (AlertDialog) — the bar itself never hides the consequence.
 */
function TableBatchBar({ selectedCount, children, onClearSelection, className, ...props }: TableBatchBarProps) {
  if (selectedCount <= 0) return null;
  return (
    <div
      data-slot="table-batch-bar"
      role="region"
      aria-label={`${selectedCount} selected`}
      className={cn(
        "sticky top-0 z-sticky flex flex-wrap items-center gap-2 border-b border-line bg-subtle px-4 py-2 text-body text-ink",
        className
      )}
      {...props}
    >
      <span className="font-medium tabular-nums">{selectedCount} selected</span>
      {children}
      {onClearSelection ? (
        <button
          type="button"
          onClick={onClearSelection}
          aria-label="Clear selection"
          className="ml-auto inline-flex size-8 items-center justify-center rounded-sm text-ink-sub outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
        >
          <XIcon className="size-4" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  TableToolbar,
  TableBatchBar,
};
export type { TableBatchBarProps };
