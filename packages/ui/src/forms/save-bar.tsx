import { Check } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";

/** `sticky` keeps the bar at the bottom edge of the scrolling page, on the raised surface. */
export type SaveBarMode = "inline" | "sticky";

export interface SaveBarProps extends HTMLAttributes<HTMLDivElement> {
  /** The text of the save button. */
  label: string;
  mode?: SaveBarMode;
  /** A save is under way: the button shows a spinner and cannot be pressed. */
  saving?: boolean;
  disabled?: boolean;
  /** True after a successful save, until the form changes again. Shows `savedLabel`. */
  saved?: boolean;
  savedLabel?: string;
  /** One line beside the buttons while nothing was saved, such as when a change applies. */
  hint?: ReactNode;
  /** A second action beside the save button, such as discarding the changes. */
  secondaryAction?: ReactNode;
  /** Without it the button submits the form it sits in. */
  onSave?(): void;
}

/** The save row of a form: the save button, an optional second action, and what was saved. */
export function SaveBar({
  className,
  label,
  mode = "inline",
  saving = false,
  disabled = false,
  saved = false,
  savedLabel,
  hint,
  secondaryAction,
  onSave,
  ...props
}: SaveBarProps) {
  return (
    <div
      data-mode={mode}
      className={cn(
        "flex flex-wrap items-center gap-3 py-4",
        mode === "sticky" &&
          "sticky bottom-0 z-(--layer-sticky-header) border-t bg-popover px-(--layout-gutter) py-3 text-popover-foreground shadow-raised",
        className
      )}
      {...props}
    >
      <Button
        type={onSave ? "button" : "submit"}
        className="w-full sm:w-auto"
        loading={saving}
        disabled={disabled}
        onClick={onSave}
      >
        {label}
      </Button>
      {secondaryAction}
      {saved && !saving && savedLabel !== undefined ? (
        <span role="status" className="inline-flex items-center gap-1.5 text-label text-success">
          <Check aria-hidden="true" className="size-4" />
          {savedLabel}
        </span>
      ) : hint === undefined ? null : (
        <span className="text-caption text-muted-foreground">{hint}</span>
      )}
    </div>
  );
}
