import { useId, useState, type HTMLAttributes, type ReactNode } from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

export interface CodeBlockProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** The text to show, as it is stored. It is shown as text and never run or highlighted. */
  code: string;
  /** Names the block for someone who does not see it, such as the path of the file. */
  label: string;
  /** Numbers the lines. A preview of data, which nobody cites by line, turns them off. */
  lineNumbers?: boolean;
  /**
   * The lines a longer text is cut to. A button under the block shows the rest and cuts it
   * again; a text that fits shows no button.
   */
  maxLines?: number;
  /** One line under the block, such as why the text ends where it does. */
  footer?: ReactNode;
}

/** The width of the number column by the digits of the last line number, up to five. */
const GUTTER_WIDTHS = ["before:w-8", "before:w-10", "before:w-12", "before:w-14", "before:w-16"];

/** A line as it is copied: with the line break it ends on. */
const lineWithBreak = (line: string) => `${line}\n`;

/**
 * Text of a file, read-only: monospaced, one line per line, scrolling in both directions
 * inside its own box. The line numbers are drawn, not written, so a selection copies the text
 * alone.
 */
export function CodeBlock({
  className,
  code,
  label,
  lineNumbers = true,
  maxLines,
  footer,
  ...props
}: CodeBlockProps) {
  const ownId = useId();
  const blockId = props.id ?? ownId;
  const [whole, setWhole] = useState(false);
  const lines = code.split(/\r?\n/u);
  // A file that ends with a line break has no line after it.
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  const cuts = maxLines !== undefined && lines.length > maxLines;
  const shown = cuts && !whole ? lines.slice(0, maxLines) : lines;
  // The gutter fits the last number of the whole text, so showing the rest moves no line.
  const digits = Math.min(String(lines.length).length, GUTTER_WIDTHS.length);
  const block = (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      data-slot="code-block"
      className={cn(
        "min-h-0 min-w-0 overflow-auto rounded-md border bg-card font-mono text-code text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      data-digits={lineNumbers ? digits : undefined}
      {...props}
      id={cuts ? blockId : props.id}
    >
      <pre className="w-max min-w-full py-2 [counter-reset:code-line]">
        <code className="block">
          {shown.map((line, index) => (
            <span
              key={index}
              data-line={index + 1}
              className={
                lineNumbers
                  ? cn(
                      "block pr-4 before:sticky before:left-0 before:mr-4 before:inline-block before:bg-card before:pr-2 before:text-right before:text-muted-foreground before:content-[counter(code-line)] before:select-none before:[counter-increment:code-line]",
                      GUTTER_WIDTHS[digits - 1]
                    )
                  : "block px-4"
              }
            >
              {lineWithBreak(line)}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
  if (!cuts && footer === undefined) {
    return block;
  }
  return (
    <div data-slot="code-block-frame" className="grid w-full min-w-0 gap-1.5">
      {block}
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-caption text-muted-foreground">
        {footer === undefined ? null : (
          <p data-slot="code-block-footer" className="min-w-0 flex-1">
            {footer}
          </p>
        )}
        {cuts ? (
          <CutToggle whole={whole} controls={blockId} onToggle={() => setWhole(!whole)} />
        ) : null}
      </div>
    </div>
  );
}

function CutToggle({
  whole,
  controls,
  onToggle
}: {
  whole: boolean;
  controls: string;
  onToggle(): void;
}) {
  const labels = useUiLabels("CodeBlock");
  return (
    <Button
      variant="link"
      className="ml-auto h-auto shrink-0 p-0 text-caption"
      aria-expanded={whole}
      aria-controls={controls}
      onClick={onToggle}
    >
      {whole ? labels.showLess : labels.showMore}
    </Button>
  );
}
