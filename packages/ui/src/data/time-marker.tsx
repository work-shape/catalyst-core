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
