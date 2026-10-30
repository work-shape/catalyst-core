import { useState, type HTMLAttributes, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../cn";
import { Popover, PopoverContent, PopoverTrigger } from "../overlays/popover";

/** `draft`: a version that is not live yet. `live`: what everyone gets, said quietly. */
export type StatusPillTone = "draft" | "live";

const tones: Record<StatusPillTone, string> = {
  draft: "border-warning-border bg-warning-soft text-warning-soft-foreground",
  live: "border-transparent text-muted-foreground"
};

const dots: Record<StatusPillTone, string> = {
  draft: "bg-current",
  live: "bg-success"
};

export interface StatusPillProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  tone: StatusPillTone;
  /** The state in a few words, such as "Draft · not live". */
  label: string;
  /**
   * What the pill says when it is pressed: a sentence or two and an action, in a small popover.
   * As a function it is handed what closes the popover, for an action that leads elsewhere on
   * the page. Without it the pill is plain text.
   */
  details?: ReactNode | ((close: () => void) => ReactNode);
}

/**
 * The one state of an object beside its name, as a page head shows it: a draft that is not
 * live in the warning tint, or "Live" quietly. With `details` it is a button that opens them,
 * so the head says the state once and the sentence about it stays one press away.
 */
export function StatusPill({ tone, label, details, className, ...props }: StatusPillProps) {
  const [open, setOpen] = useState(false);
  const look = cn(
    "inline-flex h-6 w-fit shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-caption font-medium whitespace-nowrap",
    tones[tone],
    className
  );
  const dot = <span aria-hidden="true" className={cn("size-1.5 rounded-full", dots[tone])} />;
  if (details === undefined || details === null) {
    return (
      <span data-status-pill={tone} className={look} {...props}>
        {dot}
        {label}
      </span>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        data-status-pill={tone}
        className={cn(
          look,
          "transition-colors focus-visible:focus-ring",
          tone === "live"
            ? "hover:bg-state-hover data-[state=open]:bg-state-pressed"
            : "hover:border-current data-[state=open]:border-current"
        )}
        {...props}
      >
        {dot}
        {label}
        <ChevronDown aria-hidden="true" className="-me-0.5 size-3 stroke-2" />
      </PopoverTrigger>
      <PopoverContent size="md" className="grid gap-3 text-body" data-status-pill-details="">
        {typeof details === "function" ? details(() => setOpen(false)) : details}
      </PopoverContent>
    </Popover>
  );
}
