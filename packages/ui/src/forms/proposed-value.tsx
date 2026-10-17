import { useId, type HTMLAttributes } from "react";
import { cn } from "../cn";

export interface ProposedValueProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Who proposes the value, such as "Proposed by the agent". It names the group. */
  label: string;
}

/**
 * The value somebody proposes for the field above it. The field keeps showing the live value,
 * and this box under it, in the accent's tint with its label first, shows what the proposal
 * would make it. Taking or dropping the proposal is the page's, not the field's.
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
