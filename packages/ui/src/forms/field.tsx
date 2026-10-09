import { useId, useMemo, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";
import { FieldControlContext } from "./field-control";

export type FieldLayout = "stacked" | "inline";

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  label: ReactNode;
  /** One line under the control that says what to enter. */
  hint?: ReactNode;
  /** What is wrong with the value. It takes the hint's place and is announced. */
  error?: ReactNode;
  /** Marks the field and its control as required. */
  required?: boolean;
  /** Says beside the label that the field may stay empty. */
  optional?: boolean;
  /** `inline` puts the control beside the label, as a row with a switch has it. */
  layout?: FieldLayout;
  /** The one control of this field: Input, Textarea, Select, Switch or Checkbox. */
  children: ReactNode;
}

/**
 * A control with its label and its hint or error. The library's controls inside it take the
 * label, the message and the required and invalid states by themselves.
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  optional = false,
  layout = "stacked",
  className,
  children,
  ...props
}: FieldProps) {
  const labels = useUiLabels("Field");
  const id = useId();
  const messageId = useId();
  const hasError = isShown(error);
  const hasMessage = hasError || isShown(hint);
  const control = useMemo(
    () => ({ id, messageId: hasMessage ? messageId : undefined, invalid: hasError, required }),
    [id, messageId, hasMessage, hasError, required]
  );

  const labelElement = (
    <label htmlFor={id} className="flex min-w-0 items-baseline gap-1.5 text-label">
      <span className="min-w-0">{label}</span>
      {required ? (
        <>
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
          <span className="sr-only">{labels.required}</span>
        </>
      ) : null}
      {optional ? (
        <span className="text-caption font-normal text-muted-foreground">{labels.optional}</span>
      ) : null}
    </label>
  );
  const message = hasError ? (
    <p id={messageId} role="alert" className="text-caption text-destructive">
      {error}
    </p>
  ) : hasMessage ? (
    <p id={messageId} className="text-caption text-muted-foreground">
      {hint}
    </p>
  ) : null;

  return (
    <FieldControlContext value={control}>
      {layout === "inline" ? (
        <div className={cn("flex items-start justify-between gap-4", className)} {...props}>
          <div className="grid min-w-0 gap-1">
            {labelElement}
            {message}
          </div>
          <div className="flex shrink-0 items-center">{children}</div>
        </div>
      ) : (
        <div className={cn("grid content-start gap-1.5", className)} {...props}>
          {labelElement}
          {children}
          {message}
        </div>
      )}
    </FieldControlContext>
  );
}

function isShown(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== "";
}
