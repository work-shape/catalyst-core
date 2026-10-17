import { useId, type HTMLAttributes } from "react";
import { cn } from "../cn";

export interface ProposedValueProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** What the value is, such as "Proposed by the agent" or "Published". It names the group. */
  label: string;
}

/**
 * The other value of the field above it: what somebody proposes while the field shows the live
 * value, or what is published while the field shows a draft. This box under the field, in the
 * accent's tint with its label first, shows it. Taking or dropping a change is the page's, not
 * the field's.
 */
export function ProposedValue({ label, className, children, ...props }: ProposedValueProps) {
  const labelId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      data-proposed-value=""
      className={cn(
        "grid min-w-0 gap-1 rounded-md border border-primary-border bg-primary-soft px-3 py-2",
        className
      )}
      {...props}
    >
      <span id={labelId} className="text-caption font-medium text-primary-soft-foreground">
        {label}
      </span>
      <div className="min-w-0 text-body break-words text-foreground">{children}</div>
    </div>
  );
}
