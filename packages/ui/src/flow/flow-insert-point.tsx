import { Plus } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

export interface FlowInsertPointProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "aria-label"
> {
  /** Names the location, such as "Add a step after Load the clients" or "Move here". */
  label: string;
  target?: boolean;
}

/** A caller-placed insertion or move target on an edge, exit or container end. */
export function FlowInsertPoint({
  label,
  target = false,
  hidden = false,
  className,
  onClick,
  ...props
}: FlowInsertPointProps) {
  const labels = useUiLabels("FlowInsertPoint");
  if (hidden) return null;
  return (
    <button
      {...props}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
      aria-label={label}
      data-slot="flow-insert-point"
      data-target={target ? "" : undefined}
      className={cn(
        "nodrag nopan inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-input-strong bg-background text-muted-foreground transition-colors hover:border-primary hover:text-primary focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50",
        target &&
          "w-auto gap-1.5 border-primary bg-primary-soft px-2.5 text-caption font-medium text-primary-soft-foreground",
        className
      )}
    >
      <Plus aria-hidden="true" className="size-4" />
      {target ? labels.moveHere : null}
    </button>
  );
}
