import { ChevronLeft, ChevronRight } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { IconButton } from "../actions/icon-button";
import { cn } from "../cn";
import { Select } from "../forms/select";

/** The words of the control. The caller gives them in the reader's language. */
export interface PaginationLabels {
  /** Before the rows-per-page select: "Rows". */
  rows: string;
  /** Names the rows-per-page select: "Rows per page". */
  rowsPerPage: string;
  previous: string;
  next: string;
}

export interface PaginationProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** The open page, from 1. */
  page: number;
  pageCount: number;
  onPageChange(page: number): void;
  /** Which rows the page shows: "1-10 of 42". */
  range: ReactNode;
  /** With `onRowsPerPageChange`, shows the select that sets how many rows a page holds. */
  rowsPerPage?: number;
  rowsPerPageOptions?: readonly number[];
  onRowsPerPageChange?(rowsPerPage: number): void;
  labels: PaginationLabels;
}

const defaultRowsPerPageOptions: readonly number[] = [10, 25, 50];

/**
 * The foot of a paged list or table: which rows show, how many a page holds, and the step to
 * the page before and after.
 */
export function Pagination({
  className,
  page,
  pageCount,
  onPageChange,
  range,
  rowsPerPage,
  rowsPerPageOptions = defaultRowsPerPageOptions,
  onRowsPerPageChange,
  labels,
  ...props
}: PaginationProps) {
  return (
    <div
      className={cn("flex min-w-0 flex-wrap items-center justify-between gap-3", className)}
      {...props}
    >
      <div className="text-body text-muted-foreground">{range}</div>
      <div className="flex items-center gap-2">
        {rowsPerPage !== undefined && onRowsPerPageChange ? (
          <label className="flex items-center gap-2 text-body text-muted-foreground">
            {labels.rows}
            <Select
              size="sm"
              className="w-20"
              aria-label={labels.rowsPerPage}
              value={String(rowsPerPage)}
              onChange={(event) => onRowsPerPageChange(Number(event.currentTarget.value))}
            >
              {rowsPerPageOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <IconButton
          variant="outline"
          label={labels.previous}
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          <ChevronLeft aria-hidden="true" />
        </IconButton>
        <span aria-current="page" className="min-w-7 text-center text-label text-foreground">
          {page}
        </span>
        <IconButton
          variant="outline"
          label={labels.next}
          disabled={page >= pageCount}
          onClick={() => onPageChange(Math.min(pageCount, page + 1))}
        >
          <ChevronRight aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  );
}
