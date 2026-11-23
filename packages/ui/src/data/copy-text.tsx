import type { HTMLAttributes } from "react";
import { cn } from "../cn";
import { CopyButton } from "./copy-button";

export interface CopyTextProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /**
   * The text as it is shown and copied: every character and line break as given. It is shown
   * as text and never read as Markdown or HTML.
   */
  text: string;
  /** A few words on what the text is, such as "Reply to the supplier". */
  label?: string;
  /**
   * The text is still being written. The button that copies it waits until it is whole, so
   * nobody pastes half a text.
   */
  pending?: boolean;
}

/**
 * A text somebody takes elsewhere: a message, a clause, a summary for a colleague. It reads as
 * text, not as code: in the font of the text around it, a long line broken inside the box, each line break
 * kept. One button copies exactly the text.
 */
export function CopyText({ className, text, label, pending = false, ...props }: CopyTextProps) {
  return (
    <div
      data-slot="copy-text"
      role="group"
      aria-label={label}
      className={cn(
        "flex min-w-0 items-start gap-1 rounded-md border bg-card py-1 pr-1",
        className
      )}
      {...props}
    >
      <div className="grid min-w-0 flex-1 gap-1 py-2 pl-4">
        {label === undefined ? null : (
          <span
            data-slot="copy-text-label"
            className="truncate text-caption font-medium text-muted-foreground"
          >
            {label}
          </span>
        )}
        <div
          data-slot="copy-text-body"
          className="text-body leading-6 wrap-anywhere whitespace-pre-wrap text-card-foreground"
        >
          {text}
        </div>
      </div>
      {pending ? (
        // Keeps the text's width while it is written, so the button arriving moves no line.
        <span aria-hidden="true" className="size-7 shrink-0" />
      ) : (
        <CopyButton value={text} component="CopyText" className="shrink-0" />
      )}
    </div>
  );
}
