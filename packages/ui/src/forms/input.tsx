import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes
} from "react";
import { cn } from "../cn";

export type FieldSize = "sm" | "md";

/** The frame shared by Input, Textarea and Select: one line at rest, the focus line in its place. */
export const fieldFrameClassName =
  "w-full min-w-0 rounded-md border border-input bg-background text-body text-foreground transition-colors focus-visible:focus-field disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";

export const fieldHeights: Record<FieldSize, string> = {
  sm: "h-control-sm",
  md: "h-control-md"
};

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  size?: FieldSize;
  /** Marks the value as wrong: the line turns to the danger tone and assistive technology is told. */
  invalid?: boolean;
  /** An icon inside the field's leading edge, as a search field has. */
  leadingIcon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, size = "md", invalid = false, leadingIcon, ...props },
  ref
) {
  const input = (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "flex px-3 placeholder:text-muted-foreground",
        fieldFrameClassName,
        fieldHeights[size],
        leadingIcon !== undefined && "pl-9",
        className
      )}
      {...props}
    />
  );
  if (leadingIcon === undefined) {
    return input;
  }
  return (
    <span className="relative flex w-full min-w-0">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground [&_svg]:size-4"
      >
        {leadingIcon}
      </span>
      {input}
    </span>
  );
});

export type TextareaVariant = "plain" | "code";

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** `code` sets the monospaced style for instructions, identifiers and structured text. */
  variant?: TextareaVariant;
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, variant = "plain", invalid = false, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "flex min-h-16 px-3 py-2 placeholder:text-muted-foreground",
        fieldFrameClassName,
        variant === "code" && "font-mono text-code",
        className
      )}
      {...props}
    />
  );
});
