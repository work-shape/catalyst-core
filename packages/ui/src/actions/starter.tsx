import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";

export interface StarterProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  /** What the starter begins, in a few words. */
  title: ReactNode;
  /** One short line under the title. */
  hint?: ReactNode;
  /** The icon of what the starter draws on, such as a skill's. It repeats nothing a reader needs. */
  icon?: ReactNode;
}

/**
 * One first request a person can begin with: an icon, a title and a hint on a card that is a
 * button. The caller decides what choosing it does.
 */
export const Starter = forwardRef<HTMLButtonElement, StarterProps>(function Starter(
  { title, hint, icon, className, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      {...props}
      type={props.type ?? "button"}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:border-input-strong hover:bg-state-hover focus-visible:focus-ring active:bg-state-pressed disabled:pointer-events-none disabled:opacity-50",
        className
      )}
    >
      {icon === undefined ? null : <span className="flex shrink-0 items-center">{icon}</span>}
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-label">{title}</span>
        {hint === undefined ? null : (
          <span className="truncate text-caption text-muted-foreground">{hint}</span>
        )}
      </span>
    </button>
  );
});

export interface StarterListProps {
  /** What the starters are, for assistive technology: "Suggestions to start with". */
  label: string;
  children: ReactNode;
  className?: string;
}

/**
 * Starters side by side in two columns, one column where the room is narrow. The list's own
 * width decides, not the window's: in a dock beside a page it keeps one column at any window.
 */
export function StarterList({ label, children, className }: StarterListProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("@container/starters w-full min-w-0", className)}
    >
      <div className="grid gap-2 @[32.5rem]/starters:grid-cols-2">{children}</div>
    </div>
  );
}
