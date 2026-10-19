import type { HTMLAttributes } from "react";
import { cn } from "../cn";

export interface TimeMarkerProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "role"> {
  /** The moment as the reader reads it, such as "Today 10:47 AM". */
  label: string;
  /** The same moment for machines: an ISO 8601 date and time. */
  dateTime: string;
}

/**
 * A moment between the items of a running list, such as where a new day begins in a
 * conversation: small, muted and centred. Screen readers meet it as a separator named by the
 * moment.
 */
export function TimeMarker({ label, dateTime, className, ...props }: TimeMarkerProps) {
  return (
    <div
      role="separator"
      aria-label={label}
      className={cn(
        "flex justify-center px-1 text-center text-caption text-muted-foreground",
        className
      )}
      {...props}
    >
      <time dateTime={dateTime}>{label}</time>
    </div>
  );
}

export interface ListMarkerProps extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "role"> {
  /** What changed between the items, such as "Now running draft revision 4". */
  label: string;
}

/**
 * A change between the items of a running list that is not a moment, such as another revision
 * answering from here on: it looks like a `TimeMarker` and is met as a separator named by it.
 */
export function ListMarker({ label, className, ...props }: ListMarkerProps) {
  return (
    <div
      role="separator"
      aria-label={label}
      className={cn(
        "flex justify-center px-1 text-center text-caption text-muted-foreground",
        className
      )}
      {...props}
    >
      {label}
    </div>
  );
}
