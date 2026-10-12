import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  type TdHTMLAttributes,
  type ThHTMLAttributes
} from "react";
import { cn } from "../cn";
import { useScrollEdgeFade } from "../scroll-edge-fade";

/** `default` rows are 40 px high; `compact` rows are 32 px, for many rows read as data. */
export type TableDensity = "default" | "compact";
/** Where a column's content stands. Numbers compared down a column stand at its end. */
export type TableAlign = "start" | "end";

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  density?: TableDensity;
  /**
   * Keeps the head row in sight. The table then stands in a box of its own, at most 32rem
   * high, that scrolls in both directions: a head row can only stay inside what scrolls.
   */
  stickyHeader?: boolean;
}

/**
 * Figures compared across rows. A table wider than its box scrolls sideways inside the box,
 * with the library's fade on the edge that hides columns; the page never scrolls sideways.
 */
export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { className, density = "default", stickyHeader = false, ...props },
  ref
) {
  const fade = useScrollEdgeFade<HTMLDivElement>([], "x");
  const box = (
    <div
      ref={fade.ref}
      onScroll={fade.onScroll}
      style={fade.style}
      data-slot="table-box"
      className={cn("w-full", stickyHeader ? "max-h-128 overflow-auto" : "overflow-x-auto")}
    >
      <table
        ref={ref}
        data-density={density}
        data-sticky-header={stickyHeader ? "" : undefined}
        className={cn("group/table w-full caption-bottom text-body", className)}
        {...props}
      />
    </div>
  );
  // The frame stands outside what scrolls, so the edge fade leaves its border whole.
  return stickyHeader ? (
    <div data-slot="table-frame" className="w-full overflow-hidden rounded-md border bg-card">
      {box}
    </div>
  ) : (
    box
  );
});

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableHeader({ className, ...props }, ref) {
  return <thead ref={ref} className={cn("[&_tr]:border-b", className)} {...props} />;
});

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className, ...props }, ref) {
  return <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
});

export const TableRow = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  function TableRow({ className, ...props }, ref) {
    return (
      <tr
        ref={ref}
        className={cn("border-b transition-colors hover:bg-state-hover", className)}
        {...props}
      />
    );
  }
);

const cellAligns: Record<TableAlign, string> = {
  start: "text-start",
  end: "text-end tabular-nums"
};

export interface TableHeadProps extends Omit<ThHTMLAttributes<HTMLTableCellElement>, "align"> {
  align?: TableAlign;
}

export const TableHead = forwardRef<HTMLTableCellElement, TableHeadProps>(function TableHead(
  { className, align = "start", ...props },
  ref
) {
  return (
    <th
      ref={ref}
      className={cn(
        "h-10 px-3 align-middle text-caption font-medium whitespace-nowrap text-muted-foreground group-data-[density=compact]/table:h-8",
        // A collapsed border does not travel with a sticky cell, so the line under the head row
        // is drawn inside the cell.
        "group-data-sticky-header/table:sticky group-data-sticky-header/table:top-0 group-data-sticky-header/table:z-10 group-data-sticky-header/table:bg-card group-data-sticky-header/table:shadow-[inset_0_-1px_0_var(--border)]",
        cellAligns[align],
        className
      )}
      {...props}
    />
  );
});

export interface TableCellProps extends Omit<TdHTMLAttributes<HTMLTableCellElement>, "align"> {
  align?: TableAlign;
  /**
   * Keeps the value on one line and cuts it after about this many characters. The whole value
   * stays in the cell for a screen reader and shows as the tooltip of the cut text: the cell's
   * `title` when it has one, else its content when that is plain text.
   */
  truncate?: number;
}

export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(function TableCell(
  { className, align = "start", truncate, title, children, ...props },
  ref
) {
  return (
    <td
      ref={ref}
      title={truncate === undefined ? title : undefined}
      className={cn(
        "px-3 py-2.5 align-middle group-data-[density=compact]/table:py-1.5",
        cellAligns[align],
        className
      )}
      {...props}
    >
      {truncate === undefined ? (
        children
      ) : (
        <span
          data-slot="table-cell-value"
          title={title ?? plainText(children)}
          className="block truncate"
          style={{ maxWidth: `${truncate}ch` }}
        >
          {children}
        </span>
      )}
    </td>
  );
});

/** The text of a cell whose content is text or a number, which is what a tooltip can show. */
function plainText(content: ReactNode): string | undefined {
  return typeof content === "string" || typeof content === "number" ? String(content) : undefined;
}

/**
 * A second line in a cell, under its value: what belongs to the value and matters less, such as
 * the time under a date or a share under a total. A table with many facts per row stays as wide
 * as its box this way, with fewer columns instead of a row that runs out of sight.
 */
export const TableCellDetail = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  function TableCellDetail({ className, ...props }, ref) {
    return (
      <span
        ref={ref}
        className={cn("block text-caption text-muted-foreground", className)}
        {...props}
      />
    );
  }
);
