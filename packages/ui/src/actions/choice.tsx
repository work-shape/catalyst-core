import { Check } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";

export interface ChoiceProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  /** The answer in a few words. It wraps; nothing of it is cut. */
  title: ReactNode;
  /** One short line under the title, such as what the answer means. It wraps too. */
  hint?: ReactNode;
  /** A mark beside the title, such as a badge "Recommended". */
  mark?: ReactNode;
  /** This answer is the one given: it shows a check and the selected state. */
  chosen?: boolean;
}

/**
 * One answer to a question, as a button the width of its list: choosing it gives the answer at
 * once. The caller decides what choosing it does.
 */
export const Choice = forwardRef<HTMLButtonElement, ChoiceProps>(function Choice(
  { title, hint, mark, chosen = false, className, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      {...props}
      type={props.type ?? "button"}
      aria-pressed={chosen}
      data-chosen={chosen ? "" : undefined}
      className={cn(
        "flex w-full min-w-0 items-center gap-3 rounded-md border border-input bg-card px-3 py-2.5 text-left transition-colors hover:border-input-strong hover:bg-state-hover focus-visible:focus-ring active:bg-state-pressed disabled:pointer-events-none",
        chosen ? "border-ring bg-state-selected" : "disabled:opacity-50",
        className
      )}
    >
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 text-label wrap-anywhere">{title}</span>
          {mark}
        </span>
        {hint === undefined ? null : (
          <span className="text-caption text-muted-foreground">{hint}</span>
        )}
      </span>
      {chosen ? <Check className="size-4 shrink-0 text-foreground" aria-hidden="true" /> : null}
    </button>
  );
});

export interface ChoiceListProps {
  /** The question the answers are for. It names the group for assistive technology. */
  label: string;
  children: ReactNode;
  className?: string;
}

/** The answers to one question, one under the other. */
export function ChoiceList({ label, children, className }: ChoiceListProps) {
  return (
    <div role="group" aria-label={label} className={cn("grid min-w-0 gap-2", className)}>
      {children}
    </div>
  );
}
