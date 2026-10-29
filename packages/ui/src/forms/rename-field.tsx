import { useEffect, useId, useRef, useState, type FocusEvent } from "react";
import { cn } from "../cn";
import { Input } from "./input";

/** The type of the name the field stands in for: a page's head or a card's. */
export type RenameFieldSize = "title" | "title-sm";

export interface RenameFieldProps {
  /** The name as it stands. The field opens with it, selected. */
  value: string;
  /** Names the field for whoever does not see it. */
  label: string;
  maxLength?: number;
  size?: RenameFieldSize;
  /** The save is under way: the field waits. */
  saving?: boolean;
  /** Why the last save failed. The field stays open with the name as typed. */
  error?: string;
  /** Saves a name that differs from `value`. An unchanged or empty name cancels instead. */
  onSave(name: string): void;
  onCancel(): void;
  className?: string;
}

/**
 * A name edited where it is read: the field takes the place of the name, opens with it selected,
 * saves with Enter or by leaving the field, and Escape leaves the name as it was.
 */
export function RenameField({
  value,
  label,
  maxLength,
  size = "title",
  saving = false,
  error,
  onSave,
  onCancel,
  className
}: RenameFieldProps) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();

  // The field takes the focus once it stands, also where a menu that opened it closes first.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const finish = () => {
    if (saving) return;
    const name = draft.trim();
    if (name === "" || name === value) {
      onCancel();
      return;
    }
    onSave(name);
  };

  return (
    <form
      className={cn("grid min-w-0 gap-1", className)}
      data-slot="rename-field"
      onSubmit={(event) => {
        event.preventDefault();
        finish();
      }}
      onBlur={(event: FocusEvent<HTMLFormElement>) => {
        // Leaving the field saves; a failed save keeps it open, so leaving it again cancels.
        if (event.currentTarget.contains(event.relatedTarget) || saving) return;
        if (error === undefined) finish();
        else onCancel();
      }}
    >
      <Input
        ref={input}
        size={size === "title" ? "md" : "sm"}
        className={size === "title" ? "text-title" : "text-title-sm"}
        value={draft}
        maxLength={maxLength}
        disabled={saving}
        aria-label={label}
        invalid={error !== undefined}
        aria-describedby={error === undefined ? undefined : errorId}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      {error === undefined ? null : (
        <p id={errorId} role="alert" className="text-caption text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
