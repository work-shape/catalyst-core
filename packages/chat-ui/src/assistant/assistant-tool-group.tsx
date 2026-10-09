import type { ComponentProps, ReactNode } from "react";
import {
  cn,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  type DisclosureProps
} from "@vivd-catalyst/ui";

/**
 * The chat's fold for a run of tool calls. It is the library's Disclosure with the class names
 * the chat stylesheet animates.
 */
export function ToolGroupRoot({ className, variant = "outline", ...props }: DisclosureProps) {
  return (
    <Disclosure
      data-slot="tool-group-root"
      variant={variant}
      className={cn("aui-tool-group-root", className)}
      {...props}
    />
  );
}

// Tool groups are a record of what happened, never a progress indicator.
// Live progress belongs to the thread's single activity row.
export function ToolGroupTrigger({
  children,
  className,
  count,
  label,
  ...props
}: ComponentProps<typeof DisclosureTrigger> & {
  count: number;
  label?: ReactNode;
}) {
  const resolvedLabel = label ?? `${count} tool ${count === 1 ? "call" : "calls"}`;

  return (
    <DisclosureTrigger
      data-slot="tool-group-trigger"
      className={cn("aui-tool-group-trigger leading-none", className)}
      {...props}
    >
      {resolvedLabel}
      {children}
    </DisclosureTrigger>
  );
}

export function ToolGroupContent({
  className,
  ...props
}: ComponentProps<typeof DisclosureContent>) {
  return (
    <DisclosureContent
      data-slot="tool-group-content"
      className={cn("aui-tool-group-content outline-none", className)}
      {...props}
    />
  );
}
