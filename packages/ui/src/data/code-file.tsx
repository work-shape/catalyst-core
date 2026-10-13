import { useId, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { Switch } from "../forms/switch";
import { useUiLabels } from "../ui-root";
import { CodeBlock, type CodeToken } from "./code-block";
import { CopyButton } from "./copy-button";

export interface CodeFileProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** The path of the file. It heads the view and names the text for a screen reader. */
  name: string;
  /** The text of the file as it is stored. The copy button copies exactly this. */
  code: string;
  /** The colours of the text, as `CodeBlock` takes them. */
  tokens?: readonly (readonly CodeToken[])[];
  /** Whether long lines break. The caller keeps it, so it can outlast the view. */
  wrap: boolean;
  onWrapChange(wrap: boolean): void;
  /** Stands before the name, such as the way back to a list of files. */
  leading?: ReactNode;
  /** One quiet remark beside the name, such as why the text shows without colours. */
  note?: ReactNode;
}

/**
 * One stored file, read-only, filling the height it is given: a header with the file's name,
 * a switch that breaks long lines and a button that copies the file, over the text itself.
 */
export function CodeFile({
  className,
  name,
  code,
  tokens,
  wrap,
  onWrapChange,
  leading,
  note,
  ...props
}: CodeFileProps) {
  const labels = useUiLabels("CodeFile");
  const wrapId = useId();
  return (
    <div
      data-slot="code-file"
      className={cn("flex min-h-0 min-w-0 flex-col", className)}
      {...props}
    >
      <div className="flex min-h-control-md shrink-0 items-center gap-2 border-b bg-card px-2 py-1">
        {leading}
        <span className="min-w-0 flex-1 truncate px-2 font-mono text-caption text-muted-foreground">
          {name}
        </span>
        {note === undefined ? null : (
          <span
            data-slot="code-file-note"
            className="min-w-0 truncate text-caption text-muted-foreground"
          >
            {note}
          </span>
        )}
        <label
          htmlFor={wrapId}
          className="shrink-0 cursor-pointer text-caption text-muted-foreground"
        >
          {labels.wrapLines}
        </label>
        <Switch id={wrapId} checked={wrap} onCheckedChange={onWrapChange} />
        <CopyButton value={code} component="CodeFile" className="shrink-0" />
      </div>
      <CodeBlock
        className="min-h-0 flex-1 rounded-none border-0"
        label={name}
        code={code}
        tokens={tokens}
        wrap={wrap}
      />
    </div>
  );
}
