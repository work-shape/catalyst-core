import type { JSX } from "react";
import { cn, Table } from "@work-shape/catalyst-ui";
import { TableCopyDropdown, type ExtraProps } from "streamdown";

/**
 * A table in a reply or a Markdown preview. Wider than the message, it scrolls sideways inside
 * the message, never the page, and fades towards an edge that hides columns, as every table of
 * the library does: at 390 px a table of five columns keeps each column within reach. The copy
 * menu stands over it.
 */
export function MarkdownTable({
  children,
  className,
  node: _node,
  ...props
}: JSX.IntrinsicElements["table"] & ExtraProps) {
  return (
    // The copy menu finds the table it copies through this wrapper.
    <div data-streamdown="table-wrapper" className="my-4 flex min-w-0 flex-col gap-2">
      <div className="flex justify-end">
        <TableCopyDropdown />
      </div>
      <div className="overflow-hidden rounded-md border bg-background">
        {/* The table is as wide as its content wants, up to 16rem a cell, and at least the
            message's width: short values stay on one line, a long one wraps between words, and
            where it is wider than the message the cut falls inside a column, where the fade
            shows it. */}
        <Table
          data-streamdown="table"
          className={cn(
            "w-max min-w-full divide-y divide-border break-normal [&_td]:max-w-64 [&_th]:max-w-64",
            className
          )}
          {...props}
        >
          {children}
        </Table>
      </div>
    </div>
  );
}
