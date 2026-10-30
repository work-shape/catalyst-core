import type { HTMLAttributes } from "react";
import { cn } from "../cn";
import type { UiLabels } from "../labels";
import { useUiLabels } from "../ui-root";

/** How a part of a draft differs from what is live, or from what was saved. */
export type ChangeKind = "new" | "changed" | "removed" | "unsaved";

const changeLabels: Record<ChangeKind, keyof UiLabels> = {
  new: "changeNew",
  changed: "changeChanged",
  removed: "changeRemoved",
  unsaved: "changeUnsaved"
};

export interface ChangeTagProps extends HTMLAttributes<HTMLSpanElement> {
  change: ChangeKind;
}

/**
 * The word that says how a part differs: New, Changed, Removed or Not saved, in the primary
 * tint, the same on a canvas node, in a list of what a publish changes and beside a file.
 */
export function ChangeTag({ change, className, ...props }: ChangeTagProps) {
  const labels = useUiLabels("ChangeTag");
  return (
    <span
      data-change-tag={change}
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded-md bg-primary-soft px-1.5 py-0.5 text-caption leading-3.5 font-medium whitespace-nowrap text-primary-soft-foreground",
        className
      )}
      {...props}
    >
      {labels[changeLabels[change]]}
    </span>
  );
}
