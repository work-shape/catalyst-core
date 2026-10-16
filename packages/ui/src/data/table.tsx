import {
  Children,
  forwardRef,
  isValidElement,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type TdHTMLAttributes,
  type ThHTMLAttributes
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "../overlays/tooltip";
import { scrollEdgeFadeStyle, useScrollEdgeFade } from "../scroll-edge-fade";
import {
  FoldedValues,
  TableColumnContext,
  TableFoldContext,
  TableRowFoldContext,
  useColumnFold,
  useColumnFolding,
  useRowFolding
} from "./table-fold";

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
  /**
   * What the table does in room too narrow for its columns. `scroll` moves sideways under
   * the reader's finger, which fits a table read row by row. `stack` shows each row as a
   * block instead: the head is left out, and the cells stand in two columns in their order,
   * a cell with `stacked="full"` on a line of its own. Use it where the last column holds
   * what the reader acts with, which sideways scrolling would hide. The table measures the
   * room it is given itself, so it stacks in a narrow window and in a narrow column alike.
   */
  narrow?: "scroll" | "stack";
}

/** One rule for every part of a stacked table, set on the table so no part repeats it. */
const stackClasses =
  "@max-2xl/table:block @max-2xl/table:[&_thead]:hidden @max-2xl/table:[&_tbody]:block " +
  "@max-2xl/table:[&_tr]:grid @max-2xl/table:[&_tr]:grid-cols-[minmax(0,1fr)_auto] " +
  "@max-2xl/table:[&_tr]:items-center @max-2xl/table:[&_tr]:gap-x-3 @max-2xl/table:[&_tr]:py-2 " +
  "@max-2xl/table:[&_td]:block @max-2xl/table:[&_td]:py-1 " +
  "@max-2xl/table:[&_td[data-stacked=full]]:col-span-2";

/**
 * Figures compared across rows. A table wider than its box first folds the columns whose head
 * has a `priority` into the details of each row, then scrolls sideways inside the box; the
 * page never scrolls sideways. An edge that hides columns or rows says so twice: the content
 * fades towards it, and a faint shade stands on a side that hides columns, since a fade alone
 * shows nothing where the cut falls between two columns.
 */
export const Table = forwardRef<HTMLTableElement, TableProps>(function Table(
  { className, density = "default", stickyHeader = false, narrow = "scroll", children, ...props },
  ref
) {
  const sideways = useScrollEdgeFade<HTMLDivElement>([], "x");
  const down = useScrollEdgeFade<HTMLDivElement>([], "y");
  const tableNode = useRef<HTMLTableElement | null>(null);
  const fold = useColumnFolding(sideways.ref, tableNode);
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
        className={cn(
          "w-full",
          stickyHeader ? "max-h-128 overflow-auto" : "overflow-x-auto",
          narrow === "stack" && "@container/table"
        )}
      >
        <table
          ref={(node) => {
            tableNode.current = node;
            if (typeof ref === "function") {
              ref(node);
            } else if (ref) {
              ref.current = node;
            }
          }}
          data-density={density}
          data-sticky-header={stickyHeader ? "" : undefined}
          className={cn(
            "group/table w-full caption-bottom text-body",
            narrow === "stack" && stackClasses,
            className
          )}
          {...props}
        >
          <TableFoldContext value={fold}>{children}</TableFoldContext>
        </table>
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

/**
 * A row. Its heads and cells are its direct children, so each knows its column; a column that
 * folds needs that.
 */
export const TableRow = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  function TableRow({ className, children, ...props }, ref) {
    const row = useRowFolding();
    return (
      <tr
        ref={ref}
        className={cn("border-b transition-colors hover:bg-state-hover", className)}
        {...props}
      >
        <TableRowFoldContext value={row}>
          {Children.toArray(children).map((child, index) => (
            <TableColumnContext key={isValidElement(child) ? child.key : index} value={index}>
              {child}
            </TableColumnContext>
          ))}
        </TableRowFoldContext>
      </tr>
    );
  }
);

const cellAligns: Record<TableAlign, string> = {
  start: "text-start",
  end: "text-end tabular-nums"
};

export interface TableHeadProps extends Omit<ThHTMLAttributes<HTMLTableCellElement>, "align"> {
  align?: TableAlign;
  /**
   * Lets the column fold once the table cannot show every column at its full width. The
   * highest number folds first; a column without a priority never folds. A folded column's
   * values show in the details of each row, under this head's content, in the cell marked
   * `rowDetail`. Each folded cell also stays in its column, hidden, where the table measures
   * it, so its content renders twice: give such a column values, not controls with a state.
   */
  priority?: number;
}

export const TableHead = forwardRef<HTMLTableCellElement, TableHeadProps>(function TableHead(
  { className, align = "start", priority, children, ...props },
  ref
) {
  const { index, fold, folded } = useColumnFold();
  const register = fold?.register;
  useLayoutEffect(() => {
    if (priority === undefined || index === undefined || !register) {
      return;
    }
    return register(index, { priority, label: children });
  }, [register, index, priority, children]);
  return (
    <th
      ref={ref}
      data-column={priority === undefined ? undefined : index}
      data-folded={folded ? "" : undefined}
      className={cn(
        "h-10 px-3 align-middle text-caption font-medium whitespace-nowrap text-muted-foreground group-data-[density=compact]/table:h-8",
        // A collapsed border does not travel with a sticky cell, so the line under the head row
        // is drawn inside the cell.
        "group-data-sticky-header/table:sticky group-data-sticky-header/table:top-0 group-data-sticky-header/table:z-10 group-data-sticky-header/table:bg-card group-data-sticky-header/table:shadow-[inset_0_-1px_0_var(--border)]",
        // A row that scrolls under the head row fades into it and never meets its line cut.
        "group-data-sticky-header/table:after:pointer-events-none group-data-sticky-header/table:after:absolute group-data-sticky-header/table:after:inset-x-0 group-data-sticky-header/table:after:top-full group-data-sticky-header/table:after:h-3 group-data-sticky-header/table:after:bg-linear-to-b group-data-sticky-header/table:after:from-card group-data-sticky-header/table:after:to-transparent",
        cellAligns[align],
        "data-folded:hidden",
        className
      )}
      {...props}
    >
      {children}
    </th>
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
  /** In a table with `narrow="stack"`, the cell takes a line of its own once the rows stack. */
  stacked?: "full";
  /**
   * The cell holds the row's details: the values of the columns that folded, each under its
   * head's label, below the cell's own content. One cell per row, in a column that never folds.
   */
  rowDetail?: boolean;
}

export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(function TableCell(
  { className, align = "start", truncate, title, stacked, rowDetail, children, ...props },
  ref
) {
  const { index, fold, folded } = useColumnFold();
  const row = useContext(TableRowFoldContext);
  const content =
    truncate === undefined ? (
      children
    ) : (
      <CutValue width={truncate} whole={title ?? plainText(children)}>
        {children}
      </CutValue>
    );
  const slot = index === undefined ? undefined : row?.slots.get(index);
  return (
    <td
      ref={ref}
      title={truncate === undefined ? title : undefined}
      data-stacked={stacked}
      data-folded={folded ? "" : undefined}
      className={cn(
        "px-3 py-2.5 align-middle group-data-[density=compact]/table:py-1.5",
        cellAligns[align],
        "data-folded:hidden",
        className
      )}
      {...props}
    >
      {content}
      {folded && slot ? createPortal(content, slot) : null}
      {rowDetail && fold ? <FoldedValues columns={fold.folded} /> : null}
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
