import { useId, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

/** A run of characters of one line and the colour it is drawn in. */
export interface CodeToken {
  text: string;
  /** Any CSS colour, for the light theme. Without one the run takes the text colour. */
  color?: string;
  /** The colour for the dark theme. Without one the run keeps `color`. */
  darkColor?: string;
  italic?: boolean;
  bold?: boolean;
}

export interface CodeBlockProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** The text to show, as it is stored. It is shown as text and never run or reformatted. */
  code: string;
  /**
   * The colours of the text, one list of runs per line, from whatever reads the language. They
   * change no character: a line whose runs do not spell that line is drawn without them. The
   * block draws plain text until they arrive.
   */
  tokens?: readonly (readonly CodeToken[])[];
  /**
   * Breaks a long line inside the block instead of scrolling sideways. The number of a line
   * stands beside its first row.
   */
  wrap?: boolean;
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

/**
 * The width of the number column by the digits of the last line number, up to five. The gap
 * between a number and its line is part of the column, so a line scrolled sideways shows
 * nowhere left of its start.
 */
const GUTTER_WIDTHS = ["before:w-12", "before:w-14", "before:w-16", "before:w-18", "before:w-20"];

/** The room a wrapped line leaves for the number column. */
const WRAPPED_INSETS = ["pl-12", "pl-14", "pl-16", "pl-18", "pl-20"];

const NUMBER =
  "before:pr-6 before:text-right before:text-muted-foreground before:content-[counter(code-line)] before:select-none before:[counter-increment:code-line]";
/** The number scrolls with the lines and stays at the left edge while they scroll sideways. */
const NUMBER_SCROLLING =
  "block pr-4 before:sticky before:left-0 before:inline-block before:bg-card";
/** The number stands in the inset of its line, beside the first row the line breaks into. */
const NUMBER_WRAPPED = "relative block pr-4 before:absolute before:top-0 before:left-0";

/** A line as it is copied: with the line break it ends on. */
const lineWithBreak = (line: string) => `${line}\n`;

/** The runs of a line, or the line itself where there are none or they spell something else. */
function lineContent(line: string, tokens: readonly CodeToken[] | undefined): ReactNode {
  if (!tokens || tokens.map((token) => token.text).join("") !== line) {
    return lineWithBreak(line);
  }
  return [
    ...tokens.map((token, index) =>
      token.color === undefined && !token.italic && !token.bold ? (
        token.text
      ) : (
        <span
          key={index}
          className={cn(
            token.color !== undefined && "text-(color:--code-token)",
            token.darkColor !== undefined && "dark:text-(color:--code-token-dark)",
            token.italic && "italic",
            token.bold && "font-semibold"
          )}
          style={tokenColors(token)}
        >
          {token.text}
        </span>
      )
    ),
    "\n"
  ];
}

function tokenColors(token: CodeToken): CSSProperties | undefined {
  if (token.color === undefined) {
    return undefined;
  }
  const colors: Record<string, string> = { "--code-token": token.color };
  if (token.darkColor !== undefined) {
    colors["--code-token-dark"] = token.darkColor;
  }
  return colors;
}

/**
 * Text of a file, read-only: monospaced, one line per line, scrolling in both directions
 * inside its own box, or with long lines broken where `wrap` is set. The line numbers are
 * drawn, not written, so a selection copies the text alone. The block reads no language
 * itself; the colours of a language come in as `tokens`.
 */
export function CodeBlock({
  className,
  code,
  tokens,
  wrap = false,
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
      <pre
        className={cn(
          "py-2 [counter-reset:code-line]",
          wrap ? "w-full wrap-anywhere whitespace-pre-wrap" : "w-max min-w-full"
        )}
      >
        <code className="block">
          {shown.map((line, index) => (
            <span
              key={index}
              data-line={index + 1}
              className={
                lineNumbers
                  ? cn(
                      wrap ? NUMBER_WRAPPED : NUMBER_SCROLLING,
                      NUMBER,
                      GUTTER_WIDTHS[digits - 1],
                      wrap && WRAPPED_INSETS[digits - 1]
                    )
                  : "block px-4"
              }
            >
              {lineContent(line, tokens?.[index])}
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
