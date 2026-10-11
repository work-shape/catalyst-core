import type { HTMLAttributes } from "react";
import { cn } from "../cn";

export interface CodeBlockProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** The text to show, as it is stored. It is shown as text and never run or highlighted. */
  code: string;
  /** Names the block for someone who does not see it, such as the path of the file. */
  label: string;
}

/** The width of the number column by the digits of the last line number, up to five. */
const GUTTER_WIDTHS = ["before:w-8", "before:w-10", "before:w-12", "before:w-14", "before:w-16"];

/**
 * Text of a file, read-only: monospaced, one numbered line per line, scrolling in both
 * directions inside its own box. The numbers are drawn, not written, so a selection copies
 * the text alone.
 */
export function CodeBlock({ className, code, label, ...props }: CodeBlockProps) {
  const lines = code.split(/\r?\n/u);
  // A file that ends with a line break has no line after it.
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  const digits = Math.min(String(lines.length).length, GUTTER_WIDTHS.length);
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      data-slot="code-block"
      className={cn(
        "min-h-0 min-w-0 overflow-auto rounded-md border bg-card font-mono text-code text-foreground outline-none [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      data-digits={digits}
      {...props}
    >
      <pre className="w-max min-w-full py-2 [counter-reset:code-line]">
        <code className="block">
          {lines.map((line, index) => (
            <span
              key={index}
              data-line={index + 1}
              className={cn(
                "block pr-4 before:sticky before:left-0 before:mr-4 before:inline-block before:bg-card before:pr-2 before:text-right before:text-muted-foreground before:content-[counter(code-line)] before:select-none before:[counter-increment:code-line]",
                GUTTER_WIDTHS[digits - 1]
              )}
            >
              {`${line}\n`}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
