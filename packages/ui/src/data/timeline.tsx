import type { HTMLAttributes } from "react";
import { cn } from "../cn";
import type { StepTone } from "./steps";

/** One row of a `Timeline`: something that ran from one moment to another. */
export interface TimelineRow {
  id: string;
  label: string;
  /** How far the row is set in: a part of something one deeper than that thing. */
  depth?: number;
  /**
   * Where the bar starts and ends, in the unit of the timeline's `from` and `to`. A row without
   * a start has no bar; one without an end runs to `at`, or to `to`.
   */
  start?: number;
  end?: number;
  tone?: StepTone;
  /** At the end of the row, such as how long it took. */
  meta?: string;
  /** What the bar says in words, for someone who does not see it. */
  description?: string;
}

export interface TimelineProps extends Omit<
  HTMLAttributes<HTMLOListElement>,
  "aria-label" | "onSelect"
> {
  /** Names the timeline for someone who does not see it. */
  label: string;
  rows: readonly TimelineRow[];
  /** The first and the last moment of the axis. */
  from: number;
  to: number;
  /** A moment marked across every row, such as the one a replay stands at. */
  at?: number;
  selectedId?: string;
  /** With it a row's name is a button that selects the row. */
  onSelect?(id: string): void;
}

const bars: Record<StepTone, string> = {
  neutral: "bg-input-strong",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive"
};

/**
 * Bars on one time axis, one row each, so that what ran at the same time stands one above the
 * other and a long bar shows where the time went. Rows nest by `depth`.
 */
export function Timeline({
  label,
  rows,
  from,
  to,
  at,
  selectedId,
  onSelect,
  className,
  ...props
}: TimelineProps) {
  const length = Math.max(1, to - from);
  const share = (moment: number) => Math.min(100, Math.max(0, ((moment - from) / length) * 100));
  return (
    <ol
      // A list without markers of its own is announced as a list only when it says so.
      role="list"
      aria-label={label}
      data-slot="timeline"
      className={cn(
        "grid grid-cols-[minmax(5rem,min(13rem,34%))_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-caption",
        className
      )}
      {...props}
    >
      {rows.map((row) => {
        const start = row.start;
        const end = row.end ?? at ?? to;
        const left = start === undefined ? 0 : share(start);
        const width = start === undefined ? 0 : Math.max(0, share(end) - left);
        const selected = row.id === selectedId;
        const name = (
          <span
            className="truncate"
            style={{ paddingInlineStart: `${(row.depth ?? 0) * 0.875}rem` }}
          >
            {row.label}
          </span>
        );
        return (
          <li
            key={row.id}
            data-slot="timeline-row"
            data-row-id={row.id}
            data-selected={selected ? "" : undefined}
            className="col-span-3 grid grid-cols-subgrid items-center"
          >
            {onSelect === undefined ? (
              <span className="flex min-w-0 text-foreground">{name}</span>
            ) : (
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "-mx-1.5 flex min-w-0 rounded-md px-1.5 py-0.5 text-left text-foreground hover:bg-state-hover focus-visible:focus-ring",
                  selected && "bg-state-pressed font-medium"
                )}
                onClick={() => onSelect(row.id)}
              >
                {name}
              </button>
            )}
            <span className="relative h-4 rounded-sm bg-muted">
              {start === undefined ? null : (
                <span
                  data-slot="timeline-bar"
                  className={cn(
                    "absolute inset-y-0.5 min-w-0.5 rounded-xs",
                    bars[row.tone ?? "neutral"],
                    row.end === undefined && "opacity-70"
                  )}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              )}
              {at === undefined ? null : (
                <span
                  aria-hidden="true"
                  data-slot="timeline-cursor"
                  className="absolute -inset-y-0.5 w-px bg-foreground"
                  style={{ left: `${share(at)}%` }}
                />
              )}
              {row.description === undefined ? null : (
                <span className="sr-only">{row.description}</span>
              )}
            </span>
            <span className="text-right whitespace-nowrap text-muted-foreground tabular-nums">
              {row.meta}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
