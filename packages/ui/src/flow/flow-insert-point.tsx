import { Plus } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

export interface FlowInsertPointProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "aria-label"
> {
  /**
   * The place in words. A "+" is named by it alone: "Add a step after Load the clients". A
   * target says "Move here" and then this: "after Load the clients".
   */
  label: string;
  /** A "Move here" target, as the canvas shows while a part moves. */
  target?: boolean;
  /** Seen only while the pointer is over the canvas or the point has the focus. */
  reveal?: boolean;
}

/** A place on an edge, an exit or a container's end where a part can be put or moved to. */
export function FlowInsertPoint({
  label,
  target = false,
  reveal = false,
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
      // A target's name starts with the words it shows.
      aria-label={target ? `${labels.moveHere}, ${label}` : label}
      data-slot="flow-insert-point"
      data-target={target ? "" : undefined}
      data-reveal={reveal && !target ? "" : undefined}
      className={cn(
        "nodrag nopan inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-input-strong bg-background text-muted-foreground transition-[color,border-color,opacity] duration-(--duration-color) focus-visible:focus-ring enabled:hover:border-primary enabled:hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
        target &&
          "w-auto gap-1.5 border-primary bg-linear-to-r from-primary-soft to-primary-soft px-2.5 text-caption font-medium whitespace-nowrap text-primary-soft-foreground",
        // A pointer that cannot hover sees every point.
        reveal &&
          !target &&
          "opacity-0 group-hover/flow:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
        className
      )}
    >
      <Plus aria-hidden="true" className="size-4" />
      {target ? labels.moveHere : null}
    </button>
  );
}
