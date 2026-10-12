import {
  forwardRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type TdHTMLAttributes,
  type ThHTMLAttributes
} from "react";
import { cn } from "../cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "../overlays/tooltip";
import { scrollEdgeFadeStyle, useScrollEdgeFade } from "../scroll-edge-fade";

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
 * Figures compared across rows. A table wider than its box scrolls sideways inside the box; the
 * page never scrolls sideways. An edge that hides columns or rows says so twice: the content
 * fades towards it, and a faint shade stands on a side that hides columns, since a fade alone
 * shows nothing where the cut falls between two columns.
 */
export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { className, density = "default", stickyHeader = false, ...props },
  ref
) {
  const sideways = useScrollEdgeFade<HTMLDivElement>([], "x");
  const down = useScrollEdgeFade<HTMLDivElement>([], "y");
  // The head row stands at the top edge and fades what scrolls under it itself.
  const fades = [
    sideways.style?.maskImage,
    scrollEdgeFadeStyle({ above: false, below: down.overflow.below })?.maskImage
  ].filter((mask) => mask !== undefined);
  const mask = fades.length > 0 ? fades.join(", ") : undefined;
  return (
    <div
      data-slot="table-frame"
      className={cn(
        "relative w-full min-w-0",
        // The frame holds the border outside what scrolls, so the fade leaves it whole.
        stickyHeader && "overflow-hidden rounded-md border bg-card"
      )}
    >
      <div
        ref={(node) => {
          sideways.ref.current = node;
          down.ref.current = node;
        }}
        onScroll={() => {
          sideways.onScroll();
          down.onScroll();
        }}
        style={
          mask === undefined
            ? undefined
            : {
                maskImage: mask,
                WebkitMaskImage: mask,
                maskComposite: "intersect",
                WebkitMaskComposite: "source-in"
              }
        }
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
      {sideways.overflow.above ? <EdgeShade side="start" /> : null}
      {sideways.overflow.below ? <EdgeShade side="end" /> : null}
    </div>
  );
});

/** The shade on a side of the box that hides columns. */
function EdgeShade({ side }: { side: "start" | "end" }) {
  return (
    <span
      aria-hidden="true"
      data-slot="table-edge-shade"
      data-side={side}
      className={cn(
        "pointer-events-none absolute inset-y-0 z-20 w-4 from-foreground/15 to-transparent",
        side === "start" ? "left-0 bg-linear-to-r" : "right-0 bg-linear-to-l"
      )}
    />
  );
}

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
        // A row that scrolls under the head row fades into it and never meets its line cut.
        "group-data-sticky-header/table:after:pointer-events-none group-data-sticky-header/table:after:absolute group-data-sticky-header/table:after:inset-x-0 group-data-sticky-header/table:after:top-full group-data-sticky-header/table:after:h-3 group-data-sticky-header/table:after:bg-linear-to-b group-data-sticky-header/table:after:from-card group-data-sticky-header/table:after:to-transparent",
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
   * stays in the cell, for a screen reader and for copying, and shows in a tooltip when the
   * pointer rests on the cut text, the keyboard reaches it or a finger taps it. The tooltip
   * holds the cell's `title` when it has one, else its content when that is plain text; a cut
   * cell with neither has no tooltip. A cell with a tooltip needs a `UiRoot` above it.
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
        <CutValue width={truncate} whole={title ?? plainText(children)}>
          {children}
        </CutValue>
      )}
    </td>
  );
});

/** A value on one line, cut at `width` characters, with the whole value one step away. */
function CutValue({
  width,
  whole,
  children
}: {
  width: number;
  whole: string | undefined;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const style = { maxWidth: `${width}ch` };
  if (whole === undefined) {
    return (
      <span data-slot="table-cell-value" className="block truncate" style={style}>
        {children}
      </span>
    );
  }
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        asChild
        // A tap neither rests nor focuses by the keyboard, so a press opens the tooltip too.
        // Preventing the default keeps the trigger from closing it on the same press.
        onClick={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        <span
          tabIndex={0}
          data-slot="table-cell-value"
          className="block truncate rounded-sm focus-visible:focus-ring"
          style={style}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="break-words whitespace-normal">{whole}</TooltipContent>
    </Tooltip>
  );
}

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
