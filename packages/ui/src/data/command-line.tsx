import type { HTMLAttributes } from "react";
import { cn } from "../cn";
import { CodeBlock } from "./code-block";
import { CopyButton } from "./copy-button";

export interface CommandLineProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** The command as it is shown and copied. */
  command: string;
  /** Names the command for someone who does not see it, such as "Command for Codex". */
  label: string;
}

/**
 * One command to run in a terminal, read-only, with a button that copies it. A long command
 * breaks inside the box instead of scrolling, so all of it shows before it is copied.
 */
export function CommandLine({ className, command, label, ...props }: CommandLineProps) {
  return (
    <div
      data-slot="command-line"
      className={cn("flex min-w-0 items-start gap-1 rounded-md border bg-card pr-1", className)}
      {...props}
    >
      <CodeBlock
        className="min-w-0 flex-1 rounded-none border-0 bg-transparent"
        label={label}
        code={command}
        lineNumbers={false}
        wrap
      />
      <CopyButton value={command} component="CommandLine" className="mt-1 shrink-0" />
    </div>
  );
}
