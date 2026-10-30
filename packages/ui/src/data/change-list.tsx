import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";
import { ChangeTag, type ChangeKind } from "../status/change-tag";

export interface ChangeListItem {
  id: string;
  /** What changes, such as an action's name, a step's name or a host. */
  label: ReactNode;
  /** How it differs from what is live. Absent: it is named without a tag. */
  change?: ChangeKind;
  /** One line under the label, such as what the part calls. */
  detail?: ReactNode;
}

export interface ChangeListProps extends HTMLAttributes<HTMLUListElement> {
  items: readonly ChangeListItem[];
  /** The label is code, such as a host or an action's name: it is set in the mono face. */
  mono?: boolean;
}

/**
 * What a draft changes against what is live, one part per line with its tag: the changing
 * actions or steps a publish makes live, the outside hosts it adds, the steps a draft changed.
 * Name the list with `aria-label` where no heading names it.
 */
export function ChangeList({ items, mono = false, className, ...props }: ChangeListProps) {
  return (
    <ul className={cn("grid gap-1.5 text-body text-foreground", className)} {...props}>
      {items.map((item) => (
        <li key={item.id} data-change-item={item.id} className="grid min-w-0 gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={cn("min-w-0 wrap-anywhere", mono && "font-mono text-code")}>
              {item.label}
            </span>
            {item.change === undefined ? null : <ChangeTag change={item.change} />}
          </span>
          {item.detail === undefined ? null : (
            <span className="text-caption text-muted-foreground">{item.detail}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
