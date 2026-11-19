import { useId, useMemo, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { FieldControlContext } from "./field-control";

export type SettingsListProps = HTMLAttributes<HTMLDivElement>;

/**
 * Settings one under the other, a line between each two. Each child is a `SettingsRow`. Name the
 * list with `aria-label` where no heading stands over it.
 */
export function SettingsList({ className, ...props }: SettingsListProps) {
  return (
    <div
      role="group"
      data-slot="settings-list"
      className={cn("grid min-w-0 divide-y", className)}
      {...props}
    />
  );
}

export interface SettingsRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  label: ReactNode;
  /** One short line under the label that says what the setting does. */
  description?: ReactNode;
  /** What is wrong with the value. It takes the description's place and is announced. */
  error?: ReactNode;
  /**
   * The control at the far end of the row: a Switch, a Select, a button. The first library
   * control takes the label; a second one beside it names itself.
   */
  children: ReactNode;
}

/**
 * One setting in one row: its label and one line about it at the start, its control at the far
 * end, on the same line, so the two read as one. Where the row is too narrow for both, the
 * control goes under the text.
 */
export function SettingsRow({
  label,
  description,
  error,
  className,
  children,
  ...props
}: SettingsRowProps) {
  const id = useId();
  const messageId = useId();
  const hasError = isShown(error);
  const hasMessage = hasError || isShown(description);
  const control = useMemo(
    () => ({
      id,
      messageId: hasMessage ? messageId : undefined,
      invalid: hasError,
      required: false
    }),
    [id, messageId, hasMessage, hasError]
  );
  return (
    <FieldControlContext value={control}>
      <div
        data-slot="settings-row"
        className={cn(
          "flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3",
          className
        )}
        {...props}
      >
        <div className="grid min-w-48 flex-1 gap-0.5">
          <label htmlFor={id} className="text-label">
            {label}
          </label>
          {hasError ? (
            <p id={messageId} role="alert" className="text-caption text-destructive">
              {error}
            </p>
          ) : hasMessage ? (
            <p id={messageId} className="text-caption text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        <div className="flex min-w-0 shrink-0 items-center gap-3">{children}</div>
      </div>
    </FieldControlContext>
  );
}

function isShown(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== "";
}
