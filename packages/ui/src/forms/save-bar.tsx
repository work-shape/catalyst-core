import { Check } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";

/** `sticky` keeps the bar at the bottom edge of the scrolling page, on the raised surface. */
export type SaveBarMode = "inline" | "sticky";

/** `hidden` renders no bar while the form is clean, so it appears with the first change. */
export type SaveBarWhenClean = "shown" | "hidden";

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
  /** A second action beside the save button, where `onDiscard` does not fit. */
  secondaryAction?: ReactNode;
  /** How many changes wait, as a ready text such as "3 changes". The caller words it. */
  changes?: ReactNode;
  /** The text of the discard button. The button shows when `onDiscard` is given too. */
  discardLabel?: string;
  /** Throws the changes away. It cannot be pressed while a save is under way. */
  onDiscard?(): void;
  /** True while the form holds changes that are not saved. */
  dirty?: boolean;
  /** Whether the bar shows while the form is clean, that is neither `dirty` nor `saving`. */
  whenClean?: SaveBarWhenClean;
  /** Without it the button submits the form it sits in. */
  onSave?(): void;
}

/**
 * The save row of a form: the save button, an optional discard or second action, how many
 * changes wait, and what was saved.
 */
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
  changes,
  discardLabel,
  onDiscard,
  dirty = false,
  whenClean = "shown",
  onSave,
  ...props
}: SaveBarProps) {
  if (whenClean === "hidden" && !dirty && !saving) {
    return null;
  }
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
      {discardLabel !== undefined && onDiscard ? (
        <Button
          type="button"
          variant="ghost"
          className="w-full sm:w-auto"
          disabled={saving}
          onClick={onDiscard}
        >
          {discardLabel}
        </Button>
      ) : null}
      {secondaryAction}
      {changes === undefined ? null : (
        <span data-save-bar-changes="" className="text-label tabular-nums">
          {changes}
        </span>
      )}
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
